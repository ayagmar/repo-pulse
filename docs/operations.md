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
- `DISCORD_ACTIONS`: `on` puts Close and Label buttons on issue alerts and opens `POST /discord/interactions`; `off` (committed) or unset leaves alerts as they were and the route at `404`. `on` needs the three `DISCORD_*` secrets below and `DISCORD_WEBHOOK_URL`; anything missing or malformed is a configuration error. See [Discord actions](#discord-actions).

Secrets configured in `.dev.vars` or via `wrangler secret put`:

- `GITHUB_WEBHOOK_SECRET`
- `ADMIN_API_TOKEN`
- `DISCORD_WEBHOOK_URL`
- `GITHUB_PUBLIC_TOKEN` (optional): a fine-grained token with access to public repositories only and no permissions. `/public/feed` sends it with its visibility lookups to get GitHub's authenticated rate limit. It must not be able to read private repositories.
- `PEOPLE_IGNORED_LOGINS` (optional): comma-separated GitHub logins, compared case-insensitively, that alerts never describe as new or returning and the weekly digest never lists, such as your other accounts or a collaborator. Repository owners and `[bot]` logins are always left out. Set it at the prompt with `npm exec -- wrangler secret put PEOPLE_IGNORED_LOGINS`, entering something like `<your-other-login>,<collaborator-login>`.
- `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_ALLOWED_USER_IDS` (only with `DISCORD_ACTIONS=on`): the Discord application's id, its Ed25519 public key (64 hex characters, from the Developer Portal), and the comma-separated Discord user ids allowed to use the buttons. Set them at the prompt. They are read only when `DISCORD_ACTIONS` is `on`, so they can be set before it is.
- `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY` (required): the GitHub App. The key is the App's private key converted to PKCS#8 (`openssl pkcs8 -topk8 -nocrypt`); a PKCS#1 key is a configuration error. Set the key from its file and the IDs at the prompt, never as command-line arguments. A missing one fails every request, so stage them with `wrangler versions secret put` and deploy once.

Credentials and owner identifiers are never committed. `npm run check:secrets`, part of `npm run verify` and CI, fails on a private key, a GitHub token, a Discord webhook URL, or a value for one of these names that is not a placeholder, in any tracked file, and on any of these names in `wrangler.jsonc`. It does not catch an unlabelled random string.

## Operational Behavior

- Accepted supported deliveries are persisted before `POST /webhook` returns `202`.
- Duplicate retained delivery IDs return `200` without enqueueing new work.
- A retry resends only to the providers that have not accepted the delivery yet.
- Provider sends remain at-least-once: interruption between sending and persisting success can repeat a send.
- The daily digest is posted by the every-minute cron during the first ten minutes after `DIGEST_HOUR`. A failed digest is retried each minute in that window. One that is still failing when it closes is skipped, and the next day's digest does not include its events.
- The star radar runs in the cron at minutes 5, 15, 25, and so on (UTC). It sends at most one alert per run; another spiking repository is alerted at the next run. A failed alert is retried at the next run.
- One cron run stays within the Workers Free plan's 50 subrequests, D1 queries included. The worst case is a Monday run that drains 5 deliveries (27), sends the daily digest (7, two of them GitHub) and the weekly one (5, one of them for the week's people), and a star alert (7, two of them GitHub), and mints a GitHub App installation token (1): 47. Without a cached token, the digest and the alert share one mint; if it fails, the run makes 43 and posts without GitHub details. The radar shares a run with a digest when a digest is retried at minute 5, or when the digest hour falls at minute 5 UTC, as 09:00 in Asia/Kathmandu does at 03:15. `src/__tests__/scheduled-budget.test.ts` runs this worst case and fails above 50; check it before adding work to the cron.
- `GET /public/feed` makes up to 40 GitHub requests per response, one per repository without a visibility answer from the last 60 seconds. Without `GITHUB_PUBLIC_TOKEN`, GitHub allows 60 of them an hour per IP, and Cloudflare's egress IPs are shared, so the lookups can be rate limited; with it, 5,000 an hour for the token. A rate-limited repository is left out of the feed: it shrinks, it does not leak. Logs show `visibility.lookup_refused` with status `403` or `429` when that happens. If no repository is admitted, the feed answers `503 {"error":"visibility_unavailable"}` rather than an empty list, and signals keeps its last snapshot.
- `GET /public/feed` and `GET /public/activity` together allow 10 requests a minute per client IP and Cloudflare location (`FEED_RATE_LIMIT` in `wrangler.jsonc`), then answer `429`. signals pulls every 15 minutes. A request that misses the isolate and Cache API copies reads about 400 D1 rows, for any `limit`: the material is read once at the largest limit and shared by every `limit` for 300 seconds. `/public/activity` reads, at most once per 300 seconds per isolate or location and for any `days`, every public event of the four published types from the last 400 days, through `idx_events_public_received_at` (migration `0009`), plus one index row for `since`. Its visibility check shares the feed's 40-lookup budget per response and its 60-second answers. The Free plan allows 5 million rows a day per account.
- Star alerts are at-least-once in the same way as digests: a check that stops after posting but before recording it is repeated at the next check.
- Digests are at-least-once in one case: a run that stops after posting but before recording the send is retried once its five-minute claim expires.
- Expired leases consume the retry budget; exhausted deliveries become failed, including legacy exhausted pending rows.
- Outcome writes are fenced by processing attempt. Only failed deliveries can be atomically queued for admin retry.
- Discord requests time out after ten seconds and are classified as transient failures.
- A Discord or GitHub failure is recorded and logged as a fixed message (`Discord request failed: timeout`) or as the upstream status plus the `message` field of its JSON body, up to 200 characters, with every configured secret, any GitHub token or JWT, and any URL carrying a credential replaced by `[redacted]`. A token response is never logged.
- Immediate processing is kicked off with `ctx.waitUntil()`.
- Durable retries and stale lease recovery are driven by D1 state plus the cron trigger in [`wrangler.jsonc`](../wrangler.jsonc).
- If persisting an outcome fails, processing remains leased and cron recovers it instead of making it permanently failed.
- Retention pruning runs on the cron-driven drain path instead of every accepted webhook.

