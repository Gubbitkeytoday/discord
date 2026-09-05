// ============================================================================
//  Minimal S3-compatible client (AWS S3, Cloudflare R2, MinIO, Backblaze B2).
//
//  Implements AWS Signature Version 4 directly. The official SDK is ~15 MB of
//  transitive dependencies for what amounts to PUT, GET, DELETE and HEAD; the
//  signing algorithm is public and testable, so it is implemented here and
//  verified against the AWS-published test vectors in the test suite.
// ============================================================================

import crypto from 'crypto';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding. encodeURIComponent leaves !'()* alone; S3 does not. */
export function uriEncode(value, encodeSlash = true) {
  let out = '';
  for (const char of String(value)) {
    if (/[A-Za-z0-9\-._~]/.test(char)) out += char;
    else if (char === '/') out += encodeSlash ? '%2F' : '/';
    else {
      for (const byte of Buffer.from(char, 'utf8')) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    }
  }
  return out;
}

/**
 * Build the canonical request, string to sign, and Authorization header.
 * Exposed separately from the request path so it can be unit-tested against the
 * AWS test-suite vectors without any network access.
 */
export function signRequest({
  method, path, query = {}, headers, body = '', region, service = 's3',
  accessKeyId, secretAccessKey, sessionToken = null, timestamp = new Date(),
  unsignedPayload = false
}) {
  const amzDate = timestamp.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = unsignedPayload ? UNSIGNED_PAYLOAD : sha256Hex(body);

  const allHeaders = {
    ...headers,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {})
  };

  // Canonical headers: lowercase names, trimmed values, sorted by name.
  const canonicalHeaderNames = Object.keys(allHeaders)
    .map((name) => name.toLowerCase())
    .sort();
  const lowered = Object.fromEntries(
    Object.entries(allHeaders).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')])
  );
  const canonicalHeaders = canonicalHeaderNames.map((n) => `${n}:${lowered[n]}\n`).join('');
  const signedHeaders = canonicalHeaderNames.join(';');

  const canonicalQuery = Object.keys(query).sort()
    .map((key) => `${uriEncode(key)}=${uriEncode(query[key])}`)
    .join('&');

  const canonicalRequest = [
    method,
    // The path is already an encoded object key; slashes stay literal.
    path.split('/').map((segment) => uriEncode(segment)).join('/'),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    ALGORITHM, amzDate, credentialScope, sha256Hex(canonicalRequest)
  ].join('\n');

  const signingKey = ['aws4_request', service, region, dateStamp].reduceRight(
    (key, part) => hmac(key, part),
    `AWS4${secretAccessKey}`
  );
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return {
    authorization:
      `${ALGORITHM} Credential=${accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    headers: { ...allHeaders, Authorization: undefined },
    amzDate,
    signature,
    canonicalRequest,
    stringToSign
  };
}

/**
 * A tiny S3 client. Configured entirely from the environment so switching
 * backends is a deployment decision, not a code change.
 */
export class S3Client {
  constructor({
    endpoint = process.env.S3_ENDPOINT,
    region = process.env.S3_REGION || 'auto',
    bucket = process.env.S3_BUCKET,
    accessKeyId = process.env.S3_ACCESS_KEY_ID,
    secretAccessKey = process.env.S3_SECRET_ACCESS_KEY,
    sessionToken = process.env.S3_SESSION_TOKEN || null,
    forcePathStyle = process.env.S3_FORCE_PATH_STYLE !== '0'
  } = {}) {
    this.endpoint = endpoint;
    this.region = region;
    this.bucket = bucket;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.sessionToken = sessionToken;
    this.forcePathStyle = forcePathStyle;
  }

  get configured() {
    return Boolean(this.endpoint && this.bucket && this.accessKeyId && this.secretAccessKey);
  }

  /** R2 and MinIO want path-style URLs; AWS prefers virtual-hosted. */
  urlFor(key) {
    const base = new URL(this.endpoint);
    if (this.forcePathStyle) {
      base.pathname = `/${this.bucket}/${key}`;
    } else {
      base.host = `${this.bucket}.${base.host}`;
      base.pathname = `/${key}`;
    }
    return base;
  }

  async request({ method, key, body = '', contentType, extraHeaders = {} }) {
    if (!this.configured) throw new Error('S3 backend is not configured');

    const url = this.urlFor(key);
    const headers = {
      host: url.host,
      ...(contentType ? { 'content-type': contentType } : {}),
      ...(body ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
      ...extraHeaders
    };

    const signed = signRequest({
      method,
      path: url.pathname,
      headers,
      body,
      region: this.region,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      sessionToken: this.sessionToken
    });

    const response = await fetch(url, {
      method,
      headers: { ...headers, Authorization: signed.authorization, 'x-amz-date': signed.amzDate,
                 'x-amz-content-sha256': sha256Hex(body) },
      body: method === 'GET' || method === 'HEAD' || method === 'DELETE' ? undefined : body
    });

    if (!response.ok && response.status !== 404) {
      const detail = await response.text().catch(() => '');
      throw new Error(`S3 ${method} ${key} failed: ${response.status} ${detail.slice(0, 200)}`);
    }
    return response;
  }

  async putObject(key, buffer, contentType) {
    await this.request({ method: 'PUT', key, body: buffer, contentType });
    return { key };
  }

  async getObject(key) {
    const response = await this.request({ method: 'GET', key });
    if (response.status === 404) return null;
    return Buffer.from(await response.arrayBuffer());
  }

  async headObject(key) {
    const response = await this.request({ method: 'HEAD', key });
    if (response.status === 404) return null;
    return {
      size: Number(response.headers.get('content-length')),
      contentType: response.headers.get('content-type'),
      etag: response.headers.get('etag')
    };
  }

  async deleteObject(key) {
    await this.request({ method: 'DELETE', key });
    return true;
  }

  /**
   * Presigned GET URL — lets a browser fetch a private object directly from the
   * bucket, so file bytes never transit this server.
   */
  presignGet(key, { expiresIn = 3600 } = {}) {
    if (!this.configured) throw new Error('S3 backend is not configured');
    const url = this.urlFor(key);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;

    const query = {
      'X-Amz-Algorithm': ALGORITHM,
      'X-Amz-Credential': `${this.accessKeyId}/${credentialScope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expiresIn),
      'X-Amz-SignedHeaders': 'host',
      ...(this.sessionToken ? { 'X-Amz-Security-Token': this.sessionToken } : {})
    };

    const canonicalQuery = Object.keys(query).sort()
      .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`).join('&');

    const canonicalRequest = [
      'GET',
      url.pathname.split('/').map((s) => uriEncode(s)).join('/'),
      canonicalQuery,
      `host:${url.host}\n`,
      'host',
      UNSIGNED_PAYLOAD
    ].join('\n');

    const stringToSign = [ALGORITHM, amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
    const signingKey = ['aws4_request', 's3', this.region, dateStamp].reduceRight(
      (key, part) => hmac(key, part), `AWS4${this.secretAccessKey}`
    );
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    return `${url.origin}${url.pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }
}

export const s3 = new S3Client();
