# Suban Controller API

Base URL: `http://localhost:3000` (configurable via `PORT`).

All responses are JSON unless noted. Timestamps are ISO-8601 UTC strings.
Price responses carry a `schema_version`; breaking changes to the shape bump it.

## Multi-asset model

The controller tracks four assets with independent sources, caches, circuit
breakers and trust machines:

| Asset | ID | Default sources |
|---|---|---|
| Pi Network | `PI` | MEXC, CoinGecko, OKX, Bitget, optional Arc |
| USD Coin | `USDC` | CoinGecko, OKX, MEXC |
| Tether USD | `USDT` | CoinGecko, OKX |
| oUSD | `OUSD` | Configurable HTTP feed (`OUSD_PRICE_URL`) |

Every price route accepts `?asset=PI|USDC|USDT|OUSD` and defaults to `PI`.
An unknown asset returns `404`; a registered asset with no configured source
(for example `OUSD` without `OUSD_PRICE_URL`) returns `503` with
`"error": "Asset is not configured"`. The controller never invents a peg or
fallback price.

### `GET /api/v1/assets`

Returns the registry with per-asset health, source counts, oracle address and
the last committed price.

```json
{
  "schema_version": "1.0",
  "assets": [
    {
      "id": "PI",
      "symbol": "PI",
      "name": "Pi Network",
      "enabled": true,
      "oracle_asset": "G...",
      "min_sources_required": 1,
      "sources": [{ "name": "mexc", "status": "active" }],
      "trust": { "state": "HEALTHY", "since": "...", "reason": "...", "healthy_streak": 3 },
      "last_committed_price": 0.3125
    },
    {
      "id": "OUSD",
      "symbol": "OUSD",
      "name": "oUSD",
      "enabled": false,
      "oracle_asset": null,
      "min_sources_required": 1,
      "sources": [],
      "trust": { "state": "DEGRADED", "since": "...", "reason": "no price sources configured", "healthy_streak": 0 },
      "last_committed_price": null
    }
  ]
}
```

## Price oracle

### `GET /api/v1/price?asset=PI`

Returns the latest aggregated price for one asset with provenance, freshness
and trust. The `symbol` field reflects the selected asset.

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
| `BREAKER` | Circuit breaker active; last committed price is served (or `503` if none exists) | Skipped |
| `RECOVERY` | Breaker cleared; waiting for `TRUST_RECOVERY_STREAK` healthy evaluations | Skipped |

The on-chain publisher refuses non-`HEALTHY` observations. A successful push
commits the price as the new circuit-breaker reference.

### `GET /api/v1/trust?asset=PI`

```json
{
  "asset": "PI",
  "current": { "state": "HEALTHY", "since": "...", "reason": "...", "healthy_streak": 12 },
  "history": [
    { "from": "RECOVERY", "to": "HEALTHY", "at": "...", "reason": "recovered after 3 healthy evaluations" }
  ]
}
```

`?limit=` bounds the transition history (1–100, default 50). Newest first.

### `GET /api/v1/history?asset=PI`

`?hours=` (1–720, default 24) and `?limit=` (1–10000, default 1000).
Results are filtered to the selected asset's symbol.

