# Setup Guide

Deploy Repo Pulse from a clone with Wrangler. The [Deploy to Cloudflare button](README.md#deploy)
does the same without a local checkout; the GitHub App steps below apply to both.

## Prerequisites

- Cloudflare account with Workers and D1 enabled
- A GitHub account that owns the repositories, to create the GitHub App
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
again, and the GitHub App needs the same value:

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
```

Then create the [GitHub App](#github-app), set its three secrets, and deploy with
`npm run deploy`. Discord actions stay off until you do the
[Discord actions](#discord-actions-optional) setup. The Worker refuses to start without
the App's secrets, or with actions on and their secrets missing.

`npm run deploy` applies pending D1 migrations, then deploys the Worker. Source maps and
sampled traces are enabled in Wrangler configuration; deployment is required for those
settings to reach production.

## GitHub App

Repo Pulse receives events only from a GitHub App. One App, installed on all your
repositories, covers new ones without setup, and its short-lived installation token
reads what digests and alerts add.

1. Open **Settings → Developer settings → GitHub Apps → New GitHub App**.
   - Webhook URL: `https://<your-worker>.workers.dev/webhook`
   - Webhook secret: paste it with `wl-copy < ~/.config/repo-pulse/webhook-secret`
     (macOS: `pbcopy`), the same secret the Worker has
   - Repository permissions, all **Read-only**: Metadata, Contents, Issues,
     Pull requests, Administration
   - Subscribe to events: Star, Fork, Issues, Issue comment, Pull request,
     Pull request review, Push, Release
   - Where can this GitHub App be installed: **Only on this account**
2. Note the App ID. Generate a private key; GitHub downloads it as PKCS#1, and the
   Worker needs PKCS#8:

   ```bash
   (umask 077; openssl pkcs8 -topk8 -nocrypt -in ~/Downloads/<app>.private-key.pem \
     -out ~/.config/repo-pulse/app-key.pkcs8.pem)
   ```

3. **Install App → All repositories.** The installation ID is the number at the end
   of the installation's settings URL.
4. Set the secrets. The key comes from the file; type the two IDs at the prompts.
   All three are required, and a missing one fails every request, so stage them as a
   new version and deploy it once:

   ```bash
   npm exec -- wrangler versions secret put GITHUB_APP_PRIVATE_KEY < ~/.config/repo-pulse/app-key.pkcs8.pem
   npm exec -- wrangler versions secret put GITHUB_APP_ID
   npm exec -- wrangler versions secret put GITHUB_APP_INSTALLATION_ID
   npm exec -- wrangler versions deploy
   ```

   Then delete both key files. GitHub can issue a new key at any time.
5. In the App's **Advanced → Recent Deliveries**, repository events should answer
   `202` (or `200` with `ignored` for a private repository or a fork). A `200` that says
   `installation.id is not GITHUB_APP_INSTALLATION_ID` means the installation ID is
   wrong; a `401` means the webhook secret does not match.

The App's token asks for Metadata, Contents and Administration read only. A leaked App
key gives read access to every repository the App is installed on, private ones
included; to rotate it, generate a new key in the App, convert it, `wrangler secret put
GITHUB_APP_PRIVATE_KEY`, deploy, check a digest, then delete the old key in GitHub.

Supported deliveries return `202` after persistence, not after Discord delivery. Duplicate
retained delivery IDs return `200`; unsupported events are acknowledged and ignored.

## Discord actions (optional)

Close and Label buttons on issue alerts, for the Discord users you list. They need the
GitHub App above and a Discord application. The Worker never holds a bot token: a bot
token is used once, to create a webhook owned by the application, then reset. Do each
step's check before the next.

1. In the GitHub App's **Permissions & events**, set **Issues** to **Read and write**
   and save. Accept the new permission on the installation (GitHub asks the owner to
   review it). The Worker asks for it only on the repository a button acts on.
2. In the [Discord Developer Portal](https://discord.com/developers/applications),
   create an application. Note its **Application ID** and **Public Key**. In Discord,
   turn on **Settings → Advanced → Developer Mode**, then right-click your name and copy
   your user ID, and right-click the alerts channel and copy its ID.
3. Under **Bot**, reset the token and copy it. Under **OAuth2 → URL Generator**, pick
   the `bot` scope and the **Manage Webhooks** permission, open the URL and add the
   application to your server. Keep the token in files only, never on a command line:

   ```bash
   (umask 077; wl-paste | tr -d '\n' > ~/.config/repo-pulse/discord-bot-token)  # macOS: pbpaste
   (umask 077; printf 'header = "Authorization: Bot %s"\n' "$(cat ~/.config/repo-pulse/discord-bot-token)" \
     > ~/.config/repo-pulse/discord-bot.curl)
   ```

   Create the webhook in the alerts channel and save its URL:

   ```bash
   (umask 077; curl -s --config ~/.config/repo-pulse/discord-bot.curl \
     -H 'Content-Type: application/json' -d '{"name":"Repo Pulse"}' \
     https://discord.com/api/v10/channels/<channel-id>/webhooks |
     jq -j '"https://discord.com/api/webhooks/\(.id)/\(.token)"' \
     > ~/.config/repo-pulse/discord-webhook-url)
   ```

   Check that the application owns it; this prints the Application ID:

   ```bash
   printf 'url = "%s"\n' "$(cat ~/.config/repo-pulse/discord-webhook-url)" |
     curl -s --config - | jq -r .application_id
   ```

   Then reset the bot token in the Developer Portal, which revokes the old one, and
   delete both bot files.
4. Set the secrets with `DISCORD_ACTIONS` still unset, and deploy. Type the application
   ID, the public key and your user ID (several are comma-separated) at the prompts:

   ```bash
   npm exec -- wrangler secret put DISCORD_WEBHOOK_URL < ~/.config/repo-pulse/discord-webhook-url
   npm exec -- wrangler secret put DISCORD_APPLICATION_ID
   npm exec -- wrangler secret put DISCORD_PUBLIC_KEY
   npm exec -- wrangler secret put DISCORD_ALLOWED_USER_IDS
   npm run deploy
   ```

   Check that alerts still post, now through the new webhook. Delete the old webhook
   once you are sure.
5. Turn the buttons on. `DISCORD_ACTIONS` is a secret rather than a `wrangler.jsonc`
   variable, so later deploys keep it; setting it deploys a new version:

   ```bash
   printf on | npm exec -- wrangler secret put DISCORD_ACTIONS
   ```

   Then, in the Developer Portal, set **Interactions Endpoint URL** to
   `https://<your-worker>.workers.dev/discord/interactions` and save. Discord saves it
   only after the Worker answers its signed test requests.
6. On a test issue, use **Label…**, then **Close**. Each should answer with a receipt only
   you see, and the alert should list both actions with Close greyed out.

To turn the buttons off, run `printf off | npm exec -- wrangler secret put DISCORD_ACTIONS`.
Alerts keep posting through the application's webhook, without buttons.

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
