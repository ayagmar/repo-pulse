# Setup Guide

Deploy Repo Pulse on Cloudflare Workers with D1, GitHub webhooks, and Discord notifications.

## Prerequisites

- Cloudflare account with Workers and D1 enabled
- GitHub repository admin access
- Discord webhook URL for the destination channel
- Node 24 LTS recommended (`nvm use`); supported ranges are in `package.json`
- npm 12.2.0 recommended (`npm install --global npm@12.2.0`)

The project uses npm, not Bun. Wrangler is a project dependency; use npm scripts or
`npm exec -- wrangler ...` rather than an unrelated global version.

```bash
npm ci
npm exec -- wrangler --version
```

npm 12 restricts dependency install scripts. `allowScripts` approves the installed
esbuild and workerd versions and denies the unnecessary SQLite source-build script
(the package ships prebuilt binaries). Review approvals when upgrading these packages;
do not approve all dependency scripts indiscriminately.

## Local development

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run typegen
npm run dev
```

Fill in `.dev.vars` with local test secrets. Use `NODE_ENV=development` and
`LOG_LEVEL=debug` for development; the committed Wrangler variables default to production.
Keep `.dev.vars` out of git. Use a test Discord channel, not your production channel.

Wrangler serves `http://127.0.0.1:8787`. The local D1 database is separate from remote data.

## Account and database

```bash
npm exec -- wrangler login
npm exec -- wrangler whoami
```

Confirm the intended account before any remote operation. The committed
[`wrangler.jsonc`](wrangler.jsonc) contains a concrete database ID. If deploying into
another account, create your own database and update that ID first:

```bash
npm exec -- wrangler d1 create repo-pulse
```

The binding name must remain `DB`. If changing `database_name`, update the migration
scripts in `package.json` too. Regenerate types after changing bindings.

## Secrets and deploy

These commands affect the deployed Worker. `wrangler secret put` deploys a new version;
use `wrangler versions secret put` instead if the secret change must be staged.

```bash
npm exec -- wrangler secret put GITHUB_WEBHOOK_SECRET
npm exec -- wrangler secret put ADMIN_API_TOKEN
npm exec -- wrangler secret put DISCORD_WEBHOOK_URL
npm run db:migrate:remote
npm run deploy
```

Migration `0003` adds two delivery-list indexes without deleting data. Apply migrations
before deploying the optimized query. Source maps and sampled traces are enabled in
Wrangler configuration; deployment is required for those settings to reach production.

## GitHub webhooks

For each repository, open **Settings → Webhooks → Add webhook**:

- Payload URL: `https://<your-worker>.workers.dev/webhook`
- Content type: `application/json`
- Secret: the value of `GITHUB_WEBHOOK_SECRET`
- Events: Stars, Issues, Pull requests, Forks, Pushes, Releases

Use GitHub's delivery tester against a test destination first. Supported deliveries
return `202` after persistence, not after Discord delivery. Duplicate retained delivery
IDs return `200`; unsupported events are acknowledged and ignored.

## Verify

```bash
npm run verify:ci
npm run audit:full
```

Node tests use disposable SQLite data and controlled network fakes. `test:workers`
runs separately in local workerd with real simulated D1 bindings, no remote bindings,
and test-only credentials. `benchmark:ledger` is an opt-in local SQLite measurement.

After deployment, use your admin token through a protected environment variable:

```bash
curl -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  https://<your-worker>.workers.dev/admin/status
curl -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  https://<your-worker>.workers.dev/admin/health
```

`/admin/docs` and `/admin/openapi.json` also require the bearer header. Opening the docs
URL directly in a browser without an authentication header will return `401`.

## Troubleshooting

- **Missing environment variable:** configure the required local or deployed secrets.
- **D1 error:** verify the account, database binding, and applied migrations.
- **Webhook 401:** check the shared secret and exact request-body signature.
- **Webhook 400:** check required headers and supported event payload fields.
- **No notification providers:** configure a valid Discord webhook URL.
- **No retries:** check the every-minute cron trigger and delivery statuses.
- **Repeated sends after interruption:** provider sends are at-least-once; see
  [architecture guarantees](ARCHITECTURE.md).

Further guidance: [operations](docs/operations.md) and [production profiling](docs/profiling.md).
