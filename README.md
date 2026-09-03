# Suban Controller

Data oracle for Pi Network — aggregates price feeds from 4 exchanges and provides on-chain analytics from our local Horizon nodes.

Part of the [Suban Data Platform](https://suban.org).

## Features

- **Price Feeds**: Aggregates from MEXC, CoinGecko, OKX, and Bitget (no API keys required)
- **On-chain Analytics**: Ledger stats, account data, transaction history from local Horizon
- **Cost Effective**: All exchange sources are free — $0 operational cost
- **Weighted Aggregation**: Smart price averaging with outlier detection and confidence scoring
- **Fault Tolerant**: Continues operating even if some sources fail
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
# Install
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

## API Endpoints

### Price Oracle
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/price` | GET | Aggregated Pi price |
| `/api/v1/sources` | GET | Price source status |
| `/api/v1/health` | GET | Health check |

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

## Docker

```bash
docker build -t suban-controller .
docker run -p 3000:3000 \
  -e HORIZON_MAINNET_URL=http://pi-mainnet:8000 \
  suban-controller
```
