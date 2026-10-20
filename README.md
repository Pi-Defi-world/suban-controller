# Suban Controller

Data oracle for Pi Network — aggregates price feeds from 4 exchanges and provides on-chain analytics from our local Horizon nodes.

Part of the [Suban Data Platform](https://suban.org).

## Features

- **Price Feeds**: Aggregates from MEXC, CoinGecko, OKX, and Bitget (no API keys required)
- **On-chain Analytics**: Ledger stats, account data, transaction history from local Horizon
- **Cost Effective**: All exchange sources are free — $0 operational cost
- **Weighted Aggregation**: Smart price averaging with outlier detection and confidence scoring
- **Fault Tolerant**: Continues operating even if some sources fail
- **Persistent History**: Price observations are stored in SQLite and survive restarts (30-day default retention)
- **Explicit Trust States**: `HEALTHY` / `DEGRADED` / `BREAKER` / `RECOVERY` with transition history
- **Observable**: Prometheus metrics at `/metrics` and provenance/freshness fields on every price
- **Horizon Proxy**: Transparent proxy to our local Horizon node
- **Docker Ready**: Includes Dockerfile for containerized deployment

## Data Sources

### Price Feeds (4 Active)

| Source    | Auth Required | Weight |
|-----------|--------------|--------|
| MEXC      | No           | 3.0x   |
| CoinGecko | No           | 1.5x   |
| OKX       | No           | 2.0x   |
| Bitget    | No           | 2.0x   |

### On-chain Data

Queried from our local Horizon nodes (not external APIs):
- Network statistics (ledger count, account count)
- Latest ledgers with transaction/operation counts
- Account details and balances
- Recent transactions

## Quick Start

```bash
# Install (Node.js 22+ required for better-sqlite3)
pnpm install

# Configure
cp .env.example .env
# Edit .env to set HORIZON_MAINNET_URL

# Development
pnpm dev

# Production
pnpm build
pnpm start
```

## Environment Variables

| Variable                     | Default                          | Description                     |
|------------------------------|----------------------------------|----------------------------------|
| `PORT`                       | `3000`                           | HTTP server port                 |
| `NODE_ENV`                   | `development`                    | Environment mode                 |
| `NETWORK`                    | `mainnet`                        | Pi network (mainnet/testnet)     |
| `HORIZON_MAINNET_URL`        | `http://localhost:41401`         | Local Horizon mainnet URL        |
| `HORIZON_TESTNET_URL`        | `http://localhost:31401`         | Local Horizon testnet URL        |
| `CACHE_TTL_SECONDS`          | `10`                             | Price cache TTL                  |
| `CHAIN_DATA_CACHE_TTL`       | `30`                             | On-chain data cache TTL          |
| `CONTROLLER_ADMIN_API_KEY`   | *(unset)*                        | Shared secret for control routes. **Required**; if unset, control routes return `503`. |
| `CONTROLLER_CONTROL_RATE_LIMIT` | `30`                          | Control requests allowed per IP per minute |
| `ORACLE_PUSH_ENABLED`        | `false`                          | Opt in to publishing prices on-chain |
| `ORACLE_CONTRACT_ID`         | *(unset)*                        | Soroban oracle contract ID       |
| `ORACLE_ASSET`               | *(unset)*                        | Asset address the price is published under |
| `ORACLE_RPC_URL`             | `https://rpc.testnet.minepi.com` | Soroban RPC endpoint             |
| `ORACLE_ADMIN_SECRET`        | *(unset)*                        | Stellar secret key for the oracle admin |
| `ORACLE_PRICE_DECIMALS`      | `7`                              | Fixed-point decimals for the on-chain price |
| `ORACLE_PUSH_INTERVAL_MS`    | `60000`                          | How often to attempt a price push |
| `PRICE_DB_PATH`              | `./data/prices.db`               | SQLite file for price observations (`:memory:` for tests) |
| `PRICE_RETENTION_DAYS`       | `30`                             | How long price observations are kept |
| `TRUST_DEGRADED_CONFIDENCE`  | `0.5`                            | Confidence below which the oracle is `DEGRADED` |
| `TRUST_MIN_SOURCE_RATIO`     | `0.5`                            | Minimum fraction of sources that must be usable |
| `TRUST_RECOVERY_STREAK`      | `3`                              | Healthy evaluations required to leave `RECOVERY` |

## API Endpoints

### Price Oracle
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/price` | GET | Aggregated Pi price with provenance, freshness and trust |
| `/api/v1/history` | GET | Persisted observations (`?hours=24&limit=1000`) |
| `/api/v1/trust` | GET | Current trust state and transition history |
| `/api/v1/sources` | GET | Price source status |
| `/api/v1/health` | GET | Health check (includes `trust_state`) |
| `/metrics` | GET | Prometheus metrics |

### On-chain Data
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/chain/stats` | GET | Network statistics |
| `/api/v1/chain/ledgers` | GET | Latest ledgers |
| `/api/v1/chain/accounts` | GET | Top accounts |
| `/api/v1/chain/accounts/:id` | GET | Account info |
| `/api/v1/chain/transactions` | GET | Recent transactions |

### Horizon Proxy
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/horizon/*` | ALL | Proxy to local Horizon |

### Price response schema

`GET /api/v1/price` is versioned with `schema_version` and `method_version`:

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

### Trust states

| State | Meaning | Oracle push |
|-------|---------|-------------|
| `HEALTHY` | Enough fresh sources and confidence above the threshold | Allowed |
| `DEGRADED` | Too few usable sources or confidence below the threshold | Skipped |
| `BREAKER` | Circuit breaker active; last committed price is served | Skipped |
| `RECOVERY` | Breaker cleared; waiting for `TRUST_RECOVERY_STREAK` healthy evaluations | Skipped |

Transitions are exposed at `GET /api/v1/trust` (newest first).

### Price history

`GET /api/v1/history?hours=24&limit=1000` returns persisted observations
(newest first) and window stats:

```json
{
  "schema_version": "1.0",
  "symbol": "PI",
  "window_hours": 24,
  "stats": {
    "high24h": 0.34,
    "low24h": 0.29,
    "open24h": 0.31,
    "closePrice": 0.3125,
    "count": 8640
  },
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

Observations are written only on fresh aggregations (not cache hits or breaker
fallbacks) and pruned after `PRICE_RETENTION_DAYS`.

### Metrics

`GET /metrics` exposes Prometheus text metrics, including:

- `suban_price_usd{symbol}`
- `suban_price_confidence{symbol}`
- `suban_price_age_ms{symbol}`
- `suban_source_up{source}`
- `suban_source_staleness_ms{source}`
- `suban_price_aggregations_total{result}`
- `suban_oracle_push_total{result}`
- `suban_oracle_trust_state{state}`
- `suban_http_requests_total{method,route,status}`

### Control plane (authenticated)
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/price/commit` | POST | Commit the current aggregated price |
| `/api/v1/circuit-breaker/reset` | POST | Reset the price circuit breaker |

These routes require a shared secret and are rate-limited per IP. Send it as
`x-api-key: <key>` or `Authorization: Bearer <key>`. If
`CONTROLLER_ADMIN_API_KEY` is not set, both routes return `503` rather than
falling open. Never expose these routes on a public interface without the key;
generate one with `openssl rand -hex 32`.

## Docker

```bash
docker build -t suban-controller .
docker run -p 3000:3000 \
  -v suban-controller-data:/app/data \
  -e HORIZON_MAINNET_URL=http://pi-mainnet:8000 \
  suban-controller
```
