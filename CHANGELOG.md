# Changelog

## 1.0.0 (unreleased)

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
