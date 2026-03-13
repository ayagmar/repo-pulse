# Operations Guide

## Prerequisites

- Node.js 22+
- npm
- Cloudflare account with Wrangler access for remote migrations or deployment

## Local Development

1. Install dependencies:

```bash
npm ci
```

2. Create local secrets:

```bash
cp .dev.vars.example .dev.vars
```

3. Apply local migrations and generate Worker types:

```bash
npm run db:migrate:local
npm run typegen
```

4. Run the Worker:

```bash
npm run dev
```

## Production Deployment

1. Ensure [`wrangler.jsonc`](/home/ayagmar/Projects/Personal/repo-pulse/wrangler.jsonc) points at the correct D1 database for the Cloudflare account you are deploying to. If you are deploying this repo to a different account than the current one, replace the committed `database_id` first.

2. Set secrets:

```bash
npm exec wrangler secret put GITHUB_WEBHOOK_SECRET
npm exec wrangler secret put ADMIN_API_TOKEN
npm exec wrangler secret put DISCORD_WEBHOOK_URL
```

3. Apply remote migrations:

```bash
npm run db:migrate:remote
```

4. Deploy:

```bash
npm run deploy
```

5. Configure GitHub webhooks to point at:

```text
https://<your-worker>.workers.dev/webhook
```

Use:

- content type: `application/json`
- secret: same value as `GITHUB_WEBHOOK_SECRET`
- events: `Stars`, `Issues`, `Pull requests`, `Forks`

## Runtime Configuration

Worker runtime baseline in [`wrangler.jsonc`](/home/ayagmar/Projects/Personal/repo-pulse/wrangler.jsonc):

- Current `compatibility_date`
- `compatibility_flags: ["nodejs_compat"]`
- Workers observability logs with `head_sampling_rate: 1`

Values configured in [`wrangler.jsonc`](/home/ayagmar/Projects/Personal/repo-pulse/wrangler.jsonc):

- `NODE_ENV`
- `LOG_LEVEL`
- `WEBHOOK_MAX_BODY_BYTES`
- `DELIVERY_MAX_ATTEMPTS`
- `DELIVERY_RETRY_BASE_DELAY_MS`
- `DELIVERY_RETRY_MAX_DELAY_MS`
- `DELIVERY_SUCCEEDED_RETENTION_DAYS`
- `DELIVERY_PROCESSING_LEASE_MS`
- `DELIVERY_DRAIN_BATCH_SIZE`

Secrets configured in `.dev.vars` or via `wrangler secret put`:

- `GITHUB_WEBHOOK_SECRET`
- `ADMIN_API_TOKEN`
- `DISCORD_WEBHOOK_URL`

## Operational Behavior

- Accepted supported deliveries are persisted before `POST /webhook` returns `202`.
- Duplicate delivery IDs return `200` and do not resend notifications.
- Immediate processing is kicked off with `ctx.waitUntil()`.
- Durable retries and stale lease recovery are driven by D1 state plus the cron trigger in [`wrangler.jsonc`](/home/ayagmar/Projects/Personal/repo-pulse/wrangler.jsonc).
- Retention pruning runs on the cron-driven drain path instead of every accepted webhook.

## Admin Endpoints

- `GET /admin/status`
- `GET /admin/health`
- `GET /admin/deliveries`
- `GET /admin/deliveries/:deliveryId`
- `POST /admin/deliveries/:deliveryId/retry`
- `GET /admin/openapi.json`
- `GET /admin/docs`

All `/admin/*` endpoints require `Authorization: Bearer <ADMIN_API_TOKEN>`.

Notes:

- `GET /admin/openapi.json` is the authenticated OpenAPI document.
- `GET /admin/docs` serves Swagger UI and is also authenticated.

## Verification Commands

```bash
npm run typegen
npm run typecheck
npm run lint
npm run check:ci
npm run test
npm run knip
npm run build
```
