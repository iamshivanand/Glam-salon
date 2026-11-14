# Production operations

## Container images

Both apps ship multi-stage Dockerfiles:

| Image | Build context | Runtime command | Port |
| ----- | ------------- | --------------- | ---- |
| API   | `salon-api/`  | `node dist/src/index.js` | 4000 |
| Web   | `salon-web/`  | `node server.js` (Next standalone) | 3000 |

The web Dockerfile builds with `NEXT_STANDALONE=true`, which switches `next.config.mjs` to
standalone output. A local `npm run build && npm start` keeps the default output because
`next start` cannot serve a standalone build.

```bash
docker build -t glam-api:local ./salon-api
docker build -t glam-web:local --build-arg NEXT_PUBLIC_API_URL=https://api.example.com/api/v1 ./salon-web
```

`NEXT_PUBLIC_API_URL` is baked into the web bundle at build time. Rebuild the image whenever
the public API origin changes.

`.github/workflows/release.yml` builds and pushes both images to GHCR on a `v*` tag (or a
manual dispatch). Set the repository variable `NEXT_PUBLIC_API_URL` first. If
`DEPLOY_ENABLED=true` and the `production` environment has `DEPLOY_HOST`, `DEPLOY_USER`,
`DEPLOY_SSH_KEY` and `DEPLOY_PATH`, the workflow also pulls and restarts the stack over SSH.

## Migrations

Migrations are a one-off command, never part of app startup:

```bash
docker run --rm --env-file .env glam-api:local node dist/scripts/migrate.js
```

`migrate.js` needs `MIGRATE_DATABASE_URL` (table owner). The running API keeps using the
least-privilege `glam_app` role so RLS stays enforced.

## Health and metrics

- `GET /health` — database + Redis checks, resolved notification providers, payment/storage
  capability summary. Returns 503 when a dependency is down.
- `GET /metrics` — Prometheus text format, dependency-free in-memory counters (HTTP totals,
  webhook accept/reject, reminder delivery/opt-out/conversion, payment capture/refund).
  Disable with `METRICS_ENABLED=false`.

Scrape `/metrics` from your Prometheus/VictoriaMetrics agent. Counters reset on restart by
design; scrape at an interval shorter than your restart cadence.

## Backups

Use a role that can read every row. `glam_app` is subject to RLS, so a dump made as that role
can silently omit tenants. Create a dedicated backup role with `BYPASSRLS` (or use the owner
role) and store the dump outside the database host.

```bash
BACKUP_DATABASE_URL=postgres://backup:***@db:5432/glamconnect ./ops/backup.sh
```

Windows dev/staging (runs `pg_dump` inside the container):

```powershell
./ops/backup.ps1 -BackupDir D:\backups -RetentionDays 30
```

Both scripts write custom-format dumps, verify them with `pg_restore --list`, and prune files
older than `RETENTION_DAYS` (default 14). Ship dumps to object storage with lifecycle rules;
the local directory is not a backup on its own.

Restore drill (always test against a scratch database):

```bash
createdb -h db -U glam glamconnect_restore
pg_restore --clean --if-exists --no-owner --no-privileges \
  -d postgres://glam:***@db:5432/glamconnect_restore backups/glamconnect-20261114T021500Z.dump
```

## Checklist before a real deployment

1. `NODE_ENV=production`, `DEV_RETURN_OTP` unset/false, `ALLOW_CONSOLE_NOTIFICATIONS=false`.
2. Real notification credentials (Twilio/Meta/Resend/webhook) or accept that providers will
   fail loudly instead of pretending to send.
3. `APP_PUBLIC_URL` and `API_PUBLIC_URL` set to the public HTTPS origins. Provider callbacks:
   - Twilio: `POST /webhooks/twilio/status` and `/webhooks/twilio/inbound`
   - Meta: `GET|POST /webhooks/whatsapp` (verify token + app secret)
   - Razorpay: `POST /webhooks/razorpay`
4. `TRANSACTIONAL_CHANNEL`, `WHATSAPP_TEMPLATES_ENABLED=true` and a reviewed
   `WHATSAPP_TEMPLATE_MAP` before sending business-initiated WhatsApp messages.
5. `PAYMENT_PROVIDER=razorpay` with key id/secret and webhook secret, or `manual` to record
   pay-at-salon intent only.
6. S3 bucket policy: private writes, short-lived presigned PUTs, optional CDN base URL.
   Supported types: JPEG, PNG, WebP, PDF (15-minute URLs).
7. TLS terminated in front of both services; `CORS_ORIGIN` limited to the web origin.
8. Nightly backups scheduled and a restore drill completed.
9. Alert on `/health` 503 and on any `glamconnect_webhook_rejected_total` increase.
