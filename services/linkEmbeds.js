// ============================================================================
//  Link preview (OpenGraph) resolution, with a database-backed cache.
//
//  Fetching is deliberately conservative: an unfurler is a request-forging
//  primitive if it will fetch anything a user pastes, so private address ranges
//  are refused, redirects are capped, and only a small HTML head is read.
// ============================================================================

import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';

import { runQuery, getQuery } from '../db.js';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 256 * 1024;   // enough for <head>, not enough to be a download

const hashUrl = (url) => crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);

/** Reject anything that is not a public http(s) host. */
async function assertPublicUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('URL ไม่ถูกต้อง'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('รองรับเฉพาะ http/https');

  const host = url.hostname;
  if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(host)) {
    throw new Error('ปฏิเสธ host ภายในเครื่อง');
  }

  // Resolve and check every address — a public name can point at a private IP.
  let addresses;
  try {
    addresses = net.isIP(host)
      ? [{ address: host }]
      : await dns.lookup(host, { all: true });
  } catch {
    throw new Error('resolve host ไม่ได้');
  }

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) throw new Error('ปฏิเสธที่อยู่ภายในเครือข่าย');
  }
  return url;
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||   // link-local, incl. cloud metadata
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const lower = ip.toLowerCase();
  return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
}

const META_PATTERNS = {
  title: [/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i,
          /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)/i,
          /<title[^>]*>([^<]+)<\/title>/i],
  description: [/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i,
                /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i],
  image: [/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i,
          /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)/i],
  siteName: [/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)/i],
  themeColor: [/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)/i]
};

function extract(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeEntities(match[1].trim()).slice(0, 400);
  }
  return null;
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
}

/**
 * Resolve one URL to an embed object, using the cache when fresh.
 * Never throws for network reasons — a failed unfurl returns null so the
 * message still renders.
 */
export async function resolveEmbed(rawUrl, { force = false } = {}) {
  const key = hashUrl(rawUrl);

  if (!force) {
    const cached = await getQuery(`SELECT * FROM link_embeds WHERE url_hash = ?`, [key]);
    if (cached && (!cached.expires_at || cached.expires_at > new Date().toISOString())) {
      try { return JSON.parse(cached.data); } catch { /* fall through and refetch */ }
    }
  }

  let embed = null;
  try {
    const url = await assertPublicUrl(rawUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // Many sites only emit OpenGraph tags for a bot-looking agent.
        'User-Agent': 'Mozilla/5.0 (compatible; AntigravityBot/1.0; +link-preview)',
        Accept: 'text/html,application/xhtml+xml'
      }
    }).finally(() => clearTimeout(timer));

    const contentType = response.headers.get('content-type') ?? '';

    if (contentType.startsWith('image/')) {
      embed = { type: 'image', url: rawUrl, image: rawUrl };
    } else if (contentType.includes('html')) {
      // Read at most MAX_BYTES rather than buffering an arbitrary page.
      const reader = response.body?.getReader();
      const chunks = [];
      let received = 0;
      while (reader && received < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
      }
      reader?.cancel().catch(() => {});
      const html = Buffer.concat(chunks.map(Buffer.from)).toString('utf8');

      const title = extract(html, META_PATTERNS.title);
      if (title) {
        const image = extract(html, META_PATTERNS.image);
        embed = {
          type: 'link',
          url: rawUrl,
          title,
          description: extract(html, META_PATTERNS.description),
          image: image ? new URL(image, url).href : null,
          site_name: extract(html, META_PATTERNS.siteName) ?? url.hostname,
          color: extract(html, META_PATTERNS.themeColor)
        };
      }
    }
  } catch (err) {
    // Cache the miss too, so one bad link is not refetched on every render.
    embed = null;
  }

  await runQuery(
    `INSERT INTO link_embeds (url_hash, url, data, fetched_at, expires_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)
     ON CONFLICT(url_hash) DO UPDATE SET
       data = excluded.data, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
    [key, rawUrl, JSON.stringify(embed), new Date(Date.now() + CACHE_TTL_MS).toISOString()]
  );

  return embed;
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/g;

/** Resolve up to `limit` links found in a message body. */
export async function resolveEmbedsForContent(content, { limit = 3 } = {}) {
  const urls = [...new Set(String(content ?? '').match(URL_IN_TEXT) ?? [])].slice(0, limit);
  if (urls.length === 0) return [];
  const embeds = await Promise.all(urls.map((url) => resolveEmbed(url).catch(() => null)));
  return embeds.filter(Boolean);
}
