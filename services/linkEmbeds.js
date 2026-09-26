// ============================================================================
//  Link preview (OpenGraph) resolution, with a database-backed cache.
//
//  Fetching is deliberately conservative: an unfurler is a request-forging
//  primitive if it will fetch anything a user pastes, so private address ranges
//  are refused, redirects are capped, and only a small HTML head is read.
// ============================================================================

import crypto from 'crypto';
import dns from 'dns/promises';
import { lookup as dnsLookup } from 'dns';
import http from 'http';
import https from 'https';
import net from 'net';

import { runQuery, getQuery, sql } from '../db.js';
import { proxiedImageUrl } from '../lib/mediaUrls.js';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 256 * 1024;   // enough for <head>, not enough to be a download
const MAX_REDIRECTS = 3;

const hashUrl = (url) => crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);

/** Reject anything that is not a public http(s) host. */
async function assertPublicUrl(rawUrl) {
  const fail = (message, code) => Object.assign(new Error(message), { code });
  let url;
  try { url = new URL(rawUrl); } catch { throw fail('Invalid URL', 'EINVALIDURL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw fail('Only http(s) URLs are supported', 'EINVALIDURL');

  // WHATWG keeps the brackets on an IPv6 literal ("[::1]").
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(host)) {
    throw fail('Refusing a local host', 'EPRIVATE');
  }

  // Resolve and check every address — a public name can point at a private IP.
  let addresses;
  try {
    addresses = net.isIP(host)
      ? [{ address: host }]
      : await dns.lookup(host, { all: true });
  } catch {
    throw fail('Host does not resolve', 'ENOTFOUND');
  }

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) throw fail('Refusing a private network address', 'EPRIVATE');
  }
  return url;
}

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||   // link-local, incl. cloud metadata
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224                      // multicast, reserved, broadcast
    );
  }
  if (!net.isIPv6(ip)) return true;  // not an address we understand: refuse
  const lower = ip.toLowerCase();
  // IPv4-mapped / -translated forms (::ffff:127.0.0.1, ::ffff:7f00:1,
  // 64:ff9b::a9fe:a9fe) reach the IPv4 address they embed.
  const mapped = lower.match(/^(?:::ffff:(?:0:)?|64:ff9b::)(.+)$/);
  if (mapped) {
    const tail = mapped[1];
    if (net.isIPv4(tail)) return isPrivateAddress(tail);
    const hex = tail.split(':');
    if (hex.length === 2) {
      const hi = parseInt(hex[0], 16); const lo = parseInt(hex[1], 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return true;
  }
  return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd')
    || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea')
    || lower.startsWith('feb') || lower.startsWith('ff');
}

/**
 * DNS lookup for outbound unfurls that refuses private answers *at connect
 * time*. Validating a name once and then letting fetch() resolve it again is
 * a DNS-rebinding hole: the second answer can be 127.0.0.1.
 */
function guardedLookup(hostname, options, callback) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options?.family }];
    const bad = list.find(({ address }) => isPrivateAddress(address));
    if (bad || list.length === 0) {
      return callback(Object.assign(new Error('Refusing a private network address'), { code: 'EPRIVATE' }));
    }
    if (options?.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family ?? (net.isIPv6(list[0].address) ? 6 : 4));
  });
}

/**
 * GET with every hop checked. Redirects are followed by hand (at most
 * MAX_REDIRECTS), and each target goes through assertPublicUrl again — with
 * `redirect: 'follow'` a public page could 302 the unfurler straight to the
 * cloud metadata service.
 */
export async function safeGet(startUrl, { signal, accept = 'text/html,application/xhtml+xml' }) {
  let current = await assertPublicUrl(startUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await new Promise((resolve, reject) => {
      const client = current.protocol === 'https:' ? https : http;
      const req = client.get(current, {
        lookup: guardedLookup,
        signal,
        headers: {
          // Many sites only emit OpenGraph tags for a bot-looking agent.
          'User-Agent': 'Mozilla/5.0 (compatible; AntigravityBot/1.0; +link-preview)',
          Accept: accept
        }
      }, resolve);
      req.on('error', reject);
    });
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume();
      if (hop === MAX_REDIRECTS) throw new Error('too many redirects');
      current = await assertPublicUrl(new URL(response.headers.location, current).href);
      continue;
    }
    if (status < 200 || status >= 300) {
      response.resume();
      throw new Error(`HTTP ${status}`);
    }
    return { response, url: current };
  }
  throw new Error('too many redirects');
}

/** Only http(s) image URLs survive into an embed. */
function safeHttpUrl(value, base) {
  try {
    const url = new URL(value, base);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
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

// One pass over the text: decoding entity by entity in sequence would turn a
// literal "&amp;lt;" into "<" (double unescaping) instead of "&lt;".
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text) {
  return text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (entity, hex, dec, name) => {
    if (name !== undefined) return Object.hasOwn(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : entity;
    const codePoint = hex !== undefined ? parseInt(hex, 16) : Number(dec);
    return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
  });
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const { response, url } = await safeGet(rawUrl, { signal: controller.signal });
    const contentType = String(response.headers['content-type'] ?? '');

    if (contentType.startsWith('image/')) {
      response.destroy();
      // `url` is the link; `image` is what the browser loads — via our proxy,
      // so viewing the preview does not reveal the viewer to the site.
      embed = { type: 'image', url: rawUrl, image: proxiedImageUrl(rawUrl) };
    } else if (contentType.includes('html')) {
      // Read at most MAX_BYTES rather than buffering an arbitrary page.
      const chunks = [];
      let received = 0;
      for await (const chunk of response) {
        chunks.push(chunk);
        received += chunk.length;
        if (received >= MAX_BYTES) break;
      }
      response.destroy();
      const html = Buffer.concat(chunks).toString('utf8');

      const title = extract(html, META_PATTERNS.title);
      if (title) {
        const image = extract(html, META_PATTERNS.image);
        embed = {
          type: 'link',
          url: rawUrl,
          title,
          description: extract(html, META_PATTERNS.description),
          image: image ? proxiedImageUrl(safeHttpUrl(image, url)) : null,
          site_name: extract(html, META_PATTERNS.siteName) ?? url.hostname,
          // Rendered into a style; only a plain colour is accepted.
          color: /^#[0-9a-f]{3,8}$/i.test(extract(html, META_PATTERNS.themeColor) ?? '')
            ? extract(html, META_PATTERNS.themeColor) : null
        };
      } else {
        response.destroy();
      }
    } else {
      response.destroy();
    }
  } catch (err) {
    // Cache the miss too, so one bad link is not refetched on every render.
    embed = null;
  } finally {
    clearTimeout(timer);
  }

  await runQuery(
    `INSERT INTO link_embeds (url_hash, url, data, fetched_at, expires_at)
     VALUES (?, ?, ?, ${sql.now}, ?)
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
