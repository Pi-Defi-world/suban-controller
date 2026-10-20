# Suban Controller API

Base URL: `http://localhost:3000` (configurable via `PORT`).

All responses are JSON unless noted. Timestamps are ISO-8601 UTC strings.
Price responses carry a `schema_version`; breaking changes to the shape bump it.

## Price oracle

### `GET /api/v1/price`

Returns the latest aggregated Pi price with provenance, freshness and trust.

```json
{
  "schema_version": "1.0",
  "method_version": "weighted_average_v1",
  "symbol": "PI",
  "price_usd": 0.3125,
  "timestamp": "2026-10-20T12:00:00.000Z",
  "age_ms": 0,
  "is_fresh": true,
  "sources_used": 4,
  "total_sources": 4,
  "aggregation_method": "weighted_average",
  "confidence_score": 0.94,
  "cache_hit": false,
  "source_prices": {
    "mexc": {
      "price": 0.312,
      "weight": 3,
      "timestamp": "2026-10-20T11:59:58.000Z",
      "age_ms": 2000,
      "is_fresh": true
    }
  },
  "trust": {
    "state": "HEALTHY",
    "since": "2026-10-20T11:00:00.000Z",
    "reason": "sources and confidence within bounds",
    "healthy_streak": 120
  }
}
```

| Field | Meaning |
|---|---|
| `schema_version` | Public response schema version |
| `method_version` | Aggregation methodology version |
| `age_ms` / `is_fresh` | Age of the observation and whether it is within `SOURCE_MAX_AGE_MS` |
| `source_prices` | Per-source price, weight, timestamp, age and freshness |
| `confidence_score` | `0.6 × source coverage + 0.4 × price consistency` (0–1) |
| `cache_hit` | `true` when served from the 10-second cache |
| `trust` | Explicit oracle trust state (see below) |
| `circuit_breaker_active` | Present and `true` when the breaker fired |

When the circuit breaker is active, the response uses
`aggregation_method: "circuit_breaker_fallback"`, `sources_used: 0`,
`is_fresh: false`, and `trust.state: "BREAKER"`.

### Trust states

| State | Meaning | Oracle push |
|---|---|---|
| `HEALTHY` | Enough fresh sources and confidence ≥ `TRUST_DEGRADED_CONFIDENCE` | Allowed |
| `DEGRADED` | Too few usable sources or confidence below the threshold | Skipped |
| `BREAKER` | Circuit breaker active; last committed price is served | Skipped |
| `RECOVERY` | Breaker cleared; waiting for `TRUST_RECOVERY_STREAK` healthy evaluations | Skipped |

The on-chain publisher refuses non-`HEALTHY` observations. A successful push
commits the price as the new circuit-breaker reference.

### `GET /api/v1/trust`

```json
{
  "current": { "state": "HEALTHY", "since": "...", "reason": "...", "healthy_streak": 12 },
  "history": [
    { "from": "RECOVERY", "to": "HEALTHY", "at": "...", "reason": "recovered after 3 healthy evaluations" }
  ]
}
```

`?limit=` bounds the transition history (1–100, default 50). Newest first.

### `GET /api/v1/history`

`?hours=` (1–720, default 24) and `?limit=` (1–10000, default 1000).

```json
{
  "schema_version": "1.0",
  "symbol": "PI",
  "window_hours": 24,
  "stats": { "high24h": 0.34, "low24h": 0.29, "open24h": 0.31, "closePrice": 0.3125, "count": 8640 },
  "observations": [
    {
      "price": 0.3125,
      "confidence": 0.94,
      "sources_used": 4,
      "trust_state": "HEALTHY",
      "observed_at": "2026-10-20T12:00:00.000Z",
      "observed_at_ms": 1760961600000
    }
  ]
}
```

Observations are append-only in SQLite and pruned after
`PRICE_RETENTION_DAYS`. Only fresh aggregations are stored: cache hits and
breaker fallbacks are not duplicated.

### `GET /api/v1/sources`

```json
{
  "sources": [
    {
      "name": "mexc",
      "status": "active",
      "last_success": "2026-10-20T12:00:00.000Z",
      "last_error": null,
      "success_rate": 0.99,
      "avg_response_time_ms": 120,
      "staleness_ms": 800
    }
  ]
}
```

