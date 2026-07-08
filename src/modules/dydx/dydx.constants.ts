export const DYDX_BASE_URL          = 'https://indexer.dydx.trade/v4';
export const POLL_INTERVAL_MS       = 10_000;
export const CRITICAL_THRESHOLD_PCT = 10;
export const WARNING_THRESHOLD_PCT  = 20;
export const ALERT_DEDUP_TTL_SEC    = 300;
export const MARKET_CACHE_TTL_SEC   = 60;
export const MAX_RETRIES            = 3;

// ── Liquidation Index (Redis Sorted Sets) ─────────────────────────────────────
export const LIQ_INDEX_PREFIX       = 'dydx:liqidx';       // dydx:liqidx:long:{market} / dydx:liqidx:short:{market}
export const LAST_PRICE_PREFIX      = 'dydx:lastprice';    // dydx:lastprice:{marketId}

// ── Event Stream ─────────────────────────────────────────────────────────────
export const EVENT_STREAM_KEY       = 'dydx:events';
export const EVENT_CONSUMER_GROUP   = 'dydx-alert-consumers';
export const EVENT_CONSUMER_NAME    = 'notifier-1';

// ── Warning check interval ────────────────────────────────────────────────────
export const WARNING_CHECK_INTERVAL_MS = 30_000;

// ── Concurrency ───────────────────────────────────────────────────────────────
export const SYNC_CONCURRENCY = 25;
