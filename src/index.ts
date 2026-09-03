/**
 * Suban Controller - Data Oracle for Pi Network
 */
import express from 'express';
import cors from 'cors';
import { config } from './config';
import { logger } from './utils/logger';
import { PriceAggregator } from './services/aggregator';
import { createApiRouter } from './routes/api';
import { createPiDataRouter } from './routes/pi-data';
import { createHorizonProxyRouter } from './routes/horizon-proxy';
import { createChainDataRouter } from './routes/chaindata';

// Import all price sources
import { CoinGeckoSource } from './sources/coingecko';
import { OKXSource } from './sources/okx';
import { BitgetSource } from './sources/bitget';
import { MexcSource } from './sources/mexc';

async function main() {
  logger.info('Starting Suban Controller (Data Oracle)...');

  // Initialize Express app
  const app = express();
  app.set('trust proxy', 1);
  
  // Middleware
  app.use(cors());
  app.use(express.json());

  // Request logging
  app.use((req, _res, next) => {
    logger.debug('Incoming request', {
      method: req.method,
      path: req.path,
      ip: req.ip,
    });
    next();
  });

  // Initialize price aggregator
  const aggregator = new PriceAggregator();

  // Add all price sources
  try {
    aggregator.addSource(
      new MexcSource('mexc', config.weights.mexc, config.symbols.mexc)
    );
    logger.info('MEXC source added');

    aggregator.addSource(
      new CoinGeckoSource('coingecko', config.weights.coingecko, config.symbols.coingecko)
    );
    logger.info('CoinGecko source added');

    aggregator.addSource(
      new OKXSource('okx', config.weights.okx, config.symbols.okx)
    );
    logger.info('OKX source added');

    aggregator.addSource(
      new BitgetSource('bitget', config.weights.bitget, config.symbols.bitget)
    );
    logger.info('Bitget source added');

    logger.info('All 4 price sources initialized (MEXC, CoinGecko, OKX, Bitget)');
  } catch (error: any) {
    logger.error('Error initializing price sources', { error: error.message });
    process.exit(1);
  }

  // API Routes
  app.use('/api/v1', createApiRouter(aggregator));
  
  // Pi Network data endpoints
  app.use('/data', createPiDataRouter(aggregator));
  
  // On-chain data endpoints (from our local Horizon)
  app.use('/api/v1/chain', createChainDataRouter());

  // Horizon API proxy (to our local Horizon node)
  app.use('/horizon', createHorizonProxyRouter());

  // Root endpoint
  app.get('/', (_req, res) => {
    res.json({
      name: 'Suban Controller',
      version: '1.0.0',
      description: 'Data oracle for Pi Network - price feeds and on-chain analytics',
      platform: 'https://suban.org',
      endpoints: {
        price: '/api/v1/price',
        sources: '/api/v1/sources',
        health: '/api/v1/health',
        chainStats: '/api/v1/chain/stats',
        ledgers: '/api/v1/chain/ledgers',
        accounts: '/api/v1/chain/accounts',
        transactions: '/api/v1/chain/transactions',
        horizon: '/horizon/*',
      },
    });
  });

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({
      error: 'Not Found',
      message: `Route ${req.method} ${req.path} not found`,
    });
  });

  // Error handler
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('Unhandled error', { error: err.message, stack: err.stack });
    res.status(500).json({
      error: 'Internal Server Error',
      message: config.nodeEnv === 'development' ? err.message : 'An error occurred',
    });
  });

  // Start server
  const server = app.listen(config.port, () => {
    logger.info(`Suban Controller running on port ${config.port}`);
    logger.info(`Network: ${config.network}`);
    logger.info(`Horizon: ${config.horizon[config.network]}`);
    logger.info(`Cache TTL: ${config.cacheTTL}s (price) / ${config.chainDataCacheTTL}s (chain)`);
  });

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down gracefully');
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: error.message, stack: error.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', { reason, promise });
  process.exit(1);
});

main().catch((error) => {
  logger.error('Fatal error during startup', { error: error.message });
  process.exit(1);
});

