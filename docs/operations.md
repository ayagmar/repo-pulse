# Operations Guide

## Prerequisites

- Node 24 LTS recommended; Node 22.22.2+ is also supported (see `package.json` engines)
- npm 12.2.0 recommended
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

Follow [SETUP.md](../SETUP.md): it covers the Deploy to Cloudflare button, deploying with
Wrangler, and subscribing repositories. `npm run deploy` applies pending D1 migrations
before deploying the Worker.

## Runtime Configuration

Worker runtime baseline in [`wrangler.jsonc`](../wrangler.jsonc):

- Preserved `compatibility_date: "2026-03-10"`
- `compatibility_flags: ["nodejs_compat"]`
- Workers logs at 100% and traces at 5% sampling
- Uploaded source maps for [on-demand production profiling](profiling.md)

Values configured in [`wrangler.jsonc`](../wrangler.jsonc):

- `NODE_ENV`
- `LOG_LEVEL`
- `WEBHOOK_MAX_BODY_BYTES`
- `DELIVERY_MAX_ATTEMPTS`
- `DELIVERY_RETRY_BASE_DELAY_MS`
- `DELIVERY_RETRY_MAX_DELAY_MS`
- `DELIVERY_SUCCEEDED_RETENTION_DAYS`
- `DELIVERY_PROCESSING_LEASE_MS`
- `DELIVERY_DRAIN_BATCH_SIZE`: deliveries sent per drain pass. On the Workers Free plan an invocation may make 50 subrequests, D1 queries included, and a delivery takes about five, so keep it at 5 or below there.
- `DIGEST_TIME_ZONE`: IANA time zone for the daily digest, such as `Europe/Paris`. Defaults to `UTC`.
- `DIGEST_HOUR`: local hour, 0 to 23, when the daily digest, and on Mondays the weekly one, is posted. Defaults to `9`.

Secrets configured in `.dev.vars` or via `wrangler secret put`:

- `GITHUB_WEBHOOK_SECRET`
- `ADMIN_API_TOKEN`
- `DISCORD_WEBHOOK_URL`

## Operational Behavior

- Accepted supported deliveries are persisted before `POST /webhook` returns `202`.
- Duplicate retained delivery IDs return `200` without enqueueing new work.
- A retry resends only to the providers that have not accepted the delivery yet.
- Provider sends remain at-least-once: interruption between sending and persisting success can repeat a send.
- The daily digest is posted by the every-minute cron during the first ten minutes after `DIGEST_HOUR`. A failed digest is retried each minute in that window. One that is still failing when it closes is skipped, and the next day's digest does not include its events.
- Digests are at-least-once in one case: a run that stops after posting but before recording the send is retried once its five-minute claim expires.
- Expired leases consume the retry budget; exhausted deliveries become failed, including legacy exhausted pending rows.
- Outcome writes are fenced by processing attempt. Only failed deliveries can be atomically queued for admin retry.
- Discord requests time out after ten seconds and are classified as transient failures.
- Immediate processing is kicked off with `ctx.waitUntil()`.
- Durable retries and stale lease recovery are driven by D1 state plus the cron trigger in [`wrangler.jsonc`](../wrangler.jsonc).
- If persisting an outcome fails, processing remains leased and cron recovers it instead of making it permanently failed.
- Retention pruning runs on the cron-driven drain path instead of every accepted webhook.

## Admin Endpoints

- `GET /admin/status`
- `GET /admin/health`
- `GET /admin/deliveries`
- `GET /admin/deliveries/:deliveryId`
- `POST /admin/deliveries/:deliveryId/retry`
- `GET /admin/events`
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
npm run test:workers
npm run knip
npm run build
```
