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
- `DELIVERY_DRAIN_BATCH_SIZE`: deliveries sent per drain pass. The cron caps this at 5, or 4 during webhook recovery. Keep the setting at 5 or below on Workers Free for the immediate webhook drain too.
- `DIGEST_TIME_ZONE`: IANA time zone for the daily digest, such as `Europe/Paris`. Defaults to `UTC`.
- `DIGEST_HOUR`: local hour, 0 to 23, when the daily digest, and on Mondays the weekly one, is posted. Defaults to `9`.

Secrets configured in `.dev.vars` or via `wrangler secret put`:

- `GITHUB_WEBHOOK_SECRET`
- `ADMIN_API_TOKEN`
- `DISCORD_WEBHOOK_URL`
- `GITHUB_PUBLIC_TOKEN` (optional): a fine-grained token with access to public repositories only and no permissions. `/public/feed` sends it with its visibility lookups to get GitHub's authenticated rate limit. It must not be able to read private repositories.
- `PEOPLE_IGNORED_LOGINS` (optional): comma-separated GitHub logins, compared case-insensitively, that alerts never describe as new or returning and the weekly digest never lists, such as your other accounts or a collaborator. Repository owners and `[bot]` logins are always left out. Set it at the prompt with `npm exec -- wrangler secret put PEOPLE_IGNORED_LOGINS`, entering something like `<your-other-login>,<collaborator-login>`.
- `DISCORD_ACTIONS` (optional): `on` puts Close and Label buttons on issue alerts and opens `POST /discord/interactions`; `off` or unset leaves alerts as they were and the route at `404`. `on` needs the three `DISCORD_*` secrets below and `DISCORD_WEBHOOK_URL`; anything missing or malformed is a configuration error. It is a secret, not a `wrangler.jsonc` variable, so a fresh deployment, the Deploy button's included, starts with it unset, and `wrangler deploy` keeps it once set. Set it with `printf on | npm exec -- wrangler secret put DISCORD_ACTIONS` after the [Discord actions](#discord-actions) setup.
- `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_ALLOWED_USER_IDS` (only with `DISCORD_ACTIONS=on`): the Discord application's id, its Ed25519 public key (64 hex characters, from the Developer Portal), and the comma-separated Discord user ids allowed to use the buttons. Set them at the prompt. They are read only when `DISCORD_ACTIONS` is `on`, so they can be set before it is.
- `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY` (required): the GitHub App. The key is the App's private key converted to PKCS#8 (`openssl pkcs8 -topk8 -nocrypt`); a PKCS#1 key is a configuration error. Set the key from its file and the IDs at the prompt, never as command-line arguments. A missing one fails every request, so stage them with `wrangler versions secret put` and deploy once.

Credentials and owner identifiers are never committed. `npm run check:secrets`, part of `npm run verify` and CI, fails on a private key, a GitHub token, a Discord webhook URL, or a value for one of these names that is not a placeholder, in any tracked file, and on any of these names in `wrangler.jsonc`. It does not catch an unlabelled random string.

## Operational Behavior

