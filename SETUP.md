# Setup Guide

This guide covers a clean `repo-pulse` deployment on Cloudflare Workers with D1, GitHub webhooks, and Discord notifications.

## 1. Prerequisites

- Cloudflare account with Workers and D1 enabled
- GitHub repository admin access for the repositories that will send webhooks
- Discord webhook URL for the target channel
- Node.js 22 or newer
- npm 11 or newer

This repository is npm-only. Bun is not part of the supported workflow.

Verify tooling:

```bash
node --version
npm --version
```

Wrangler is already pinned in [`package.json`](/home/ayagmar/Projects/Personal/repo-pulse/package.json), so the simplest path is to use `npm exec` or the npm scripts:

```bash
npm exec wrangler --version
```

If you want a global install anyway:

```bash
npm install -g wrangler
```

Install project dependencies:

```bash
npm ci
```

## 2. Cloudflare Account Setup

Authenticate Wrangler against the target Cloudflare account:

```bash
npm exec wrangler login
```

Confirm the active account:

```bash
npm exec wrangler whoami
```

If your organization uses multiple Cloudflare accounts, make sure you are deploying to the account that should own both the Worker and the D1 database.

## 3. D1 Database Binding

The committed migration scripts expect the D1 database name to be `repo-pulse`.

The repository currently contains a concrete `database_id` in [`wrangler.jsonc`](/home/ayagmar/Projects/Personal/repo-pulse/wrangler.jsonc).

If you are deploying this repo into a different Cloudflare account, create a new D1 database first:

```bash
npm exec wrangler d1 create repo-pulse
```

Wrangler will print a new `database_id`.

## 4. Bind D1 to the Worker

