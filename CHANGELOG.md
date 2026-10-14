# Changelog

## Unreleased

- Permanent event history: every accepted event is kept in a new `events` D1 table, which
  is never pruned. Migration `0004` backfills the deliveries still in the ledger and marks
  them private, because they were stored without repository visibility.
- Events now record whether their repository is private.
- `GET /admin/events` lists the 50 most recent events.
- Daily digest: at 09:00 in `DIGEST_TIME_ZONE` (`DIGEST_HOUR` sets the hour), one message
  sums up the previous day per repository. Days without activity get none. Migration
  `0005` adds the `digest_sends` table, where each provider claims a digest before
  posting, so overlapping cron runs post it once.
- Weekly digest: on Mondays at the digest hour, a second message sums up the past seven
  days per repository and lists the latest merged pull requests.
- With an optional `GITHUB_TOKEN`, the daily digest lists repositories with commits on the
  default branch since their latest release.
- Star radar: a repository starred by at least 5 people in 3 hours, and 4 times its usual
  rate over the previous two weeks, is announced at most once a day. With `GITHUB_TOKEN`
  the alert lists notable new stargazers and top referrers. Migration `0006` adds the
  `radar_alerts` table and an index on events by type and time.
- A star that brings a repository to 10, 25, 50, 100, 250, 500, 1,000, 2,500, 5,000, or a
  multiple of 10,000 stars is announced as a milestone.
- A retry now resends only to the providers that failed, so a second provider cannot
  cause repeated Discord posts.

## 1.0.0 (2026-10-13)

First release.

- Posts GitHub stars, forks, issues, pull requests, default-branch pushes, and releases
  to one Discord channel.
- Push messages skip non-default branches, bot pushes, branch deletions, and GitHub's
  pull-request merge commits. Fast-forwards of the default branch are announced.
- Verifies webhook signatures, stores each accepted delivery in D1 before answering
  GitHub, and ignores redeliveries of the same event.
- Retries failed Discord sends with backoff and Discord's rate-limit headers; a cron
  trigger recovers interrupted deliveries.
- Admin API behind a bearer token: status, health, delivery history, and retries, with
  OpenAPI and Swagger UI.
- Deploy to Cloudflare button, and `npm run deploy` applies D1 migrations before
  deploying.
- `just subscribe` (`scripts/subscribe.sh`) adds the webhook to GitHub repositories and
  skips ones already subscribed.