- Accepted supported deliveries are persisted before `POST /webhook` returns `202`.
- A delivery ID already in the event history returns `200` without enqueueing new work, also after its delivery row was pruned.
- A retry resends only to the providers that have not accepted the delivery yet.
- Provider sends remain at-least-once: interruption between sending and persisting success can repeat a send.
- The every-minute cron can send the daily digest, and on Mondays the weekly one, from `DIGEST_HOUR` until the end of that local date. A catch-up uses the original activity and response-time windows. Its "Waiting on you" section shows the thread state at sending, not at the digest hour. A digest still unsent at local midnight is dropped. If a clock change moves the configured hour into the next local date, that is when its send window opens; the new day's digest takes priority once it is due.
- A digest starting more than ten minutes after its hour waits for any recovery request made in the last 20 minutes. It also waits for a recovery scan to checkpoint after it first claims a wait, or 20 minutes from that claim if there is no checkpoint. The last hour before local midnight bypasses both checks. The checks run inside the digest claim query, before reading the event history.
- The star radar runs in the cron at minutes 5, 15, 25, and so on (UTC). It attempts only the strongest candidate per run. If another invocation takes that claim first, the remaining candidates wait until the next check. Discord rejections can retry at the next eligible check; a time-out or other transport failure keeps the claim.
- The cron budget counts D1 requests against the Workers Free plan's 50 subrequests. A busy Monday run that drains 5 deliveries (at most 23, including one outcome-write retry), sends the daily digest (up to 8, two of them GitHub) and the weekly one (up to 6, one of them for the week's people), reads the threads both digests list as waiting (1), sends a star alert (up to 8, two of them GitHub), and mints a GitHub App installation token (1): 47. These bounds include a retry of each sent marker. If the shared token mint fails, the run makes at most 43 and posts without GitHub details. The radar shares a run with a digest when a digest is retried at minute 5, or when the digest hour falls at minute 5 UTC, as 09:00 in Asia/Kathmandu does at 03:15. On recovery minutes there is no radar: allow 19 subrequests to drain up to four deliveries, 16 for the two digests including their shared reads and token, and 14 for recovery, for at most 49. The recovery grace check shares the digest claim's subrequest. `src/__tests__/scheduled-budget.test.ts` exercises both combinations. The radar spends at most one claim request, even if its candidate list has gone stale.
- `GET /public/feed` makes up to 40 GitHub requests per response, one per repository without a visibility answer from the last 60 seconds. Without `GITHUB_PUBLIC_TOKEN`, GitHub allows 60 of them an hour per IP, and Cloudflare's egress IPs are shared, so the lookups can be rate limited; with it, 5,000 an hour for the token. A rate-limited repository is left out of the feed: it shrinks, it does not leak. Logs show `visibility.lookup_refused` with status `403` or `429` when that happens. If no repository is admitted, the feed answers `503 {"error":"visibility_unavailable"}` rather than an empty list, and signals keeps its last snapshot.
- `GET /public/feed` and `GET /public/activity` together allow 10 requests a minute per client IP and Cloudflare location (`FEED_RATE_LIMIT` in `wrangler.jsonc`), then answer `429`. signals pulls every 15 minutes. A request that misses the isolate and Cache API copies reads about 400 D1 rows, for any `limit`: the material is read once at the largest limit and shared by every `limit` for 300 seconds. `/public/activity` reads, at most once per 300 seconds per isolate or location and for any `days`, every public event of the four published types from the last 400 days, through `idx_events_public_received_at` (migration `0009`), plus one index row for `since`. Its visibility check shares the feed's 40-lookup budget per response and its 60-second answers. The Free plan allows 5 million rows a day per account.
- Digests and star alerts are at-least-once within their eligibility windows. Once a successful send is recorded, the digest is not repeated and the radar starts its 24-hour cooldown. A failed sent-marker write is retried once without reposting. If both writes fail or the Worker stops, the claim stays for one hour from claim time. Only then can it be reclaimed, and only if the digest is still due or the spike still qualifies. An ambiguous success can cause a duplicate, but not on every cron check.
- Discord transport failures leave acceptance unknown, so digests and radar keep the one-hour claim. An HTTP rejection releases a radar claim, or a digest claim within the first ten minutes after its hour. A rejected catch-up keeps the lease, limiting rebuilds to at most once an hour. An empty digest also waits an hour before rechecking. A failed release leaves the claim in effect.
- Expired leases consume the retry budget. Recovery completes interrupted deliveries if success is already on record for every configured provider, including exhausted pending rows from older releases. The bounded sweep also marks below-limit pending deliveries succeeded when all providers have receipts, without spending an attempt or drain slot. Incomplete pending rows keep their retry schedule. Exhausted deliveries without that evidence become failed; Discord may have accepted a post whose outcome never reached D1. New Discord success receipts require a created message ID; existing receipts are still honored.
- Outcome writes are fenced by processing attempt. Only failed deliveries can be atomically queued for admin retry.
- Event, digest and radar posts use Discord Execute Webhook with `wait=true`, preserving options such as `with_components`. The same request returns the created message ID. A transport failure or a `2xx` reply without a valid ID is transient with unknown acceptance and holds the existing claim or delivery lease. There is no extra request to Discord. Interaction receipts and best-effort edits of an existing message still use their separate endpoints.
- A Discord or GitHub failure is recorded and logged as a fixed message (`Discord request failed: timeout`) or as the upstream status plus the `message` field of its JSON body, up to 200 characters, with every configured secret, any GitHub token or JWT, and any URL carrying a credential replaced by `[redacted]`. A token response is never logged.
- Immediate processing is kicked off with `ctx.waitUntil()`.
- Durable retries and stale lease recovery are driven by D1 state plus the cron trigger in [`wrangler.jsonc`](../wrangler.jsonc).
- Provider attempts and the delivery outcome commit together. If the write fails, the drain retries that batch once without posting again, then stops. If both writes fail, cron recovers the lease. Retrying a batch that committed before its reply was lost does not add another attempt row.
- Only cron runs ledger maintenance. Each pass checks up to 4 expired leases, 4 exhausted pending rows and 4 previously attempted pending rows, using indexed ranges. The legacy scan cursor advances even when none of its rows can be reconciled. Retention checks up to 4 old succeeded deliveries, deletes up to 8 provider-attempt rows, and deletes a delivery only after its attempts are gone. A long attempt history can take several ticks to prune. Apply additive migration `0014` before deploying.
- Per cron tick, ledger maintenance writes at most 25 logical rows: 12 sweep transitions, 1 cursor update, and 4 delivery and 8 attempt deletes. Including claims and outcomes, the delivery drain writes at most 41 logical rows (38 on recovery minutes). These counts exclude index maintenance, which D1 also bills. The drain uses only bounded ranges or key lookups: at most 4 candidates from each sweep range, 4 parents per prune statement, 8 child candidates and one indexed receipt check per configured provider per candidate. The local D1 backlog tests check read ceilings of 250 for the sweep batch and 100 for the prune batch, including internal reads.
- The Free plan's 100,000 rows written and 5 million rows read per day are shared by all databases in the account. The delivery limits are not an account-wide quota guarantee. With one configured provider, call patterns on the other cron paths can bring the total to 50 logical writes on a radar tick or 251 on a recovery tick (the latter can add up to 207 recovery writes and 6 digest writes). The reads of a whole cron tick have no fixed cap because digest and radar read activity windows and group candidate threads or repositories before applying their result limits.

