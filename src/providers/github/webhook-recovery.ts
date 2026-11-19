import type { GitHubAppConfig } from '../../config/env.js';
import type { D1DatabaseLike, D1PreparedStatementLike } from '../../core/services/d1-types.js';
import { logger } from '../../core/services/logger.js';
import { signAppJwt } from './app-auth.js';

const LIST_URL = 'https://api.github.com/app/hook/deliveries';
const PAGE_SIZE = 100;
const MAX_REQUESTS = 5;
const MINUTE_MS = 60_000;
const RETRY_INTERVAL_MS = 60 * MINUTE_MS;
const MAX_ATTEMPTS = 3;
const RETENTION_MS = 3 * 24 * 60 * MINUTE_MS;

interface DeliveryAttempt {
  id: number;
  guid: string;
  originalAt: string;
  redelivery: boolean;
  succeeded: boolean;
}

function parsePage(body: unknown, now: number): DeliveryAttempt[] {
  if (!Array.isArray(body) || body.length > PAGE_SIZE) throw new Error('Invalid delivery page');
  return body.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) throw new Error('Invalid delivery entry');
    const { id, guid, delivered_at, redelivery, status, status_code } = entry as Record<
      string,
      unknown
    >;
    if (
      typeof id !== 'number' ||
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      typeof guid !== 'string' ||
      guid === '' ||
      typeof redelivery !== 'boolean' ||
      typeof status !== 'string' ||
      typeof delivered_at !== 'string'
    ) {
      throw new Error('Invalid delivery entry');
    }
    const at = Date.parse(delivered_at);
    if (!Number.isFinite(at)) throw new Error('Invalid delivery timestamp');
    if (at < now - RETENTION_MS || at > now) return [];
    return [
      {
        id,
        guid,
        originalAt: new Date(at).toISOString(),
        redelivery,
        succeeded:
          status === 'OK' ||
          (typeof status_code === 'number' && status_code >= 200 && status_code < 300),
      },
    ];
  });
}

function nextCursor(link: string | null): string | null {
  const address = link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
  if (address === undefined) return null;
  const url = new URL(address);
  if (`${url.origin}${url.pathname}` !== LIST_URL) throw new Error('Invalid delivery page link');
  const cursor = url.searchParams.get('cursor');
  if (cursor === null || cursor === '') throw new Error('Missing delivery page cursor');
  return cursor;
}

async function rateLimitedUntil(response: Response): Promise<number | null> {
  const retry = response.headers.get('retry-after');
  const exhausted = response.headers.get('x-ratelimit-remaining') === '0';
  if (response.status === 403 && retry === null && !exhausted) {
    const body: unknown = await response.json().catch(() => null);
    if (
      !(
        typeof body === 'object' &&
        body !== null &&
        'message' in body &&
        typeof body.message === 'string' &&
        /secondary rate limit/i.test(body.message)
      )
    )
      return null;
  } else if (response.status !== 429 && response.status !== 403) {
    return null;
  }
  const now = Date.now();
  const after =
    retry === null ? now : /^\d+$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry);
  const reset = exhausted ? Number(response.headers.get('x-ratelimit-reset')) * 1000 : now;
  return Math.max(
    now + MINUTE_MS,
    Number.isSafeInteger(after) ? after : now,
    Number.isSafeInteger(reset) ? reset : now
  );
}

export function isWebhookRecoveryDue(now: Date): boolean {
  return now.getUTCMinutes() % 10 === 0;
}

export async function originalWebhookTime(
  db: D1DatabaseLike,
  guid: string
): Promise<string | null> {
  const row = await db
    .prepare('SELECT original_at AS originalAt FROM webhook_recovery_attempts WHERE guid = ?')
    .bind(guid)
    .first<{ originalAt: string | null }>();
  return row?.originalAt ?? null;
}

