// Avoid queuing unchanged Home aggregates on a quick return.
// Mutations and background data events invalidate immediately.
export const AGGREGATE_STALE_MS = 30_000;
