/**
 * What makes a recorded event publishable on the public routes, written once for
 * both readers: `test` checks a value the feed read from D1, and `sql` is the
 * same check inside a D1 query, for `/public/activity`'s aggregate. Each SQL check
 * accepts exactly what `test` accepts for the value the feed would read from that
 * path; `src/__tests__/public-feed.test.ts` holds the two routes to that.
 *
 * Lengths count Unicode code points, as JSON Schema's `maxLength` and SQLite's
 * `length()` do.
 */
interface Rule<Value> {
  test: (value: unknown) => value is Value;
  /** An SQL condition on the JSON value at `path` in `event_json`. */
  sql: (path: string) => string;
}

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
/** Every character JavaScript's `\s` matches, for an SQLite GLOB class: 40 bytes with it, under D1's 50. */
const WHITESPACE = '\t\n\v\f\r    -     　﻿';
const GITHUB_PREFIX = 'https://github.com/';
const MAX_URL_LENGTH = 2048;

function at(path: string): string {
  return `json_extract(event_json, '${path}')`;
}

function codePoints(value: string): number {
  // Code points on purpose: the contract's `maxLength`, not what a reader sees.
  return Array.from(value).length;
}

function text(maximumLength: number): Rule<string> {
  return {
    test: (value): value is string =>
      typeof value === 'string' && value.length >= 1 && codePoints(value) <= maximumLength,
    sql: (path) =>
      `(json_type(event_json, '${path}') = 'text' AND length(${at(path)}) BETWEEN 1 AND ${String(maximumLength)})`,
  };
}

function count(minimum: number, maximum = MAX_SAFE_INTEGER): Rule<number> {
  return {
    test: (value): value is number =>
      Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum,
    sql: (path) =>
      `(json_type(event_json, '${path}') = 'integer' AND ${at(path)} BETWEEN ${String(minimum)} AND ${String(maximum)})`,
  };
}

export const GITHUB_URL: Rule<string> = {
  test: (value): value is string =>
    typeof value === 'string' &&
    codePoints(value) <= MAX_URL_LENGTH &&
    value.startsWith(GITHUB_PREFIX) &&
    !/\s/.test(value),
  sql: (path) =>
    `(json_type(event_json, '${path}') = 'text'
      AND length(${at(path)}) <= ${String(MAX_URL_LENGTH)}
      AND substr(${at(path)}, 1, ${String(GITHUB_PREFIX.length)}) = '${GITHUB_PREFIX}'
      AND ${at(path)} NOT GLOB '*[${WHITESPACE}]*')`,
};

export const RELEASE_TAG = text(200);
export const PULL_REQUEST_TITLE = text(300);
export const PULL_REQUEST_NUMBER = count(1);
export const STAR_COUNT = count(0);
/** On the number of commits; in SQL, on the array at `path`. */
export const COMMIT_COUNT: Rule<number> = {
  test: count(0, 10_000).test,
  sql: (path) =>
    `(json_type(event_json, '${path}') = 'array' AND json_array_length(event_json, '${path}') <= 10000)`,
};

/** An ISO timestamp as `toISOString` writes it for years 0000 to 9999, which is how events are stored. */
export function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    toIsoString(value) === value
  );
}

export function toIsoString(value: string): string | null {
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/**
 * `isTimestamp` on the `received_at` column: only a value `strftime` writes back
 * unchanged has `toISOString`'s shape. SQLite rolls an impossible day over as
 * JavaScript does, so the round trip rejects it, but keeps hour 24 as it is.
 * (D1 refuses GLOB patterns over 50 bytes, so the shape is not matched with one.)
 */
const SQL_RECEIVED_AT_IS_TIMESTAMP = `(strftime('%Y-%m-%dT%H:%M:%fZ', received_at) = received_at
  AND substr(received_at, 12, 2) < '24')`;

/** The fields each published type must have, by JSON path in the stored event. */
const PUBLISHED_FIELDS: Record<string, [string, Rule<unknown>][]> = {
  'release.published': [
    ['$.release.url', GITHUB_URL],
    ['$.release.tagName', RELEASE_TAG],
  ],
  'star.created': [['$.star.count', STAR_COUNT]],
  'push.default_branch': [
    ['$.push.compareUrl', GITHUB_URL],
    ['$.push.commits', COMMIT_COUNT],
  ],
  'pull_request.merged': [
    ['$.pullRequest.url', GITHUB_URL],
    ['$.pullRequest.number', PULL_REQUEST_NUMBER],
    ['$.pullRequest.title', PULL_REQUEST_TITLE],
  ],
};

/** An SQL condition true for the events of the published types that the feed would publish. */
export const SQL_IS_PUBLISHABLE = `(${SQL_RECEIVED_AT_IS_TIMESTAMP}
  AND CASE event_type
    ${Object.entries(PUBLISHED_FIELDS)
      .map(
        ([type, fields]) =>
          `WHEN '${type}' THEN ${fields.map(([path, rule]) => rule.sql(path)).join(' AND ')}`
      )
      .join('\n    ')}
    ELSE 0
  END)`;
