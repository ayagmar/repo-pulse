import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import {
  createTempDatabasePath,
  createTestD1Database,
  createTestRepoEvent,
} from '../src/__tests__/test-helpers.js';
import { D1DeliveryLedger } from '../src/core/services/d1-delivery-ledger.js';

// Opt-in local SQLite integration benchmark, not a production D1/Workers CPU measurement.
it('measures listing 50 deliveries from a 20,000-delivery ledger with 60,000 attempts', async () => {
  const temporary = createTempDatabasePath();
  const db = createTestD1Database(temporary.databasePath);
  try {
    const eventJson = JSON.stringify(createTestRepoEvent()).replaceAll("'", "''");
    await db.exec(`
      BEGIN;
      WITH RECURSIVE sequence(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 20000
      )
      INSERT INTO deliveries (
        delivery_id, source_event_type, normalized_event_type, repository,
        normalized_event_json, accepted_at, status, processing_attempts
      ) SELECT printf('delivery-%05d', n), 'star', 'star.created', 'myorg/repo',
        '${eventJson}', strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01', '+' || n || ' seconds'),
        CASE n % 4 WHEN 0 THEN 'pending' WHEN 1 THEN 'processing'
          WHEN 2 THEN 'succeeded' ELSE 'failed' END, 3
      FROM sequence;
      INSERT INTO provider_attempts (
        delivery_id, delivery_attempt, provider_name, attempted_at, success
      ) SELECT delivery_id, attempt, 'discord', accepted_at, 1
        FROM deliveries CROSS JOIN (SELECT 1 AS attempt UNION ALL SELECT 2 UNION ALL SELECT 3);
      COMMIT;
    `);
    let query = '';
    const ledger = new D1DeliveryLedger({
      ...db,
      prepare(sql) {
        query = sql;
        return db.prepare(sql);
      },
    });
    for (const statuses of [[], ['failed']] as const) {
      for (let warmup = 0; warmup < 10; warmup += 1) {
        await ledger.listDeliveries(statuses);
      }
      const plan = await db
        .prepare(`EXPLAIN QUERY PLAN ${query}`)
        .bind(...statuses, 50)
        .all();
      const samples: number[] = [];
      for (let round = 0; round < 7; round += 1) {
        const start = performance.now();
        for (let run = 0; run < 10; run += 1) {
          const rows = await ledger.listDeliveries(statuses);
          expect(rows).toHaveLength(50);
          expect(rows.every((row) => row.providerAttemptCount === 3)).toBe(true);
          expect(rows[0]?.deliveryId).toBe(
            statuses.length === 0 ? 'delivery-20000' : 'delivery-19999'
          );
        }
        samples.push((performance.now() - start) / 10);
      }
      samples.sort((a, b) => a - b);
      console.info(
        JSON.stringify({
          scenario: statuses.length === 0 ? 'all' : 'failed',
          runtime: process.version,
          medianMs: samples[3],
          minMs: samples[0],
          maxMs: samples[6],
          samplesMs: samples,
          plan: plan.results,
        })
      );
    }
  } finally {
    db.close();
    temporary.cleanup();
  }
});
