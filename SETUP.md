# Setup Guide

Deploy Repo Pulse from a clone with Wrangler. The [Deploy to Cloudflare button](README.md#deploy)
does the same without a local checkout; the GitHub App and webhook steps below apply to both.

## Prerequisites

- Cloudflare account with Workers and D1 enabled
- A GitHub account that owns the repositories, to create the GitHub App; or repository admin access and the [GitHub CLI](https://cli.github.com/) for repository webhooks
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

The binding name must remain `DB`: the migration scripts refer to the database by its
binding, so `database_name` can change freely. Regenerate types after changing bindings.

## Secrets and deploy

Generate the webhook secret into a file first. Neither GitHub nor Cloudflare shows it
again, and every repository webhook needs the same value:

```bash
mkdir -p ~/.config/repo-pulse
(umask 077; openssl rand -hex 32 | tr -d '\n' > ~/.config/repo-pulse/webhook-secret)
```

These commands affect the deployed Worker. `wrangler secret put` deploys a new version;
use `wrangler versions secret put` instead if the secret change must be staged.

```bash
npm exec -- wrangler secret put GITHUB_WEBHOOK_SECRET < ~/.config/repo-pulse/webhook-secret
npm exec -- wrangler secret put ADMIN_API_TOKEN
npm exec -- wrangler secret put DISCORD_WEBHOOK_URL
npm run deploy
```

`npm run deploy` applies pending D1 migrations, then deploys the Worker. Source maps and
sampled traces are enabled in Wrangler configuration; deployment is required for those
settings to reach production.

## GitHub App

The recommended way to receive events: one App, installed on all your repositories,
covers new ones without setup, and its short-lived installation token replaces
`GITHUB_TOKEN`. Deploy first with `GITHUB_WEBHOOK_SOURCES` set to `repository` (the
committed value), so App deliveries are acknowledged and ignored until the App is
checked.

1. Open **Settings → Developer settings → GitHub Apps → New GitHub App**.
   - Webhook URL: `https://<your-worker>.workers.dev/webhook`
   - Webhook secret: paste it with `wl-copy < ~/.config/repo-pulse/webhook-secret`
     (macOS: `pbcopy`), the same secret the Worker has
   - Repository permissions, all **Read-only**: Metadata, Contents, Issues,
     Pull requests, Administration
   - Subscribe to events: Star, Fork, Issues, Pull request, Push, Release
   - Where can this GitHub App be installed: **Only on this account**
2. Note the App ID. Generate a private key; GitHub downloads it as PKCS#1, and the
   Worker needs PKCS#8:

   ```bash
   (umask 077; openssl pkcs8 -topk8 -nocrypt -in ~/Downloads/<app>.private-key.pem \
     -out ~/.config/repo-pulse/app-key.pkcs8.pem)
   ```

3. **Install App → All repositories.** The installation ID is the number at the end
   of the installation's settings URL.
4. Set the secrets. The key comes from the file; type the two IDs at the prompts:

   ```bash
   npm exec -- wrangler secret put GITHUB_APP_PRIVATE_KEY < ~/.config/repo-pulse/app-key.pkcs8.pem
   npm exec -- wrangler secret put GITHUB_APP_ID
   npm exec -- wrangler secret put GITHUB_APP_INSTALLATION_ID
   ```

   Then delete both key files. GitHub can issue a new key at any time.
5. In the App's **Advanced → Recent Deliveries**, deliveries should answer `200` with
   `ignored`. Open one repository event and check that `installation.id` in its payload
   is the installation ID you set.
6. Switch `GITHUB_WEBHOOK_SOURCES` as [docs/operations.md](docs/operations.md#moving-between-repository-webhooks-and-the-github-app)
   describes: to `repository,app` first, and to `app` after the overlap.

The App's token asks for Metadata, Contents and Administration read only. A leaked App
key gives read access to every repository the App is installed on, private ones
included; to rotate it, generate a new key in the App, convert it, `wrangler secret put
GITHUB_APP_PRIVATE_KEY`, deploy, check a digest, then delete the old key in GitHub.

## Repository webhooks

The alternative to the App: one webhook per repository. With the
[GitHub CLI](https://cli.github.com/) logged in as a repository admin, subscribe
repositories in one command. Repositories that already send to the URL are skipped:

```bash
just subscribe https://<your-worker>.workers.dev owner/repo owner/other-repo
```

The script (`scripts/subscribe.sh`) reads the secret from
`~/.config/repo-pulse/webhook-secret`, or from `REPO_PULSE_SECRET_FILE` when set.

To add one by hand, open the repository's **Settings → Webhooks → Add webhook**:

- Payload URL: `https://<your-worker>.workers.dev/webhook`
- Content type: `application/json`
- Secret: the value of `GITHUB_WEBHOOK_SECRET`
- Events: Stars, Issues, Pull requests, Forks, Pushes, Releases

GitHub pings each new webhook: `200` means the secret matches, `401` means it does not.
Supported deliveries return `202` after persistence, not after Discord delivery. Duplicate
retained delivery IDs return `200`; unsupported events are acknowledged and ignored.

## Verify

```bash
npm run verify:ci
npm run audit:full
```

Node tests use disposable SQLite data and controlled network fakes. `test:workers`
runs separately in local workerd with real simulated D1 bindings, no remote bindings,
and test-only credentials. `benchmark:ledger` is an opt-in local SQLite measurement.

After deployment, send your admin token to curl through stdin, so it stays out of the
process list and shell history (`printf` is a shell builtin):

```bash
printf 'header = "Authorization: Bearer %s"\n' "$ADMIN_API_TOKEN" |
  curl --config - https://<your-worker>.workers.dev/admin/status
printf 'header = "Authorization: Bearer %s"\n' "$ADMIN_API_TOKEN" |
  curl --config - https://<your-worker>.workers.dev/admin/health
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