## GitHub App

### Admission

- Only the App's deliveries are admitted: `installation.id` must be a number equal to `GITHUB_APP_INSTALLATION_ID`, and `repository.private` and `repository.fork` must both be `false`. A missing, null or mistyped field rejects the delivery, so a repository webhook's, which carries no `installation`, is never admitted. Rejected deliveries are answered `200` and logged as `webhook.app_delivery_rejected` with the reason.
- `ping`, `installation` and `installation_repositories` are acknowledged with `200` once signed, with or without a repository. Installation changes are logged as `webhook.installation_changed`, with the repositories added and removed.

### Installation token

- Digests and star alerts use an installation token asking for Metadata, Contents and Administration read.
- A cron run acquires the token once for the digest and the radar. If the mint fails, both go out without GitHub details, and the next run tries again.
- A minted token is kept in isolate memory until five minutes before it expires, keyed by App, installation, permissions and repositories, so it is reused only for the same request.

## Discord actions

With `DISCORD_ACTIONS=on`, issue-opened alerts carry **Close** and **Label…** buttons that only the users in `DISCORD_ALLOWED_USER_IDS` can use. [SETUP.md](../SETUP.md#discord-actions-optional) covers the Discord application and webhook; [the system design](system-design.md#discord-actions) covers the request checks and the work behind a click.

- `DISCORD_WEBHOOK_URL` must be a webhook created by the Discord application. Discord refuses buttons sent through a webhook made in its UI, and the issue alert then fails permanently. Switch the webhook first, with `DISCORD_ACTIONS` still `off`.
- `POST /discord/interactions` allows 30 requests a minute per client IP and Cloudflare location (`DISCORD_RATE_LIMIT` in `wrangler.jsonc`), then answers `429`.
- Both actions are idempotent on GitHub, so clicking again is always safe. A replayed request acts at most once.
- Buttons act only on a repository recorded as public whose public lookup says, at the click, that it is public and not a fork, with the same id. Anything else, including no answer from GitHub, gets the receipt `Nothing done: GitHub does not confirm owner/repo is public and not a fork right now.` and `discord_action.not_eligible` in the logs. The lookup uses `GITHUB_PUBLIC_TOKEN` when set, else no token, so it shares GitHub's 60-an-hour unauthenticated limit with the public feed when that token is unset.
- The clicker gets a receipt only they can see: `✅ Closed issue #12`, `🏷️ Labeled issue #12: bug, ui`, or `❌ Could not close issue #12: GitHub request failed with 403: …`. The outcome is stored in `discord_actions`, one row per alert and action, replaced by each attempt except that a failure never replaces a success.
- The alert is then edited to list who did what, with Close disabled once the issue is closed. The edit is best effort: a failed edit, or two actions editing at once, is logged as `discord_action.edit_failed` and not retried. The next action on that alert rebuilds the message from every stored outcome.
- If the Worker stops after acknowledging a click, there is no receipt and the message is unchanged; click again.
- Logs: `discord_action.not_eligible`, `discord_action.github_failed`, `discord_action.receipt_failed`, `discord_action.edit_failed`, `discord_action.outcome_not_recorded`, `discord_action.failed` (D1 before the GitHub call) and `discord_action.replayed`. Interaction tokens, the webhook URL and installation tokens never appear in them, in receipts or in `discord_actions`.
- Rolling back: set `DISCORD_ACTIONS` to `off` in `wrangler.jsonc` and deploy. Alerts go out without buttons, buttons on earlier alerts stop working, and the route answers `404`. Migration `0008` stays; the previous release ignores its tables.

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
npm run check:secrets
npm run typegen
npm run typecheck
npm run lint
npm run check:ci
npm run test
npm run test:workers
npm run knip
npm run build
```