`status` is one of `active`, `stale`, `error`, `disabled`. `staleness_ms` is
`-1` when the source has never succeeded.

### `GET /api/v1/health`

```json
{
  "schema_version": "1.0",
  "status": "healthy",
  "trust_state": "HEALTHY",
  "trust": { "state": "HEALTHY", "since": "...", "reason": "...", "healthy_streak": 12 },
  "uptime": 3600,
  "timestamp": "2026-10-20T12:00:00.000Z",
  "active_sources": 4,
  "total_sources": 4,
  "last_price_usd": 0.3125,
  "circuit_breaker_active": false
}
```

`status` is `unhealthy` when the breaker is active, `degraded` when fewer than
half of the sources are active, and `healthy` otherwise.

### `GET /api/v1/circuit-breaker`

```json
{ "active": false, "last_committed_price": 0.3125 }
```

### `GET /api/v1/deviation-alerts`

`?limit=` (default 50). Returns `{ "alerts": [...], "count": n }`.

### Control routes (authenticated)

| Route | Method | Description |
|---|---|---|
| `/api/v1/price/commit` | POST | Commit `{ "price": number }` as the circuit-breaker reference |
| `/api/v1/circuit-breaker/reset` | POST | Clear the breaker |

Both require `x-api-key: <key>` or `Authorization: Bearer <key>` and are
rate-limited per IP. If `CONTROLLER_ADMIN_API_KEY` is unset they return `503`
rather than falling open.

### `GET /metrics`

Prometheus text exposition. Includes `suban_price_usd`,
`suban_price_confidence`, `suban_price_age_ms`, `suban_source_up`,
`suban_source_staleness_ms`, `suban_price_aggregations_total`,
`suban_oracle_push_total`, `suban_oracle_trust_state` and
`suban_http_requests_total`, plus Node.js process metrics.

## Pi data compatibility routes

| Route | Description |
|---|---|
| `GET /data/pi-price` | piscan.io-compatible `{ data: [{ idxPx, high24h, open24h, low24h }] }` |
| `GET /data/mainnet-supply` | Circulating/locked/total supply (CoinGecko with fallback) |
| `GET /data/check-scam-wallet/:address` | Scam-wallet check |
| `GET /data/top-accounts` | Top accounts |
| `GET /data/accounts/distribution` | Balance distribution |
| `GET /data/data/unlocknext30d` | Unlock schedule (next 30 days) |
| `GET /data/data/unlockfull` | Full unlock schedule |
| `GET /data/data/nodemap` | Node map |
| `GET /data/transactions` | Recent transactions |

## On-chain data (local Horizon)

| Route | Query | Description |
|---|---|---|
| `GET /api/v1/chain/stats` | — | Network statistics |
| `GET /api/v1/chain/ledgers` | `limit` (≤100) | Latest ledgers |
| `GET /api/v1/chain/accounts` | `limit` (≤100) | Top accounts |
| `GET /api/v1/chain/accounts/:accountId` | — | Account details |
| `GET /api/v1/chain/transactions` | `limit` (≤100) | Recent transactions |

## Escrow and contracts

| Route | Query | Description |
|---|---|---|
| `GET /api/escrow/:escrowId` | `network` | Escrow state from Horizon (or `unknown` fallback) |
| `GET /api/gateway/events` | `network` | Gateway events |
| `GET /api/contracts` | `network` | Contracts observed in recent Soroban events |
| `GET /api/contracts/:contractId` | `network` | Contract detail |
| `GET /api/contracts/:contractId/state` | `network` | Contract state |

`network` defaults to `NETWORK` and accepts `mainnet` or `testnet`.

## Realtime

| Route | Description |
|---|---|
| `GET /realtime` | Server-Sent Events stream of transactions, trades and orders |
| `GET /realtime/snapshot` | Current in-memory snapshot |

## Horizon proxy

`ALL /horizon/*` proxies to the configured local Horizon node.

## Errors

Errors use a consistent shape:

```json
{ "error": "Failed to fetch price", "message": "...", "trust_state": "DEGRADED" }
```

| Status | Meaning |
|---|---|
| `400` | Invalid input |
| `401` | Missing/invalid control API key |
| `404` | Unknown route or resource |
| `429` | Control route rate limit exceeded |
| `500` | Upstream or aggregation failure |
| `503` | Control plane not configured (no API key) |
