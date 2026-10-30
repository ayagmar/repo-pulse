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
- `GITHUB_WEBHOOK_SOURCES`: the webhook deliveries admitted, a comma-separated list of `repository` (per-repository webhooks) and `app` (the GitHub App). Unset means `repository`; an empty or unknown entry, or `app` without the App's three secrets, is a configuration error. Change it in `wrangler.jsonc` and deploy: a value set in the dashboard is replaced by the next `wrangler deploy`.
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
- `GITHUB_PUBLIC_TOKEN` (optional): a fine-grained token with access to public repositories only and no permissions. `/public/feed` sends it with its visibility lookups to get GitHub's authenticated rate limit. It must not be able to read private repositories.
- `GITHUB_TOKEN` (optional): a fine-grained token with read-only access to your repositories, with **Contents: read** and **Administration: read**. The daily digest uses it to list repositories with commits since their latest release. Star alerts use it for stargazer follower counts and traffic referrers, which need **Administration: read**. Ignored when the GitHub App is configured.
- `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY` (optional, all three or none): the GitHub App. The key is the App's private key converted to PKCS#8 (`openssl pkcs8 -topk8 -nocrypt`); a PKCS#1 key is a configuration error. Set the key from its file and the IDs at the prompt, never as command-line arguments. One or two of the three is a configuration error that fails every request, so stage them with `wrangler versions secret put` and deploy once.

Credentials and owner identifiers are never committed. `npm run check:secrets`, part of `npm run verify` and CI, fails on a private key, a GitHub token, a Discord webhook URL, or a value for one of these names that is not a placeholder, in any tracked file, and on any of these names in `wrangler.jsonc`. It does not catch an unlabelled random string.

## Operational Behavior

- Accepted supported deliveries are persisted before `POST /webhook` returns `202`.
- Duplicate retained delivery IDs return `200` without enqueueing new work.
- A retry resends only to the providers that have not accepted the delivery yet.
- Provider sends remain at-least-once: interruption between sending and persisting success can repeat a send.
- The daily digest is posted by the every-minute cron during the first ten minutes after `DIGEST_HOUR`. A failed digest is retried each minute in that window. One that is still failing when it closes is skipped, and the next day's digest does not include its events.
- The star radar runs in the cron at minutes 5, 15, 25, and so on (UTC). It sends at most one alert per run; another spiking repository is alerted at the next run. A failed alert is retried at the next run.
- One cron run stays within the Workers Free plan's 50 subrequests, D1 queries included. The worst case is a Monday run that drains 5 deliveries (27), sends the daily digest (7, two of them GitHub) and the weekly one (4), and a star alert (7, two of them GitHub), and mints a GitHub App installation token (1): 46. Without a cached token, the digest and the alert share one mint; if it fails, the run makes 42 and posts without GitHub details. The radar shares a run with a digest when a digest is retried at minute 5, or when the digest hour falls at minute 5 UTC, as 09:00 in Asia/Kathmandu does at 03:15. `src/__tests__/scheduled-budget.test.ts` runs this worst case and fails above 50; check it before adding work to the cron.
- `GET /public/feed` makes up to 40 GitHub requests per response, one per repository without a visibility answer from the last 60 seconds. Without `GITHUB_PUBLIC_TOKEN`, GitHub allows 60 of them an hour per IP, and Cloudflare's egress IPs are shared, so the lookups can be rate limited; with it, 5,000 an hour for the token. A rate-limited repository is left out of the feed: it shrinks, it does not leak. Logs show `visibility.lookup_refused` with status `403` or `429` when that happens. If no repository is admitted, the feed answers `503 {"error":"visibility_unavailable"}` rather than an empty list, and signals keeps its last snapshot.
- `GET /public/feed` allows 10 requests a minute per client IP and Cloudflare location (`FEED_RATE_LIMIT` in `wrangler.jsonc`), then answers `429`. signals pulls every 15 minutes. A request that misses the isolate and Cache API copies reads about 400 D1 rows; the Free plan allows 5 million a day per account.
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

- A delivery that carries `installation` comes from the App; any other is a repository webhook's. One whose source is not in `GITHUB_WEBHOOK_SOURCES` is answered `200` and ignored.
- A repository webhook's delivery is processed as before.
- An App delivery is admitted only when `installation.id` is a number equal to `GITHUB_APP_INSTALLATION_ID`, and `repository.private` and `repository.fork` are both `false`. A missing, null or mistyped field rejects it. Rejected deliveries are answered `200` and logged as `webhook.app_delivery_rejected` with the reason.
- `ping`, `installation` and `installation_repositories` are acknowledged with `200` once signed, from either source and with or without a repository. Installation changes are logged as `webhook.installation_changed`, with the repositories added and removed.

