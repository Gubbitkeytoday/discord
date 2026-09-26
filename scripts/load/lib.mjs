// ============================================================================
//  Shared helpers for the load-testing suite (scripts/load/*).
//
//  No dependencies beyond Node 22 built-ins: fetch, worker_threads, zlib.
// ============================================================================

import fs from 'node:fs';
import zlib from 'node:zlib';

/** --key value / --flag  →  { key: 'value', flag: true } */
export function parseArgs(argv = process.argv.slice(2), defaults = {}) {
  const out = { ...defaults };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [rawKey, inline] = arg.slice(2).split('=');
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { value = next; i += 1; } else value = true;
    }
    const def = defaults[key];
    out[key] = typeof def === 'number' ? Number(value) : value;
  }
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A spoofed client address. The server trusts X-Forwarded-For from loopback
 * (TRUST_PROXY defaults to 'loopback' outside production), so a load generator
 * on the same host can present many distinct clients to the per-IP limiters —
 * which is what a real login storm from many users looks like.
 */
export function fakeIp(n) {
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${(n & 255) || 1}`;
}

/** Minimal JSON HTTP client with bearer auth. Throws on non-2xx.
 *  With `retry429`, a 429 waits for Retry-After and tries again (seeding only —
 *  the per-user 600 req/min budget covers writes too). */
export function makeClient(baseUrl, { retry429 = false } = {}) {
  return async function request(method, path, opts = {}) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await once(method, path, opts);
      } catch (err) {
        if (!retry429 || err.status !== 429 || attempt > 20) throw err;
        await sleep(1000 * (Number(err.data?.details?.retry_after_seconds) || 1));
      }
    }
  };
  async function once(method, path, { token, body, ip, headers = {}, raw = false } = {}) {
    const h = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    if (ip) h['X-Forwarded-For'] = ip;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(baseUrl + path, { method, headers: h, body: payload });
    if (raw) return res;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`${method} ${path} → ${res.status} ${data?.error ?? text.slice(0, 120)}`);
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }
}

/** Run `fn(item, index)` over `items` with at most `limit` in flight. */
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// --- latency histogram --------------------------------------------------------
//
// Fixed 0.1 ms buckets up to 120 s. Mergeable across worker threads by adding
// arrays, so millions of fan-out samples cost 4.8 MB instead of a sorted array.

const RES = 10;                 // buckets per ms
const MAX_MS = 120_000;

export class Histogram {
  constructor(buf) {
    this.b = buf ? new Uint32Array(buf) : new Uint32Array(MAX_MS * RES + 1);
    this.n = 0; this.sum = 0; this.max = 0;
  }
  record(ms) {
    if (!(ms >= 0)) ms = 0;
    const i = Math.min(Math.round(ms * RES), this.b.length - 1);
    this.b[i] += 1; this.n += 1; this.sum += ms; if (ms > this.max) this.max = ms;
  }
  merge(other) {
    const ob = other.b ?? new Uint32Array(other.buf);
    for (let i = 0; i < ob.length; i += 1) if (ob[i]) this.b[i] += ob[i];
    this.n += other.n; this.sum += other.sum; this.max = Math.max(this.max, other.max);
  }
  pct(p) {
    if (this.n === 0) return null;
    const target = Math.ceil((p / 100) * this.n);
    let seen = 0;
    for (let i = 0; i < this.b.length; i += 1) {
      seen += this.b[i];
      if (seen >= target) return i / RES;
    }
    return this.max;
  }
  summary() {
    return {
      count: this.n,
      mean: this.n ? round(this.sum / this.n) : null,
      p50: this.pct(50), p95: this.pct(95), p99: this.pct(99),
      max: round(this.max)
    };
  }
  /** Transferable snapshot for postMessage. */
  toJSON() { return { buf: this.b.buffer.slice(0), n: this.n, sum: this.sum, max: this.max }; }
  static from(obj) {
    const h = new Histogram(obj.buf); h.n = obj.n; h.sum = obj.sum; h.max = obj.max; return h;
  }
}

export const round = (x, d = 1) => (x == null ? x : Math.round(x * 10 ** d) / 10 ** d);

// --- tiny PNG encoder (for the upload scenario) -------------------------------

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** A valid RGB PNG of noise — every seed produces different bytes, so the
 *  content-addressed store cannot dedupe the upload away. */
export function makePng(width, height, seed) {
  let s = seed * 2654435761 >>> 0;
  const rand = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s >>> 0; };
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * row] = 0;
    for (let x = 0; x < width * 3; x += 1) {
      // Smooth-ish gradient plus noise: compresses like a small photo would.
      raw[y * row + 1 + x] = ((x + y) * 2 + (rand() & 63)) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

export function readJson(path) { return JSON.parse(fs.readFileSync(path, 'utf8')); }
export function writeJson(path, obj) { fs.writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`); }

/** Scrape the Prometheus text from /metrics into a flat object. */
export async function scrapeMetrics(baseUrl) {
  try {
    const text = await (await fetch(`${baseUrl}/metrics`)).text();
    const out = {};
    for (const line of text.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^([^\s]+)\s+([-\d.e+]+)$/);
      if (m) out[m[1]] = Number(m[2]);
    }
    return out;
  } catch { return null; }
}
