import '../test/setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { env } from '../src/env.js';
import {
  StorageNotConfigured,
  buildObjectKey,
  maxBytesFor,
  presignGet,
  presignPut,
  publicUrlFor,
  storageConfigured,
} from '../src/services/storage.js';

function withS3(values: Partial<Record<string, string | undefined>>, run: () => void) {
  const keys = [
    'S3_BUCKET',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'S3_ENDPOINT',
    'S3_PUBLIC_BASE_URL',
    'S3_REGION',
    'S3_FORCE_PATH_STYLE',
  ] as const;
  const before = Object.fromEntries(keys.map((key) => [key, (env as any)[key]]));
  for (const [key, value] of Object.entries(values)) {
    (env as any)[key] = value;
  }
  try {
    run();
  } finally {
    for (const key of keys) (env as any)[key] = before[key];
  }
}

test('buildObjectKey scopes uploads by purpose and user with a safe extension', () => {
  const key = buildObjectKey({
    purpose: 'avatar',
    userId: '11111111-1111-1111-1111-111111111111',
    contentType: 'image/png',
  });
  assert.match(key, /^avatar\/11111111-1111-1111-1111-111111111111\/[0-9a-f-]{36}\.png$/);

  const pdf = buildObjectKey({ purpose: 'kyc/salon-1', userId: 'u2', contentType: 'application/pdf' });
  assert.match(pdf, /^kyc\/salon-1\/u2\/[0-9a-f-]{36}\.pdf$/);
});

test('buildObjectKey rejects unsupported content types', () => {
  assert.throws(
    () => buildObjectKey({ purpose: 'avatar', userId: 'u1', contentType: 'text/html' }),
    /Unsupported content type/,
  );
});

test('presignPut refuses to run without credentials', () => {
  withS3({ S3_BUCKET: undefined, S3_ACCESS_KEY_ID: undefined, S3_SECRET_ACCESS_KEY: undefined }, () => {
    assert.equal(storageConfigured(), false);
    assert.throws(() => presignPut({ key: 'avatar/u1/x.png' }), StorageNotConfigured);
  });
});

test('presignPut builds a SigV4 path-style URL and clamps expiry', () => {
  withS3(
    {
      S3_BUCKET: 'glam-test',
      S3_ACCESS_KEY_ID: 'AKIATEST',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_ENDPOINT: 'http://127.0.0.1:9000',
      S3_FORCE_PATH_STYLE: 'true',
      S3_PUBLIC_BASE_URL: undefined,
      S3_REGION: 'ap-south-1',
    },
    () => {
      const result = presignPut({ key: 'avatar/u1/x.png', expiresSec: 9_999 });
      assert.equal(result.method, 'PUT');
      assert.equal(result.expires_in, 3600);
      assert.equal(result.key, 'avatar/u1/x.png');
      assert.equal(result.public_url, null);
      assert.match(result.upload_url, /^http:\/\/127\.0\.0\.1:9000\/glam-test\/avatar\/u1\/x\.png\?/);
      assert.match(result.upload_url, /X-Amz-Algorithm=AWS4-HMAC-SHA256/);
      assert.match(result.upload_url, /X-Amz-SignedHeaders=host/);
      assert.match(result.upload_url, /X-Amz-Signature=[0-9a-f]{64}$/);
      assert.match(result.upload_url, /X-Amz-Expires=3600/);
    },
  );
});

test('presignPut honours a public base URL for reads', () => {
  withS3(
    {
      S3_BUCKET: 'glam-test',
      S3_ACCESS_KEY_ID: 'AKIATEST',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_PUBLIC_BASE_URL: 'https://cdn.example.com/',
      S3_REGION: 'ap-south-1',
    },
    () => {
      const result = presignPut({ key: '/avatar/u1/x.png' });
      assert.equal(result.public_url, 'https://cdn.example.com/avatar/u1/x.png');
      assert.equal(publicUrlFor('/kyc/u1/a.pdf'), 'https://cdn.example.com/kyc/u1/a.pdf');
    },
  );
});

test('presignPut signs the declared content type so it cannot be swapped', () => {
  withS3(
    {
      S3_BUCKET: 'glam-test',
      S3_ACCESS_KEY_ID: 'AKIATEST',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_ENDPOINT: 'http://127.0.0.1:9000',
      S3_FORCE_PATH_STYLE: 'true',
      S3_PUBLIC_BASE_URL: undefined,
      S3_REGION: 'ap-south-1',
    },
    () => {
      const result = presignPut({ key: 'kyc/s1/u1/a.pdf', contentType: 'application/pdf' });
      assert.match(result.upload_url, /X-Amz-SignedHeaders=content-type%3Bhost/);
      assert.deepEqual(result.headers, { 'Content-Type': 'application/pdf' });
    },
  );
});

test('presignGet generates 60s SigV4 GET URL for private reference photos', () => {
  withS3(
    {
      S3_BUCKET: 'glam-test',
      S3_ACCESS_KEY_ID: 'AKIATEST',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_ENDPOINT: 'http://127.0.0.1:9000',
      S3_FORCE_PATH_STYLE: 'true',
      S3_PUBLIC_BASE_URL: undefined,
      S3_REGION: 'ap-south-1',
    },
    () => {
      const result = presignGet({ key: 'style-vault/u1/cut.jpg', expiresSec: 60 });
      assert.equal(result.expires_in, 60);
      assert.equal(result.key, 'style-vault/u1/cut.jpg');
      assert.match(result.url, /^http:\/\/127\.0\.0\.1:9000\/glam-test\/style-vault\/u1\/cut\.jpg\?/);
      assert.match(result.url, /X-Amz-Expires=60/);
      assert.match(result.url, /X-Amz-SignedHeaders=host/);
      assert.match(result.url, /X-Amz-Signature=[0-9a-f]{64}$/);
    },
  );
});

test('presignGet falls back gracefully when storage is unconfigured', () => {
  withS3({ S3_BUCKET: undefined, S3_ACCESS_KEY_ID: undefined, S3_SECRET_ACCESS_KEY: undefined }, () => {
    const result = presignGet({ key: 'style-vault/u1/cut.jpg' });
    assert.equal(result.url, '/uploads/mock/style-vault/u1/cut.jpg');
  });
});

test('maxBytesFor enforces per-type limits', () => {
  assert.equal(maxBytesFor('image/png'), 5 * 1024 * 1024);
  assert.equal(maxBytesFor('application/pdf'), 10 * 1024 * 1024);
  assert.equal(maxBytesFor('text/html'), null);
});

test('presignGet signs a short-lived read URL', () => {
  withS3(
    {
      S3_BUCKET: 'glam-test',
      S3_ACCESS_KEY_ID: 'AKIATEST',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_ENDPOINT: 'http://127.0.0.1:9000',
      S3_FORCE_PATH_STYLE: 'true',
      S3_PUBLIC_BASE_URL: undefined,
      S3_REGION: 'ap-south-1',
    },
    () => {
      const result = presignGet('kyc/s1/u1/a.pdf', 120);
      assert.equal(result.expires_in, 120);
      assert.match(result.url, /X-Amz-SignedHeaders=host/);
      assert.match(result.url, /X-Amz-Expires=120/);
      assert.match(result.url, /X-Amz-Signature=[0-9a-f]{64}$/);
    },
  );
});