### Installation token

- With the App configured, digests and star alerts use an installation token asking for Metadata, Contents and Administration read; `GITHUB_TOKEN` is ignored.
- A cron run acquires the token once for the digest and the radar. If the mint fails, both go out without GitHub details, and the next run tries again.
- A minted token is kept in isolate memory until five minutes before it expires, keyed by App, installation, permissions and repositories, so it is reused only for the same request.

### Moving between repository webhooks and the GitHub App

Never switch from one source to the other directly. Add the new source, wait for the overlap, then remove the old one:

1. Set `GITHUB_WEBHOOK_SOURCES` to `repository,app` in `wrangler.jsonc` and deploy. Note the time S. During the overlap both sources are admitted, so an event can be posted twice.
2. After the overlap, 10 minutes by default, set `app` and deploy. Note the time R.
3. Check the overlap: list the App's deliveries (`GET /app/hook/deliveries`, as the App) and each repository webhook's (`gh api repos/<owner>/<repo>/hooks/<id>/deliveries`) from S minus the overlap to R plus the overlap. An event is lost only if its two copies (same event, action and repository) arrived further apart than the overlap; report any such pair.
4. Once the App has run for a while, remove the repository webhooks with `just unsubscribe --dry-run <worker-url> owner/repo …`, then without `--dry-run`. Keep the inventory file it writes.

Why nothing is dropped: adding a source cannot drop an event. When a source is removed at R, the other has been admitted since S, so an event is lost only when its copy from the remaining source arrived before S and its copy from the removed source after R: two copies of one event more than R − S apart. Workers still running the previous version after a deploy only extend the time the previous setting applies, which the overlap absorbs.

### Rolling back to repository webhooks

Keep `app` admitted until every repository the App covers has a working webhook. The removed-hook inventory is not enough: repositories created while the App was active, or never hooked, are in no inventory.

1. List the public, non-fork, non-archived repositories the installation covers:

   ```bash
   gh api --paginate user/installations/<installation-id>/repositories \
     --jq '.repositories[] | select(.private == false and .fork == false and .archived == false) | .full_name' |
     sort > covered.txt
   ```

   If GitHub refuses that call for the CLI's token, the App is installed on all your repositories, so this lists the same set: `gh repo list <owner> --limit 1000 --visibility public --source --no-archived --json nameWithOwner --jq '.[].nameWithOwner' | sort > covered.txt`. Archived repositories cannot take a webhook; their stars are no longer posted after the rollback.
2. Add the missing webhooks while `app` is still admitted: `just subscribe <worker-url> $(cat covered.txt)`. It skips any repository that already has a hook at that URL, even an inactive or incomplete one, so then run `just check-coverage --repair <worker-url> covered.txt`: it sets each matching hook that is inactive or misses events to active with the six events, never touching hooks at other URLs or reading the secret.
3. Check coverage with `just check-coverage <worker-url> covered.txt`. A repository is covered only when a hook at exactly `<worker-url>/webhook` is active, subscribes to fork, issues, pull_request, push, release and star (or to everything), and answers a ping sent now with `200`. An earlier response does not count: a hook whose last delivery answered `202` is healthy, and one whose last answer was `200` may since have been disabled. It prints one line per uncovered repository, with the reason (`no hook`, `inactive`, `missing events: …`, `ping <status>`), and exits `1`; it must print nothing and exit `0`. The Worker acknowledges pings whatever the sources.
4. Only then set `repository,app`, deploy, wait the overlap, run the check again, set `repository`, deploy. Check that a star posts once.

Never set `repository` alone while the check fails.

### Removing the App

Only after a rollback has left `GITHUB_WEBHOOK_SOURCES` at `repository` and the coverage check passed. One or two of the three App secrets is a configuration error that fails every request, repository webhooks included, so stage the deletions as one new version and deploy it once:

```bash
npm exec -- wrangler versions secret delete GITHUB_APP_PRIVATE_KEY
npm exec -- wrangler versions secret delete GITHUB_APP_ID
npm exec -- wrangler versions secret delete GITHUB_APP_INSTALLATION_ID
npm exec -- wrangler versions secret put GITHUB_TOKEN   # optional, for digest details; at the prompt
npm exec -- wrangler versions deploy                    # the newest version, 100%
```

Then check `/admin/health` answers `200` and a star posts once, and uninstall the App in GitHub.

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
