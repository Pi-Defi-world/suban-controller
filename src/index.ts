/**
 * Suban Controller - Data Oracle for Pi Network
 */
import express from 'express';
import cors from 'cors';
import { config } from './config';
import { logger } from './utils/logger';
import { createApiRouter } from './routes/api';
import { createPiDataRouter } from './routes/pi-data';
import { createHorizonProxyRouter } from './routes/horizon-proxy';
import { createChainDataRouter } from './routes/chaindata';
import { createRealtimeRouter } from './routes/realtime';
import { TransactionStreamer } from './services/transactionStreamer';
import { escrowRouter } from './routes/escrow';
import { contractsRouter } from './routes/contracts';

import { OraclePushService } from './services/oracle-push';
import { metricsRegistry, httpMetrics } from './services/metrics';
import { closePriceStore, getPriceStore } from './services/priceStore';
import { PriceService } from './services/priceService';
import { buildAssetDefinitions } from './assets/registry';

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

  // Prometheus request metrics
  app.use(httpMetrics);

  // Initialize price history store eagerly so a bad path fails at startup.
  getPriceStore();
  logger.info('Price history store ready', {
    path: config.priceDbPath,
    retention_days: config.priceRetentionDays,
  });

  // Initialize the multi-asset price service. Each asset owns its sources,
  // cache, circuit breaker and trust machine.
  const priceService = new PriceService(buildAssetDefinitions());
  const piAggregator = priceService.getDefaultAggregator();
  logger.info('Price assets initialized', {
    assets: priceService.getSummary(),
  });

  // Initialize oracle push service
  const oraclePush = new OraclePushService();
  const oracleTargets = priceService.getOracleTargets();

  if (oraclePush.isConfigured() && oracleTargets.length > 0) {
    logger.info('Oracle push service configured', {
      contract_id: config.oracleContractId,
      assets: oracleTargets.map((target) => target.asset.id),
    });

    // Periodically push each healthy asset to its on-chain oracle entry.
    const pushInterval = setInterval(async () => {
      for (const target of oracleTargets) {
        try {
          const price = await target.aggregator.getAggregatedPrice();
          if (price.cache_hit || price.trust.state !== 'HEALTHY') {
            continue;
          }
          const pushed = await oraclePush.pushPrice(
            price,
            target.asset.oracleAsset
          );
          if (pushed) {
            target.aggregator.commitPrice(price.price_usd);
          }
        } catch (error: any) {
          logger.warn('Periodic oracle push failed', {
            asset: target.asset.id,
            error: error.message,
          });
        }
      }
    }, config.oraclePushIntervalMs);

    // Don't keep process alive just for push interval
    if (pushInterval.unref) {
      pushInterval.unref();
    }
  } else if (oraclePush.isConfigured()) {
    logger.warn(
      'Oracle push enabled but no asset has an oracle address (set ORACLE_ASSET, ORACLE_ASSET_USDC, ...)'
    );
  }

  // API Routes
  app.use('/api/v1', createApiRouter(priceService));
  
  // Pi Network data endpoints
  app.use('/data', createPiDataRouter(piAggregator));
  
  // On-chain data endpoints (from our local Horizon)
  app.use('/api/v1/chain', createChainDataRouter());

  // Horizon API proxy (to our local Horizon node)
  app.use('/horizon', createHorizonProxyRouter());

  // SSE Realtime - live transaction/trade/order streaming
  const streamer = new TransactionStreamer();
  streamer.start();
  app.use('/realtime', createRealtimeRouter(streamer));

  // Escrow API - backend for escrow viewer
  app.use('/api', escrowRouter);

  // Contract search - derived from recent effects (no contract index in Horizon)
  app.use('/api', contractsRouter);

  // Root endpoint
  app.get('/', (_req, res) => {
    res.json({
      name: 'Suban Controller',
      version: '1.3.0',
      description: 'Data oracle for Pi Network - multi-asset price feeds and on-chain analytics',
      platform: 'https://suban.org',
      endpoints: {
        assets: '/api/v1/assets',
        price: '/api/v1/price?asset=PI',
        history: '/api/v1/history?asset=PI',
        trust: '/api/v1/trust?asset=PI',
        sources: '/api/v1/sources?asset=PI',
        health: '/api/v1/health',
        metrics: '/metrics',
        circuitBreaker: '/api/v1/circuit-breaker',
        deviationAlerts: '/api/v1/deviation-alerts',
        oracleStats: '/api/v1/oracle/stats',
        chainStats: '/api/v1/chain/stats',
        ledgers: '/api/v1/chain/ledgers',
        accounts: '/api/v1/chain/accounts',
        chainTransactions: '/api/v1/chain/transactions',
        horizon: '/horizon/*',
        realtime: '/realtime',
        realtimeSnapshot: '/realtime/snapshot',
        escrow: '/api/escrow/:id',
        gatewayEvents: '/api/gateway/events',
      },
      oracle: oraclePush.getStats(),
    });
  });

  // Oracle push stats endpoint
  app.get('/api/v1/oracle/stats', (_req, res) => {
    res.json(oraclePush.getStats());
  });

  // Prometheus metrics
  app.get('/metrics', async (_req, res) => {
    res.setHeader('Content-Type', metricsRegistry.contentType);
    res.send(await metricsRegistry.metrics());
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
      closePriceStore();
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

