const HOUR_MS = 60 * 60_000;

/**
 * How long something took or has been waiting, in whole units, rounded down: `<1h`
 * under an hour, then hours under a day (`5h`), then days (`3d`). With `withHours`,
 * days keep their remaining hours (`2d 4h`). The waiting list and the response times
 * both word durations through this.
 */
export function formatDuration(milliseconds: number, withHours = false): string {
  const hours = Math.floor(Math.max(0, milliseconds) / HOUR_MS);
  if (hours < 1) {
    return '<1h';
  }
  if (hours < 24) {
    return `${String(hours)}h`;
  }
  const days = Math.floor(hours / 24);
  const remainder = hours % 24;
  return withHours && remainder > 0 ? `${String(days)}d ${String(remainder)}h` : `${String(days)}d`;
}
