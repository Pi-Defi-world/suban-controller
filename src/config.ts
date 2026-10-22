/**
 * Configuration for Suban Controller (Data Oracle)
 */
import dotenv from 'dotenv';

dotenv.config();

export const config = {
  // Server
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',

  // Cache
  cacheTTL: parseInt(process.env.CACHE_TTL_SECONDS || '10', 10),

  // Horizon API URLs (our own nodes)
  horizon: {
    mainnet: process.env.HORIZON_MAINNET_URL || 'http://localhost:41401',
    testnet: process.env.HORIZON_TESTNET_URL || 'http://localhost:31401',
  },

  // Active network (mainnet or testnet)
  network: (process.env.NETWORK || 'mainnet') as 'mainnet' | 'testnet',

  // Pi Symbols (configured for each exchange source)
  symbols: {
    coingecko: process.env.PI_SYMBOL_COINGECKO || 'pi-network',
    okx: process.env.PI_SYMBOL_OKX || 'PI-USDT',
    bitget: process.env.PI_SYMBOL_BITGET || 'PIUSDT',
    mexc: process.env.PI_SYMBOL_MEXC || 'PIUSDT',
  },

  // Aggregation
  outlierThresholdPercent: parseInt(process.env.OUTLIER_THRESHOLD_PERCENT || '10', 10),
  minSourcesRequired: parseInt(process.env.MIN_SOURCES_REQUIRED || '1', 10),
  stableMinSourcesRequired: parseInt(process.env.STABLE_MIN_SOURCES_REQUIRED || '1', 10),

  // Multi-asset price model
  assets: {
    pi: {
      enabled: (process.env.ASSET_PI_ENABLED || 'true').toLowerCase() === 'true',
      oracleAsset: process.env.ORACLE_ASSET || '',
    },
    usdc: {
      enabled: (process.env.ASSET_USDC_ENABLED || 'true').toLowerCase() === 'true',
      oracleAsset: process.env.ORACLE_ASSET_USDC || '',
      coingeckoId: process.env.USDC_COINGECKO_ID || 'usd-coin',
      okxSymbol: process.env.USDC_OKX_SYMBOL || 'USDC-USDT',
      mexcSymbol: process.env.USDC_MEXC_SYMBOL || 'USDCUSDT',
    },
    usdt: {
      enabled: (process.env.ASSET_USDT_ENABLED || 'true').toLowerCase() === 'true',
      oracleAsset: process.env.ORACLE_ASSET_USDT || '',
      coingeckoId: process.env.USDT_COINGECKO_ID || 'tether',
      okxSymbol: process.env.USDT_OKX_SYMBOL || 'USDT-USD',
    },
    ousd: {
      // oUSD has no default market feed. It stays registered but unavailable
      // until an explicit HTTP feed is configured; we never fabricate a peg.
      enabled: !!process.env.OUSD_PRICE_URL,
      oracleAsset: process.env.ORACLE_ASSET_OUSD || '',
      url: process.env.OUSD_PRICE_URL || '',
      jsonPath: process.env.OUSD_PRICE_JSON_PATH || 'price',
    },
  },

  // Source Weights (for weighted average calculation)
  weights: {
    coingecko: parseFloat(process.env.WEIGHT_COINGECKO || '1.5'),
    okx: parseFloat(process.env.WEIGHT_OKX || '2.0'),
    bitget: parseFloat(process.env.WEIGHT_BITGET || '2.0'),
    mexc: parseFloat(process.env.WEIGHT_MEXC || '3.0'),
  },

  // On-chain data cache TTL (longer than price cache)
  chainDataCacheTTL: parseInt(process.env.CHAIN_DATA_CACHE_TTL || '30', 10),

  // Staleness: max age of a price source before it's excluded (ms)
  sourceMaxAgeMs: parseInt(process.env.SOURCE_MAX_AGE_MS || '30000', 10),

  // Circuit breaker: max deviation in bps from last committed price before pause
  circuitBreakerThresholdBps: parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD_BPS || '500', 10),

  // Circuit breaker: auto-pause duration after trigger (ms)
  circuitBreakerPauseMs: parseInt(process.env.CIRCUIT_BREAKER_PAUSE_MS || '60000', 10),

  // Deviation alert threshold in bps (logs alert but doesn't pause)
  deviationAlertThresholdBps: parseInt(process.env.DEVIATION_ALERT_THRESHOLD_BPS || '300', 10),

  // On-chain Oracle
  oracleContractId: process.env.ORACLE_CONTRACT_ID || '',
  oracleRpcUrl: process.env.ORACLE_RPC_URL || 'https://rpc.testnet.minepi.com',
  oracleNetworkPassphrase: process.env.ORACLE_NETWORK_PASSPHRASE || 'Pi Testnet',
  oracleAdminSecret: process.env.ORACLE_ADMIN_SECRET || '',
  // Asset identifier (Soroban contract/account address) the oracle price is published under.
  oracleAsset: process.env.ORACLE_ASSET || '',
  // Fixed-point decimals used for the on-chain price. PUSD uses 7.
  oraclePriceDecimals: parseInt(process.env.ORACLE_PRICE_DECIMALS || '7', 10),
  // Explicit switch: publishing must be opted into.
  oraclePushEnabled: (process.env.ORACLE_PUSH_ENABLED || 'false').toLowerCase() === 'true',
  oraclePushIntervalMs: parseInt(process.env.ORACLE_PUSH_INTERVAL_MS || '60000', 10),

  // Control-plane authentication. Required for price commit / breaker reset.
  controlApiKey: process.env.CONTROLLER_ADMIN_API_KEY || '',
  controlRateLimitPerMinute: parseInt(process.env.CONTROLLER_CONTROL_RATE_LIMIT || '30', 10),

  // Price persistence (SQLite). Use :memory: in tests.
  priceDbPath: process.env.PRICE_DB_PATH || './data/prices.db',
  priceRetentionDays: parseInt(process.env.PRICE_RETENTION_DAYS || '30', 10),

  // Optional read-only data-platform client. Used by the indexed lending-risk
  // view; the core calculator remains independent of it.
  dataPlatformUrl: process.env.DATA_PLATFORM_URL || '',
  dataPlatformApiKey: process.env.DATA_PLATFORM_API_KEY || '',

  // Trust state thresholds
  trustDegradedConfidence: parseFloat(process.env.TRUST_DEGRADED_CONFIDENCE || '0.5'),
  trustMinSourceRatio: parseFloat(process.env.TRUST_MIN_SOURCE_RATIO || '0.5'),
  trustRecoveryStreak: parseInt(process.env.TRUST_RECOVERY_STREAK || '3', 10),

  // Arc chain (EVM-compatible L1 by Circle)
  arcRpcUrl: process.env.ARC_RPC_URL || '',
  arcPricePairAddress: process.env.ARC_PRICE_PAIR_ADDRESS || '',
  arcWeight: parseFloat(process.env.WEIGHT_ARC || '1.5'),
};

