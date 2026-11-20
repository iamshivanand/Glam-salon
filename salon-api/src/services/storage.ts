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

/**
 * Create a short-lived presigned PUT URL for S3-compatible storage.
 * SigV4 is implemented directly so the API does not need the AWS SDK.
 */
export function presignPut(opts: { key: string; expiresSec?: number }): {
  upload_url: string;
  method: 'PUT';
  key: string;
  expires_in: number;
  public_url: string | null;
  headers: Record<string, string>;
} {
  if (!storageConfigured()) throw new StorageNotConfigured();

  const expiresIn = Math.min(Math.max(opts.expiresSec ?? 900, 60), 3600);
  const { protocol, host, pathStyle } = storageEndpoint();
  const key = opts.key.replace(/^\/+/, '');
  const canonicalUri = pathStyle
    ? `/${encodeRfc3986(env.S3_BUCKET!)}/${key.split('/').map(encodeRfc3986).join('/')}`
    : `/${key.split('/').map(encodeRfc3986).join('/')}`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${env.S3_REGION}/s3/aws4_request`;

  const query = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${env.S3_ACCESS_KEY_ID}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
  });
  // URLSearchParams encodes spaces as '+', which SigV4 does not accept.
  const canonicalQuery = query.toString().replace(/\+/g, '%20');

  const canonicalRequest = [
    'PUT',
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${env.S3_SECRET_ACCESS_KEY}`, dateStamp);
  const kRegion = hmac(kDate, env.S3_REGION);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const uploadUrl = `${protocol}//${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  const publicUrl = env.S3_PUBLIC_BASE_URL
    ? `${env.S3_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`
    : null;

  return {
    upload_url: uploadUrl,
    method: 'PUT',
    key,
    expires_in: expiresIn,
    public_url: publicUrl,
    headers: {},
  };
}

export function publicUrlFor(key: string): string | null {
  if (!env.S3_PUBLIC_BASE_URL) return null;
  return `${env.S3_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key.replace(/^\/+/, '')}`;
}

/**
 * Create a short-lived presigned GET URL for reading private S3 objects.
 */
export function presignGet(opts: { key: string; expiresSec?: number }): {
  url: string;
  key: string;
  expires_in: number;
} {
  const expiresIn = Math.min(Math.max(opts.expiresSec ?? 60, 10), 3600);
  if (!storageConfigured()) {
    return {
      url: publicUrlFor(opts.key) ?? `/uploads/mock/${opts.key.replace(/^\/+/, '')}`,
      key: opts.key,
      expires_in: expiresIn,
    };
  }

  const { protocol, host, pathStyle } = storageEndpoint();
  const key = opts.key.replace(/^\/+/, '');
  const canonicalUri = pathStyle
    ? `/${encodeRfc3986(env.S3_BUCKET!)}/${key.split('/').map(encodeRfc3986).join('/')}`
    : `/${key.split('/').map(encodeRfc3986).join('/')}`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${env.S3_REGION}/s3/aws4_request`;

  const query = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${env.S3_ACCESS_KEY_ID}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
  });
  const canonicalQuery = query.toString().replace(/\+/g, '%20');

  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${env.S3_SECRET_ACCESS_KEY}`, dateStamp);
  const kRegion = hmac(kDate, env.S3_REGION);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const getUrl = `${protocol}//${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;

  return {
    url: getUrl,
    key,
    expires_in: expiresIn,
  };
}
