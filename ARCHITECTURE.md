# Architecture

Repo Pulse has one runtime path and one package-manager path:

- Runtime: Cloudflare Workers + Hono
- Durable ledger: D1
- Package manager and local tooling entrypoint: npm + Wrangler

## System Shape

- [`src/http/routes/webhook.ts`](src/http/routes/webhook.ts) bounds the raw request bytes, verifies GitHub signatures before decoding JSON, normalizes events, persists deliveries, and acknowledges acceptance.
- [`src/core/services/d1-delivery-ledger.ts`](src/core/services/d1-delivery-ledger.ts) is the durable source of truth for dedupe, status transitions, retry timing, and provider attempt history.
- [`src/core/services/d1-event-history.ts`](src/core/services/d1-event-history.ts) keeps every accepted event permanently. Delivery rows are pruned after the retention window; history rows are not.
- [`src/core/services/durable-event-processor.ts`](src/core/services/durable-event-processor.ts) claims due work, dispatches notifiers, persists outcomes, and reschedules transient failures.
- [`src/http/routes/admin.ts`](src/http/routes/admin.ts) exposes authenticated operational endpoints against the same ledger.
- [`src/http/routes/public-feed.ts`](src/http/routes/public-feed.ts) serves `GET /public/feed` without auth. [`src/core/services/public-feed.ts`](src/core/services/public-feed.ts) builds it from the event history, and [`src/providers/github/repository-visibility.ts`](src/providers/github/repository-visibility.ts) admits only repositories GitHub currently shows as public.
- [`src/providers/discord/`](src/providers/discord/) owns Discord formatting and transport.

## Design Intent

- Persist first: supported deliveries are written to D1 before `202 Accepted`. The delivery row and its history row are inserted in one D1 batch, so an event is never queued without being recorded.
- Dedupe at the ledger: a retained GitHub delivery ID does not enqueue new work.
- Keep the route thin: it talks directly to `DurableEventProcessor`.
- Reuse Hono routes and matchers across requests. Build configuration and binding-dependent services per request so binding-only deployments do not retain stale secrets or database clients.
- Keep background work recoverable: `waitUntil()` starts immediate processing; cron recovers expired leases and retries from D1.
- Fence delivery outcomes by processing attempt: a stale processor cannot overwrite a newer claim. Admin retries atomically transition only failed rows.
- Count interrupted attempts toward the retry budget. A D1 outcome-write failure leaves a recoverable lease instead of becoming a permanent provider failure.
- Retry per provider: a retry resends only to the providers that have not accepted the delivery, so one failing provider does not repeat posts on the others.
- Provider sends are **at-least-once**, not exactly-once. A crash between sending to Discord and recording success can cause a repeat. Pruning a succeeded row also ends its dedupe window.
- The daily and weekly digests read the event history, not the ledger. Each provider claims a digest in `digest_sends` before posting it, so overlapping cron runs post it once. The optional GitHub lookup for unreleased work never blocks a digest: if it fails, the digest is posted without it.
- The public feed fails closed. Webhooks can only hide a repository (through events recorded as private), never admit one. Every response asks GitHub's API, without a token or with one that reads public repositories only, about each repository it would show, unless an answer under 60 seconds old is cached in the isolate. Anything but a `200` with `"private": false` leaves the repository out. An empty feed means every repository was denied (`404` or `"private": true`); when nothing is admitted and some lookup failed, the feed answers `503` instead. The D1 read is cached for 300 seconds; the gated response is never cached.
- The star radar reads the event history every ten minutes and claims each alert in `radar_alerts`, which also enforces a 24-hour cooldown per repository. It sends at most one alert per run to stay within the Free plan's 50 subrequests.

## Further Reading

- [Detailed design](docs/system-design.md)
- [Setup](SETUP.md)
- [Operations](docs/operations.md)
- [Production profiling](docs/profiling.md)
