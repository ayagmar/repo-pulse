# Architecture

Repo Pulse has one runtime path and one package-manager path:

- Runtime: Cloudflare Workers + Hono
- Durable ledger: D1
- Package manager and local tooling entrypoint: npm + Wrangler

## System Shape

- [`src/http/routes/webhook.ts`](/home/ayagmar/Projects/Personal/repo-pulse/src/http/routes/webhook.ts) handles bounded raw-body reads, GitHub signature verification, event normalization, delivery persistence, and acceptance.
- [`src/core/services/d1-delivery-ledger.ts`](/home/ayagmar/Projects/Personal/repo-pulse/src/core/services/d1-delivery-ledger.ts) is the durable source of truth for dedupe, status transitions, retry timing, and provider attempt history.
- [`src/core/services/durable-event-processor.ts`](/home/ayagmar/Projects/Personal/repo-pulse/src/core/services/durable-event-processor.ts) claims due work, dispatches notifiers, persists outcomes, and reschedules transient failures.
- [`src/http/routes/admin.ts`](/home/ayagmar/Projects/Personal/repo-pulse/src/http/routes/admin.ts) exposes authenticated operational endpoints against the same ledger.
- [`src/providers/discord/`](/home/ayagmar/Projects/Personal/repo-pulse/src/providers/discord) owns Discord formatting and transport.

## Design Intent

- Persist first: accepted supported deliveries are written to D1 before success is returned.
- Dedupe at the ledger: duplicate GitHub delivery IDs do not resend notifications.
- Keep the route thin: the webhook route talks directly to `DurableEventProcessor`; removed abstraction layers were not reintroduced.
- Keep background work recoverable: immediate follow-up uses `waitUntil()`, while durable retries and stale lease recovery run from D1 state plus cron drains.

## Further Reading

- Detailed design and Mermaid diagrams: [`docs/system-design.md`](/home/ayagmar/Projects/Personal/repo-pulse/docs/system-design.md)
- Setup, deploy, and operations: [`docs/operations.md`](/home/ayagmar/Projects/Personal/repo-pulse/docs/operations.md)
