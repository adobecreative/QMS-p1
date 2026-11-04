// File storage on any S3-compatible service instead of the server's disk, for server/node.mjs.
// Works with AWS S3, Oracle Object Storage (S3 compatibility), Google Cloud Storage (HMAC keys),
// MinIO, Ceph, and the Saudi clouds that offer an S3 endpoint. Same calls as Cloudflare R2:
// put / get / head / delete / list. Requests are signed with AWS Signature V4, path-style
// (endpoint/bucket/key), so no extra package is needed.
import { createHash, createHmac } from 'node:crypto';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
// RFC 3986 encoding, as S3 signing expects; "/" is kept between the parts of an object key.
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encKey = (key) => key.split('/').map(enc).join('/');
const xmlText = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export const s3Files = ({ endpoint, region = 'us-east-1', bucket, accessKey, secretKey }) => {
  const base = new URL(endpoint.replace(/\/+$/, '') + '/' + enc(bucket));

  const send = async (method, key, { query = {}, body, headers = {} } = {}) => {
    const url = new URL(base.href + (key ? '/' + encKey(key) : ''));
    const params = Object.entries(query).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const canonicalQuery = params.map(([k, v]) => enc(k) + '=' + enc(String(v))).join('&');
    url.search = canonicalQuery;
    const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
    const day = amzDate.slice(0, 8);
    const payloadHash = sha256(body || '');
    const all = { ...headers, host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    const names = Object.keys(all).map((n) => n.toLowerCase()).sort();
    const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
    const signedHeaders = names.join(';');
    const canonical = [method, url.pathname, canonicalQuery, names.map((n) => `${n}:${lower[n]}\n`).join(''), signedHeaders, payloadHash].join('\n');
    const scope = `${day}/${region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretKey, day), region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
    const { host, ...sendHeaders } = lower;
    sendHeaders.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const res = await fetch(url.href, { method, headers: sendHeaders, body });
    if (res.status === 404 && (method === 'GET' || method === 'HEAD')) return null;
    if (!res.ok && !(method === 'DELETE' && res.status === 404)) throw new Error(`S3 ${method} ${key || '(list)'}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res;
  };

  const toBytes = async (body) => {
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (typeof body === 'string') return new TextEncoder().encode(body);
    return new Uint8Array(await new Response(body).arrayBuffer());
  };
  const objectOf = (key, res, bytes) => {
    const contentType = res.headers.get('content-type');
    const httpMetadata = contentType ? { contentType } : {};
    const obj = {
      key,
      size: Number(res.headers.get('content-length') || bytes?.byteLength || 0),
      uploaded: new Date(res.headers.get('last-modified') || Date.now()),
      httpMetadata,
      writeHttpMetadata: (h) => contentType && h.set('content-type', contentType),
    };
    if (!bytes) return obj;
    return Object.assign(obj, {
      size: bytes.byteLength,
      get body() {
        return new Response(bytes).body;
      },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      text: async () => new TextDecoder().decode(bytes),
      json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    });
  };

  return {
    async put(key, body, opts = {}) {
      const bytes = await toBytes(body);
      const headers = { 'content-type': opts.httpMetadata?.contentType || 'application/octet-stream' };
      await send('PUT', String(key), { body: bytes, headers });
      return { key: String(key), size: bytes.byteLength, uploaded: new Date(), httpMetadata: opts.httpMetadata || {} };
    },
    async get(key) {
      const res = await send('GET', String(key));
      return res && objectOf(String(key), res, new Uint8Array(await res.arrayBuffer()));
    },
    async head(key) {
      const res = await send('HEAD', String(key));
      return res && objectOf(String(key), res);
    },
    async delete(keys) {
      for (const key of [].concat(keys)) await send('DELETE', String(key));
    },
    async list({ prefix = '', limit = 1000 } = {}) {
      const objects = [];
      let token = '';
      let truncated = false;
      do {
        const query = { 'list-type': 2, 'max-keys': Math.min(1000, limit - objects.length), prefix };
        if (token) query['continuation-token'] = token;
        const xml = await (await send('GET', '', { query })).text();
        for (const [, part] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const tag = (t) => xmlText((part.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1] || '');
          objects.push({ key: tag('Key'), size: Number(tag('Size')), uploaded: new Date(tag('LastModified')), httpMetadata: {} });
        }
        truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
        token = xmlText((xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/) || [])[1] || '');
      } while (truncated && token && objects.length < limit);
      return { objects, truncated, delimitedPrefixes: [] };
    },
  };
};
