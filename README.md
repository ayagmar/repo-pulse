# Repo Pulse

Repo Pulse is a Cloudflare Workers + Hono service that receives GitHub webhooks, verifies the raw-body HMAC signature, normalizes supported events into a strict `RepoEvent` union, persists accepted deliveries in D1, deduplicates by GitHub delivery ID, and dispatches Discord notifications asynchronously.

## Documentation

- Architecture summary: [`ARCHITECTURE.md`](/home/ayagmar/Projects/Personal/repo-pulse/ARCHITECTURE.md)
- System design and diagrams: [`docs/system-design.md`](/home/ayagmar/Projects/Personal/repo-pulse/docs/system-design.md)
- Setup guide: [`SETUP.md`](/home/ayagmar/Projects/Personal/repo-pulse/SETUP.md)
- Operations guide: [`docs/operations.md`](/home/ayagmar/Projects/Personal/repo-pulse/docs/operations.md)

## What It Does

- accepts GitHub webhook deliveries at `POST /webhook`
- verifies `X-Hub-Signature-256` against the exact raw request body
- normalizes supported events into one internal `RepoEvent` model
- stores accepted work in D1 before returning `202 Accepted`
- deduplicates on GitHub `delivery_id`
- dispatches Discord notifications asynchronously
- exposes authenticated admin, OpenAPI, and Swagger endpoints

## Supported GitHub Events

- stars
- issues
- pull requests
- forks

Unsupported events are acknowledged and ignored.

## API Surface

Public route:

- `POST /webhook`

Admin routes, all protected by `Authorization: Bearer <ADMIN_API_TOKEN>`:

- `GET /admin/health`
- `GET /admin/status`
- `GET /admin/deliveries`
- `GET /admin/deliveries/:deliveryId`
- `POST /admin/deliveries/:deliveryId/retry`
- `GET /admin/openapi.json`
- `GET /admin/docs`

Notes:

- `/admin/openapi.json` is the authenticated OpenAPI document.
- `/admin/docs` serves Swagger UI and is also authenticated.

## Toolchain

- Runtime: Cloudflare Workers
- Framework: Hono
- Durable storage: D1
- Package manager: npm
- Local tooling: Node.js 22+ and Wrangler

`npm` is the only supported package-manager workflow for this repository. Use the committed [`package-lock.json`](/home/ayagmar/Projects/Personal/repo-pulse/package-lock.json) and the scripts from [`package.json`](/home/ayagmar/Projects/Personal/repo-pulse/package.json).

## Quick Start

1. Install dependencies:

```bash
npm ci
```

2. Create local secrets:

```bash
cp .dev.vars.example .dev.vars
```

3. Apply local migrations and generate Worker binding types:

```bash
npm run db:migrate:local
npm run typegen
```

4. Start local development:

```bash
npm run dev
```

Wrangler serves the Worker on `http://127.0.0.1:8787` by default.

## Deployment

1. Ensure [`wrangler.jsonc`](/home/ayagmar/Projects/Personal/repo-pulse/wrangler.jsonc) points at the correct D1 database for the Cloudflare account you are deploying to.

2. Set production secrets:

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

## Behavior Guarantees

- Supported deliveries are persisted in D1 before `POST /webhook` returns `202 Accepted`.
- Duplicate delivery IDs are acknowledged from the same D1 ledger and do not resend notifications.
- Request body size is enforced before JSON parsing.
- Discord delivery uses the Workers `fetch()` runtime.
- Immediate `waitUntil()` drains due deliveries after acceptance.
- Durable retries, stale-processing recovery, and pruning run from D1 state plus the cron trigger.
- Admin routes stay protected by `Authorization: Bearer <ADMIN_API_TOKEN>`.

## Main Scripts

- `npm run dev`
- `npm run build`
- `npm run deploy`
- `npm run typegen`
- `npm run db:migrate:local`
- `npm run db:migrate:remote`
- `npm run typecheck`
- `npm run lint`
- `npm run check:ci`
- `npm run test`
- `npm run verify`

## Runtime Configuration

Worker runtime baseline in [`wrangler.jsonc`](/home/ayagmar/Projects/Personal/repo-pulse/wrangler.jsonc):

- current `compatibility_date`
- `compatibility_flags: ["nodejs_compat"]`
- Workers observability logs with `head_sampling_rate: 1`
- D1 binding `DB`
- one cron trigger that runs every minute

Wrangler `vars` in [`wrangler.jsonc`](/home/ayagmar/Projects/Personal/repo-pulse/wrangler.jsonc):

- `NODE_ENV`
- `LOG_LEVEL`
- `WEBHOOK_MAX_BODY_BYTES`
- `DELIVERY_MAX_ATTEMPTS`
- `DELIVERY_RETRY_BASE_DELAY_MS`
- `DELIVERY_RETRY_MAX_DELAY_MS`
- `DELIVERY_SUCCEEDED_RETENTION_DAYS`
- `DELIVERY_PROCESSING_LEASE_MS`
- `DELIVERY_DRAIN_BATCH_SIZE`

Secrets in `.dev.vars` locally or via `wrangler secret put` remotely:

- `GITHUB_WEBHOOK_SECRET`
- `ADMIN_API_TOKEN`
- `DISCORD_WEBHOOK_URL`