## GitHub App

### Admission

- Only the App's deliveries are admitted: `installation.id` must be a number equal to `GITHUB_APP_INSTALLATION_ID`, and `repository.private` and `repository.fork` must both be `false`. A missing, null or mistyped field rejects the delivery, so a repository webhook's, which carries no `installation`, is never admitted. Rejected deliveries are answered `200` and logged as `webhook.app_delivery_rejected` with the reason.
- `ping`, `installation` and `installation_repositories` are acknowledged with `200` once signed, with or without a repository. Installation changes are logged as `webhook.installation_changed`, with the repositories added and removed.

### Recovering failed webhook deliveries

- At minutes 0, 10, 20, 30, 40 and 50 UTC, cron probes D1 by writing a short scan lease. If D1 still refuses writes, no GitHub request is made. A successful probe is not a guarantee that quota will last through the incoming deliveries; each redelivery request also needs a durable reservation before it can go out.
- Recovery uses the existing App ID and key to sign an App JWT, not an installation token. It lists one page of up to 100 [App webhook attempts](https://docs.github.com/en/rest/apps/webhooks?apiVersion=2026-03-10#list-deliveries-for-an-app-webhook) per run, unfiltered, and asks for at most five new attempts. It follows GitHub's cursor through the last three days and starts at the head again at the end. If a page has more missing deliveries, it stays on that page for the next run. The scan cursor and GUID reservations survive restarts. Recovery can take multiple passes or fall behind if the App sends more than the scan can cover before expiry.
- A `2xx` or `OK` delivery is not a candidate, including ignored events that were acknowledged without being queued. Recovery also skips GUIDs held in the ledger or permanent event history. GitHub reuses the GUID, but the redelivery endpoint takes the original numeric attempt ID. A reservation stores the original attempt time and counts toward the limit of three requests per GUID, at least an hour apart. The next scan that sees the original can retry if GitHub still shows no successful attempt and neither D1 table holds it. This covers a lost reservation reply, a refused or timed-out POST, or a `202` whose callback failed.
- A list, signing or D1 read failure leaves the page for a later run. A stale cursor rejected with `400` or `422` resets the walk. GitHub calls time out after five seconds. On GitHub throttling, recovery stops and respects the retry headers when present, and waits at least a minute even on a secondary-limit `403` without them. The POST reservation remains subject to the same hourly retry rule. Inspect the App's Recent Deliveries and [redeliver manually](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks) if needed before GitHub's three-day limit. Automatic and manual attempts can race; the webhook still dedupes accepted events. Watch `webhook_recovery.step_failed`, `webhook_recovery.github_refused` and `webhook_recovery.requested`.
- When a webhook has a recovery reservation, its alert and indexed history use the payload's action time if valid and no later than the original GitHub attempt. Otherwise they use the original attempt time. This keeps an old event out of the current digest or radar window; a genuinely recent recovered star can still count in the radar. Recovered stars are plain alerts, never milestone claims. The actual acceptance time remains on the ledger and in the event JSON. History readers, including the public routes and digest, use the backdated history index. Already-sent or expired digests and old radar checks are not regenerated. GitHub sends no redelivery flag in the webhook itself, so a manual redelivery with no reservation uses the usual receipt-time rules.
- Deploy with additive migration `0013` applied first. It adds the scan and reservation tables and a nullable recovery-wait timestamp to `digest_sends`, without rewriting existing events, leases or claims. No new secret or GitHub App permission is needed. A rollback can leave the new schema in place.

### Installation token

- Digests and star alerts use an installation token asking for Metadata, Contents and Administration read.
- A cron run acquires the token once for the digest and the radar. If the mint fails, both go out without GitHub details, and the next run tries again.
- A minted token is kept in isolate memory until five minutes before it expires, keyed by App, installation, permissions and repositories, so it is reused only for the same request.

## Comments and reviews

Issue comment and Pull request review deliveries feed comment and review alerts and the digests' "⏳ Waiting on you" and "⏱️ Response times" (see [the system design](system-design.md#waiting-on-you)).

- Turning it on: deploy first (`npm run deploy` applies migration `0010`), then subscribe the GitHub App to **Issue comment** and **Pull request review** (App settings → Permissions & events; the Issues and Pull requests permissions it has are enough). The other order loses the first comments: the previous release answers them `200` as unsupported and does not store them.
- Until the first comment or review is recorded, the digests have no waiting section and no first-reply time; merge times are reported from the start. From then on, only what happens after that instant can make a thread wait, and only threads created after it get a first-reply time.
- The waiting list covers threads with an event received in the last 90 days, the 200 most recently active, each with at most 100 stored events, up to 2,000 events among them. Logs: `thread_activity.digest_read_failed` (the read failed; the digest went out without the sections, or was skipped if it had nothing else) and `thread_activity.threads_omitted` (`incompleteThreads`: left out because a limit cut their history; `untimedThreads`: left out of waits and first replies because an event received since activation has no GitHub time).
- Rolling back: unsubscribe the App from Issue comment and Pull request review, wait until `GET /admin/deliveries?status=pending,processing` lists no `comment.created` or `review.submitted` delivery, then deploy the previous release. It cannot format those events, so a queued one would fail. Migration `0010` stays; the previous release ignores its table and index.

## Star milestones

Each repository's milestones are celebrated once (see [the system design](system-design.md#star-milestones)). There is nothing to configure or subscribe.

- Turning it on: `npm run deploy` applies migration `0011`. Each repository's first star event after that sets where its milestones start, from the highest star count recorded or seen so far; milestones at or below it are never celebrated. That first star is a plain alert.
- Log: `event_processor.enrichment_failed` with `starMilestone: true` means the milestone tables could not be written for that star; it was accepted and posted as a plain star, and nothing of its milestone was recorded, so the next star can still celebrate it.
- Rolling back: deploy the previous release. Migration `0011` stays and is ignored. That release does not keep milestones: it titles a star whose count equals a milestone `🎉 100 stars!`, again after an unstar and restar, and never after a jump. Stars it accepts are recorded without milestone decisions, so after deploying this release again, the next star past a milestone not yet assigned here celebrates it, even if the previous release already did. A celebration still queued when you roll back (pending or retrying) posts as a plain star, and its milestone stays assigned, so it is never shown; to avoid that, wait until `GET /admin/deliveries?status=pending,processing` lists no `star.created` delivery before deploying the previous release.

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
- Rolling back: `printf off | npm exec -- wrangler secret put DISCORD_ACTIONS`. Alerts go out without buttons, buttons on earlier alerts stop working, and the route answers `404`. Migration `0008` stays; the previous release ignores its tables.

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