/** Scan one page. No request to GitHub until a durable write proves D1 is writable. */
export async function recoverWebhooks(db: D1DatabaseLike, app: GitHubAppConfig): Promise<void> {
  let step = 'probe';
  try {
    const now = Date.now();
    const lease = now + 5 * MINUTE_MS;
    const scan = await db
      .prepare(`INSERT INTO webhook_recovery_scan (singleton, next_scan_at) VALUES (1, ?)
       ON CONFLICT (singleton) DO UPDATE SET next_scan_at = excluded.next_scan_at
       WHERE webhook_recovery_scan.next_scan_at <= ?
       RETURNING cursor`)
      .bind(lease, now)
      .first<{ cursor: string | null }>();
    if (!scan) return;

    const delayScan = (until: number): D1PreparedStatementLike =>
      db
        .prepare(`UPDATE webhook_recovery_scan
      SET next_scan_at = ? WHERE singleton = 1 AND next_scan_at = ?`)
        .bind(Math.max(lease, until), lease);

    step = 'sign';
    const jwt = await signAppJwt(app.appId, app.privateKey, Math.floor(now / 1000));
    const request = (url: string, method: 'GET' | 'POST'): Promise<Response> =>
      fetch(url, {
        method,
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${jwt}`,
          'User-Agent': 'repo-pulse',
          'X-GitHub-Api-Version': '2026-03-10',
        },
      });

    step = 'list';
    const url = new URL(LIST_URL);
    url.searchParams.set('per_page', String(PAGE_SIZE));
    if (scan.cursor !== null) url.searchParams.set('cursor', scan.cursor);
    const page = await request(url.toString(), 'GET');
    if (!page.ok) {
      logger.warn('webhook_recovery.github_refused', {
        component: 'webhook_recovery',
        step,
        status: page.status,
      });
      const limitedUntil = await rateLimitedUntil(page);
      // A cursor can expire while D1 is down. A bad request with a cursor restarts the walk.
      if (limitedUntil !== null) {
        await delayScan(limitedUntil).run();
      } else if (scan.cursor !== null && (page.status === 400 || page.status === 422)) {
        await db
          .prepare(
            'UPDATE webhook_recovery_scan SET cursor = NULL WHERE singleton = 1 AND next_scan_at = ?'
          )
          .bind(lease)
          .run();
      }
      return;
    }
    const body: unknown = await page.json();
    const attempts = parsePage(body, Date.now());
    const next = nextCursor(page.headers.get('link'));
    const succeeded = new Set(
      attempts.filter((attempt) => attempt.succeeded).map((attempt) => attempt.guid)
    );
    const originals = new Map(
      attempts
        .filter((attempt) => !(attempt.redelivery || succeeded.has(attempt.guid)))
        .map((attempt) => [attempt.guid, attempt])
    );

    step = 'find_missing';
    const missing =
      originals.size === 0
        ? []
        : (
            await db
              .prepare(`SELECT guid.value AS guid FROM json_each(?) AS guid
       WHERE NOT EXISTS (SELECT 1 FROM webhook_recovery_attempts AS a
         WHERE a.guid = guid.value AND (a.delivered = 1 OR a.request_count >= ? OR a.last_requested_at > ?))
         AND NOT EXISTS (SELECT 1 FROM events WHERE delivery_id = guid.value)
         AND NOT EXISTS (SELECT 1 FROM deliveries WHERE delivery_id = guid.value)
       ORDER BY guid.key LIMIT ?`)
              .bind(
                JSON.stringify([...originals.keys()]),
                MAX_ATTEMPTS,
                Date.now() - RETRY_INTERVAL_MS,
                MAX_REQUESTS + 1
              )
              .all<{ guid: string }>()
          ).results;

    let requested = 0;
    for (const { guid } of missing.slice(0, MAX_REQUESTS)) {
      const original = originals.get(guid);
      if (!original) continue;
      step = 'reserve';
      const requestedAt = Date.now();
      const reservation = await db
        .prepare(`INSERT INTO webhook_recovery_attempts (guid, original_at, expires_at, request_count, last_requested_at)
         SELECT ?, ?, ?, 1, ? WHERE EXISTS (SELECT 1 FROM webhook_recovery_scan WHERE singleton = 1 AND next_scan_at = ?)
           AND NOT EXISTS (SELECT 1 FROM events WHERE delivery_id = ?)
           AND NOT EXISTS (SELECT 1 FROM deliveries WHERE delivery_id = ?)
         ON CONFLICT (guid) DO UPDATE SET
           request_count = webhook_recovery_attempts.request_count + 1,
           last_requested_at = excluded.last_requested_at,
           expires_at = excluded.expires_at
         WHERE webhook_recovery_attempts.delivered = 0 AND webhook_recovery_attempts.request_count < ?
           AND webhook_recovery_attempts.last_requested_at <= ?
         RETURNING guid`)
        .bind(
          guid,
          original.originalAt,
          // Keep the time marker even if a callback arrives just after GitHub's retention cutoff.
          requestedAt + RETENTION_MS,
          requestedAt,
          lease,
          guid,
          guid,
          MAX_ATTEMPTS,
          requestedAt - RETRY_INTERVAL_MS
        )
        .first<{ guid: string }>();
      if (!reservation) continue;
      step = 'redeliver';
      const response = await request(`${LIST_URL}/${String(original.id)}/attempts`, 'POST');
      if (response.status !== 202) {
        logger.warn('webhook_recovery.github_refused', {
          component: 'webhook_recovery',
          step,
          status: response.status,
        });
        const limitedUntil = await rateLimitedUntil(response);
        if (limitedUntil !== null) {
          await delayScan(limitedUntil).run();
          return;
        }
        continue;
      }
      requested += 1;
    }

    step = 'checkpoint';
    // A successful redelivery (including a manual one) may be on a different page
    // from its original. A failed one is not evidence of acceptance.
    const delivered = attempts
      .filter((attempt) => attempt.redelivery && attempt.succeeded)
      .map((attempt) => attempt.guid);
    await db.batch([
      db
        .prepare(`INSERT INTO webhook_recovery_attempts (guid, expires_at, delivered)
         SELECT value, ?, 1 FROM json_each(?) WHERE true
         ON CONFLICT (guid) DO UPDATE SET delivered = 1, expires_at = excluded.expires_at
         WHERE webhook_recovery_attempts.delivered = 0`)
        .bind(now + RETENTION_MS, JSON.stringify(delivered)),
      db
        .prepare(`DELETE FROM webhook_recovery_attempts WHERE guid IN (
         SELECT guid FROM webhook_recovery_attempts WHERE expires_at < ? ORDER BY expires_at LIMIT ?)`)
        .bind(now, PAGE_SIZE),
      db
        .prepare(
          'UPDATE webhook_recovery_scan SET cursor = ?, checkpoint_at = ? WHERE singleton = 1 AND next_scan_at = ?'
        )
        .bind(missing.length > MAX_REQUESTS ? scan.cursor : next, Date.now(), lease),
    ]);
    if (requested > 0)
      logger.info('webhook_recovery.requested', {
        component: 'webhook_recovery',
        count: requested,
      });
  } catch {
    // Exceptions can contain JWTs, D1 bound values, or GitHub response bodies.
    logger.warn('webhook_recovery.step_failed', { component: 'webhook_recovery', step });
  }
}