Ensure [`wrangler.jsonc`](/home/ayagmar/Projects/Personal/repo-pulse/wrangler.jsonc) points `DB` at the correct database for your account:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "repo-pulse",
    "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "migrations_dir": "migrations"
  }
]
```

Notes:

- Replace `database_id` if you are deploying to a different Cloudflare account.
- If you want a separate preview database, also set `preview_database_id`.
- If you rename the database, also update the hard-coded migration scripts in [`package.json`](/home/ayagmar/Projects/Personal/repo-pulse/package.json).

## 5. Generate Worker Types

After changing bindings, regenerate Worker types:

```bash
npm run typegen
```

This refreshes [`worker-configuration.d.ts`](/home/ayagmar/Projects/Personal/repo-pulse/worker-configuration.d.ts).

## 6. Set Secrets

Set the required Worker secrets:

```bash
npm exec wrangler secret put GITHUB_WEBHOOK_SECRET
npm exec wrangler secret put ADMIN_API_TOKEN
npm exec wrangler secret put DISCORD_WEBHOOK_URL
```

Meaning:

- `GITHUB_WEBHOOK_SECRET`: shared secret GitHub uses to sign webhook payloads
- `ADMIN_API_TOKEN`: bearer token required for `/admin/*`
- `DISCORD_WEBHOOK_URL`: Discord incoming webhook endpoint

## 7. Set Runtime Variables

The committed [`wrangler.jsonc`](/home/ayagmar/Projects/Personal/repo-pulse/wrangler.jsonc) already defines these defaults:

- `NODE_ENV=production`
- `LOG_LEVEL=info`
- `WEBHOOK_MAX_BODY_BYTES=1048576`
- retry, lease, and retention defaults for the delivery ledger

## 8. Run Migrations

Apply the remote schema:

```bash
npm run db:migrate:remote
```

For local development, apply the local D1 schema:

```bash
npm run db:migrate:local
```

## 9. Run Locally

Create the local secrets file:

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` and fill in real local values.

Recommended local overrides:

```dotenv
NODE_ENV=development
LOG_LEVEL=debug
```

The committed [`wrangler.jsonc`](/home/ayagmar/Projects/Personal/repo-pulse/wrangler.jsonc) sets `NODE_ENV=production`, so without a local override `wrangler dev` behaves like production for logging and error-detail purposes.

Start the Worker:

```bash
npm run dev
```

Equivalent direct command:

```bash
npm exec wrangler dev
```

Wrangler serves the Worker on `http://127.0.0.1:8787` by default.

Useful local verification:

```bash
npm run typegen
npm run typecheck
npm run lint
npm run check:ci
npm run test
npm run build
```

## 10. Deploy

Deploy the Worker:

```bash
npm run deploy
```

Equivalent direct command:

```bash
npm exec wrangler deploy
```

After deployment, Wrangler prints the Worker URL, typically:

```text
https://repo-pulse.<subdomain>.workers.dev
```

Endpoints:

- Webhook: `https://repo-pulse.<subdomain>.workers.dev/webhook`
- Admin: `https://repo-pulse.<subdomain>.workers.dev/admin/*`

## 11. Configure GitHub Webhooks

For each repository that should send events:

1. Open `Settings` -> `Webhooks` -> `Add webhook`.
2. Set `Payload URL` to your deployed Worker:

```text
https://repo-pulse.<subdomain>.workers.dev/webhook
```

3. Set `Content type` to `application/json`.
4. Set `Secret` to the same value stored in `GITHUB_WEBHOOK_SECRET`.
5. Select the events this service supports:

- `Stars`
- `Issues`
- `Pull requests`
- `Forks`

6. Save the webhook.
7. Use GitHub's delivery tester to send a sample event.

Notes:

- Unsupported events are acknowledged but ignored.
- Deliveries are accepted asynchronously. A `202 Accepted` response means the event was persisted and queued, not that Discord has already received it.

## 12. Discord Notification Examples

Use these screenshot references from the rollout thread to verify Discord formatting after deployment:

| Event | Discord example |
| --- | --- |
| Star notification | `Image #1` |
| Issue opened / closed | `Image #2` |
| Fork notification | `Image #3` |
| Pull request merged | `Image #4` |

## 13. Verify the Deployment

Check status:

```bash
curl -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  https://repo-pulse.<subdomain>.workers.dev/admin/status
```

Check health:

```bash
curl -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  https://repo-pulse.<subdomain>.workers.dev/admin/health
```

Open the authenticated docs:

```text
https://repo-pulse.<subdomain>.workers.dev/admin/docs
```

Remember:

- `/admin/openapi.json` is authenticated.
- `/admin/docs` is authenticated too, so opening it directly in a browser requires an auth header.

## 14. Runtime Behavior to Know Before Production

- Accepted supported deliveries are written to D1 before GitHub receives `202 Accepted`.
- Duplicate GitHub delivery IDs are deduplicated by `delivery_id`.
- Immediate processing runs in `waitUntil()`.
- Retries, stale-processing recovery, and succeeded-delivery pruning depend on the cron trigger in [`wrangler.jsonc`](/home/ayagmar/Projects/Personal/repo-pulse/wrangler.jsonc), currently every minute.

## 15. Troubleshooting

### `Missing required environment variable`

One or more required secrets were not set. Re-run:

```bash
npm exec wrangler secret put GITHUB_WEBHOOK_SECRET
npm exec wrangler secret put ADMIN_API_TOKEN
npm exec wrangler secret put DISCORD_WEBHOOK_URL
```

### `D1_ERROR` or migration failures

- Confirm [`wrangler.jsonc`](/home/ayagmar/Projects/Personal/repo-pulse/wrangler.jsonc) contains the correct `database_id`
- Confirm the database is named `repo-pulse`, or update the scripts in [`package.json`](/home/ayagmar/Projects/Personal/repo-pulse/package.json)
- Re-run `npm run db:migrate:remote`

### GitHub deliveries return `401`

- The GitHub webhook secret and `GITHUB_WEBHOOK_SECRET` do not match
- GitHub is not sending the request to `/webhook`

### GitHub deliveries return `400`

- The webhook is not using `application/json`
- Required GitHub headers are missing

### GitHub deliveries return `500 No notification providers configured`

- `DISCORD_WEBHOOK_URL` is missing or invalid

### No retry processing happens

- Confirm the cron trigger is still present in [`wrangler.jsonc`](/home/ayagmar/Projects/Personal/repo-pulse/wrangler.jsonc)
- Confirm the Worker was redeployed after the cron trigger was added
- Check `/admin/deliveries` for `processing` or `failed` rows

### Local development does not see remote D1 data

- `wrangler dev` uses the local D1 database by default
- Run `npm run db:migrate:local` before local testing
