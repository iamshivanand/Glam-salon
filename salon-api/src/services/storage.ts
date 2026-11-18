import crypto from 'node:crypto';
import { env } from '../env.js';

const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

export class StorageNotConfigured extends Error {
  constructor() {
    super('Object storage is not configured. Set S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.');
    this.name = 'StorageNotConfigured';
  }
}

export function storageConfigured(): boolean {
  return Boolean(env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY);
}

export function storageProviderName(): string {
  return storageConfigured() ? 's3' : 'none';
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest();
}

function storageEndpoint(): { protocol: string; host: string; pathStyle: boolean } {
  const bucket = env.S3_BUCKET!;
  if (!env.S3_ENDPOINT) {
    return { protocol: 'https:', host: `${bucket}.s3.${env.S3_REGION}.amazonaws.com`, pathStyle: false };
  }
  const url = new URL(env.S3_ENDPOINT);
  const pathStyle = (env.S3_FORCE_PATH_STYLE ?? 'true') !== 'false';
  return {
    protocol: url.protocol,
    host: pathStyle ? url.host : `${bucket}.${url.host}`,
    pathStyle,
  };
}

export function buildObjectKey(opts: { purpose: string; userId: string; filename?: string; contentType: string }): string {
  if (!ALLOWED_CONTENT_TYPES.has(opts.contentType)) {
    throw new Error(`Unsupported content type: ${opts.contentType}`);
  }
  const purpose =
    opts.purpose
      .split('/')
      .map((segment) => segment.replace(/[^a-z0-9_-]/gi, '').slice(0, 32))
      .filter(Boolean)
      .slice(0, 4)
      .join('/') || 'misc';
  const ext = EXT_BY_TYPE[opts.contentType] ?? 'bin';
  return `${purpose}/${opts.userId}/${crypto.randomUUID()}.${ext}`;
}

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;

/** Server-enforced ceiling for a declared content type, or null if unsupported. */
export function maxBytesFor(contentType: string): number | null {
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) return null;
  return contentType === 'application/pdf' ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
}

function objectPath(key: string): { canonicalUri: string; host: string; protocol: string } {
  const { protocol, host, pathStyle } = storageEndpoint();
  const clean = key.replace(/^\/+/, '');
  const encoded = clean.split('/').map(encodeRfc3986).join('/');
  return {
    protocol,
    host,
    canonicalUri: pathStyle ? `/${encodeRfc3986(env.S3_BUCKET!)}/${encoded}` : `/${encoded}`,
  };
}

function signingKey(dateStamp: string): Buffer {
  const kDate = hmac(`AWS4${env.S3_SECRET_ACCESS_KEY}`, dateStamp);
  const kRegion = hmac(kDate, env.S3_REGION);
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

/**
 * Create a short-lived presigned URL for S3-compatible storage.
 * SigV4 is implemented directly so the API does not need the AWS SDK.
 *
 * When `contentType` is supplied it becomes a signed header, so the storage
 * provider rejects an upload whose Content-Type differs from the declaration.
 */
function presign(opts: {
  method: 'PUT' | 'GET';
  key: string;
  expiresSec?: number;
  contentType?: string;
}): { url: string; expiresIn: number } {
  if (!storageConfigured()) throw new StorageNotConfigured();

  const expiresIn = Math.min(Math.max(opts.expiresSec ?? 900, 60), 3600);
  const { protocol, host, canonicalUri } = objectPath(opts.key);

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${env.S3_REGION}/s3/aws4_request`;

  const signedHeaders = opts.contentType ? 'content-type;host' : 'host';
  const canonicalHeaders = opts.contentType
    ? `content-type:${opts.contentType.trim()}\nhost:${host}\n`
    : `host:${host}\n`;

  const query = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${env.S3_ACCESS_KEY_ID}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': signedHeaders,
  });
  // URLSearchParams encodes spaces as '+', which SigV4 does not accept.
  const canonicalQuery = query.toString().replace(/\+/g, '%20');

  const canonicalRequest = [
    opts.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = crypto
    .createHmac('sha256', signingKey(dateStamp))
    .update(stringToSign, 'utf8')
    .digest('hex');

  return {
    url: `${protocol}//${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    expiresIn,
  };
}

export function presignPut(opts: {
  key: string;
  expiresSec?: number;
  contentType?: string;
}): {
  upload_url: string;
  method: 'PUT';
  key: string;
  expires_in: number;
  public_url: string | null;
  headers: Record<string, string>;
} {
  const { url, expiresIn } = presign({
    method: 'PUT',
    key: opts.key,
    expiresSec: opts.expiresSec,
    contentType: opts.contentType,
  });
  const key = opts.key.replace(/^\/+/, '');
  const publicUrl = env.S3_PUBLIC_BASE_URL
    ? `${env.S3_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`
    : null;

  return {
    upload_url: url,
    method: 'PUT',
    key,
    expires_in: expiresIn,
    public_url: publicUrl,
    // Clients must send exactly this header; it is part of the signature.
    headers: opts.contentType ? { 'Content-Type': opts.contentType } : {},
  };
}

/** Short-lived read URL. KYC documents are private, so the API signs GETs. */
export function presignGet(key: string, expiresSec = 300): {
  url: string;
  expires_in: number;
} {
  const { url, expiresIn } = presign({ method: 'GET', key, expiresSec });
  return { url, expires_in: expiresIn };
}

function signedRequest(method: 'HEAD' | 'DELETE', key: string): { url: string; headers: Record<string, string> } {
  const { protocol, host, canonicalUri } = objectPath(key);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${env.S3_REGION}/s3/aws4_request`;
  const payloadHash = 'UNSIGNED-PAYLOAD';
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders =
    `host:${host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzDate}\n`;

  const canonicalRequest = [
    method,
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = crypto
    .createHmac('sha256', signingKey(dateStamp))
    .update(stringToSign, 'utf8')
    .digest('hex');

  return {
    url: `${protocol}//${host}${canonicalUri}`,
    headers: {
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${env.S3_ACCESS_KEY_ID}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

export interface ObjectHead {
  contentType: string | null;
  contentLength: number;
}

/** Ask the object store what was actually uploaded. Null means no object. */
export async function headObject(key: string): Promise<ObjectHead | null> {
  if (!storageConfigured()) throw new StorageNotConfigured();
  const { url, headers } = signedRequest('HEAD', key);
  const res = await fetch(url, { method: 'HEAD', headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Object storage HEAD failed with ${res.status}`);
  return {
    contentType: res.headers.get('content-type'),
    contentLength: Number(res.headers.get('content-length') ?? 0),
  };
}

/** Best-effort delete used when an upload fails validation. */
export async function deleteObject(key: string): Promise<void> {
  if (!storageConfigured()) throw new StorageNotConfigured();
  const { url, headers } = signedRequest('DELETE', key);
  const res = await fetch(url, { method: 'DELETE', headers });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Object storage DELETE failed with ${res.status}`);
  }
}

export function publicUrlFor(key: string): string | null {
  if (!env.S3_PUBLIC_BASE_URL) return null;
  return `${env.S3_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key.replace(/^\/+/, '')}`;
}