```json
{
  "schema_version": "1.0",
  "asset": "PI",
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

### `GET /api/v1/statistics`, `/twap`, `/volatility`

All three paths return the same versioned calculation from persisted
observations. `method_version` is `twap_volatility_v1`.

| Query | Meaning |
|---|---|
| `asset` | Asset id (default `PI`) |
| `window` | `60s`–`30d`; accepts `5m`, `24h`, `30d` or plain seconds |
| `as_of` | Optional ISO-8601 timestamp or epoch seconds/milliseconds for replay |

- TWAP is time-weighted: each observation is held until the next observation
  (or `as_of` for the last one).
- Volatility is the sample standard deviation of consecutive log returns,
  annualised with the average observation interval. It is `null` when fewer
  than two returns exist.
- Partial coverage is reported explicitly in `coverage_ratio` and `warnings`;
  missing history returns `503` rather than a fabricated value.

```json
{
  "schema_version": "1.0",
  "asset": "PI",
  "symbol": "PI",
  "window": "24h",
  "window_seconds": 86400,
  "as_of": "2026-10-21T12:00:00.000Z",
  "method_version": "twap_volatility_v1",
  "statistics": {
    "sample_count": 1440,
    "coverage_seconds": 86400,
    "coverage_ratio": 1,
    "twap_usd": 0.3121,
    "min_price_usd": 0.29,
    "max_price_usd": 0.34,
    "change_pct": 0.8,
    "realized_volatility": 0.004,
    "annualized_volatility": 0.19,
    "returns_count": 1439,
    "warnings": []
  }
}
```

### `GET /api/v1/methodology`

Returns the versioned price, TWAP/volatility and risk methods plus explicit
capability gaps. `price_quality.liquidity_aware` is currently `false`; the
controller does not have pool depth and does not pretend that source
agreement is liquidity-aware pricing.

### Risk API

#### `GET /api/v1/risk/methods`

Published formulas, defaults and limitations for `lending_risk_v1`.

#### `POST /api/v1/risk/lending`

Request:

```json
{
  "collateral": [{ "asset": "PI", "amount": 100 }],
  "debt": [{ "asset": "USDC", "amount": 5 }],
  "liquidation_threshold": 0.8,
  "target_health_factor": 1.5
}
```

Prices come from the controller's live asset aggregators, not from the
request body. Unknown assets return `404`; a registered asset with no
configured source returns `503`; a missing price returns `503` without
partial results. Stale or non-`HEALTHY` prices are returned with
`data_quality.status: "degraded"` and a warning, because the values are real
but not fresh.

The response includes `collateral_value_usd`, `debt_value_usd`,
`health_factor`, `max_borrow_usd`, `liquidation_price_usd_per_collateral_unit`
and `status` (`no_debt`, `healthy`, `at_risk`, `liquidatable`). The
liquidation price is only defined for a single collateral asset; a
multi-collateral basket returns `null` and a warning.

The calculator does not read on-chain lending positions. That is a documented
Phase 3 gap, not an implied capability.

### `GET /api/v1/sources?asset=PI`

Without `asset` the response returns PI sources plus an asset summary (for
backward compatibility). With `asset`, only that asset's sources are returned.

```json
{
  "asset": "PI",
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
  ],
  "assets": [
    { "id": "PI", "enabled": true, "trust_state": "HEALTHY", "source_count": 4 },
    { "id": "OUSD", "enabled": false, "trust_state": "DEGRADED", "source_count": 0 }
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
  "circuit_breaker_active": false,
  "assets": [
    { "id": "PI", "enabled": true, "trust_state": "HEALTHY", "source_count": 4, "last_committed_price": 0.3125 },
    { "id": "USDC", "enabled": true, "trust_state": "HEALTHY", "source_count": 3, "last_committed_price": 1.0001 }
  ]
}
```

Top-level fields describe PI for backward compatibility. `status` is
`unhealthy` when the PI breaker is active, `degraded` when the PI trust state
is not healthy or fewer than half of its sources are active, and `healthy`
otherwise. Each asset's own trust is reported in `assets`.

### `GET /api/v1/circuit-breaker?asset=PI`

```json
{ "asset": "PI", "active": false, "last_committed_price": 0.3125 }
```

### `GET /api/v1/deviation-alerts?asset=PI`

`?limit=` (default 50). Returns `{ "asset": "PI", "alerts": [...], "count": n }`.

### Control routes (authenticated)

| Route | Method | Description |
|---|---|---|
| `/api/v1/price/commit` | POST | Commit `{ "price": number, "asset"?: string }` as the circuit-breaker reference |
| `/api/v1/circuit-breaker/reset` | POST | Clear the breaker for `{ "asset"?: string }` (default PI) |

Both require `x-api-key: <key>` or `Authorization: Bearer <key>` and are
rate-limited per IP. If `CONTROLLER_ADMIN_API_KEY` is unset they return `503`
rather than falling open.

### `GET /metrics`

Prometheus text exposition. Includes `suban_price_usd`,
`suban_price_confidence`, `suban_price_age_ms`, `suban_source_up`,
`suban_source_staleness_ms`, `suban_price_aggregations_total`,
`suban_oracle_push_total`, `suban_oracle_trust_state` and
`suban_http_requests_total`, plus Node.js process metrics.

Per-asset metrics carry an `asset` label (`symbol` for the price gauges), so
PI, USDC, USDT and oUSD remain distinguishable in dashboards. Source metrics
use `asset` + `source`; trust uses `asset` + `state`.

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
| `404` | Unknown route, resource or asset |
| `429` | Control route rate limit exceeded |
| `500` | Unexpected aggregation or upstream failure |
| `503` | Control plane not configured (no API key), asset has no sources, or no usable/committed price |
