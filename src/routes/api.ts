/**
 * API routes for the price oracle
 */
import { Router, Request, Response } from 'express';
import { PriceAggregator } from '../services/aggregator';
import { logger } from '../utils/logger';
import { controlRateLimit, requireControlAuth } from '../middleware/auth';
import { getPriceStore } from '../services/priceStore';
import { PRICE_SCHEMA_VERSION } from '../types';

const router = Router();
const startTime = Date.now();
const MAX_HISTORY_HOURS = 24 * 30;
const MAX_HISTORY_LIMIT = 10_000;

export function createApiRouter(aggregator: PriceAggregator): Router {
  /**
   * GET /api/v1/price
   * Get the current aggregated Pi price
   */
  router.get('/price', async (_req: Request, res: Response) => {
    try {
      const price = await aggregator.getAggregatedPrice();
      res.json(price);
    } catch (error: any) {
      logger.error('Error fetching aggregated price', { error: error.message });
      res.status(500).json({
        error: 'Failed to fetch price',
        message: error.message,
        trust_state: aggregator.getTrustState().state,
      });
    }
  });

  /**
   * GET /api/v1/trust
   * Current oracle trust state and recent transitions
   */
  router.get('/trust', (req: Request, res: Response) => {
    const requested = parseInt(req.query.limit as string, 10);
    const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 50, 1), 100);
    res.json({
      current: aggregator.getTrustState(),
      history: aggregator.getTrustHistory(limit),
    });
  });

  /**
   * GET /api/v1/history?hours=24&limit=1000
   * Persisted price observations (newest first) plus window stats
   */
  router.get('/history', (req: Request, res: Response) => {
    try {
      const requestedHours = parseFloat(req.query.hours as string);
      const hours = Math.min(
        Math.max(Number.isFinite(requestedHours) ? requestedHours : 24, 1),
        MAX_HISTORY_HOURS
      );
      const requestedLimit = parseInt(req.query.limit as string, 10);
      const limit = Math.min(
        Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 1000, 1),
        MAX_HISTORY_LIMIT
      );

      const sinceMs = Date.now() - hours * 3_600_000;
      const store = getPriceStore();
      const rows = store.getHistory({ sinceMs, limit });
      const stats = store.getStats(sinceMs);

      res.json({
        schema_version: PRICE_SCHEMA_VERSION,
        symbol: 'PI',
        window_hours: hours,
        stats,
        observations: rows.map((row) => ({
          price: row.price,
          confidence: row.confidence,
          sources_used: row.sources_used,
          trust_state: row.trust_state,
          observed_at: new Date(row.observed_at).toISOString(),
          observed_at_ms: row.observed_at,
        })),
      });
    } catch (error: any) {
      logger.error('Error fetching price history', { error: error.message });
      res.status(500).json({
        error: 'Failed to fetch price history',
        message: error.message,
      });
    }
  });

  /**
   * POST /api/v1/price/commit
   * Commit the current aggregated price (called after successful push to on-chain oracle)
   */
  router.post(
    '/price/commit',
    controlRateLimit,
    requireControlAuth,
    async (req: Request, res: Response) => {
      try {
        const { price } = req.body;
        if (typeof price !== 'number' || price <= 0) {
          res.status(400).json({ error: 'Invalid price' });
          return;
        }
        aggregator.commitPrice(price);
        logger.info('Price committed via control API', { price });
        res.json({ committed: true, price });
      } catch (error: any) {
        logger.error('Error committing price', { error: error.message });
        res.status(500).json({ error: 'Failed to commit price' });
      }
    }
  );

  /**
   * GET /api/v1/sources
   * Get status of all price sources
   */
  router.get('/sources', (_req: Request, res: Response) => {
    try {
      const sources = aggregator.getAllSourceStatuses();
      res.json({ sources });
    } catch (error: any) {
      logger.error('Error fetching source statuses', { error: error.message });
      res.status(500).json({
        error: 'Failed to fetch source statuses',
        message: error.message,
      });
    }
  });

  /**
   * GET /api/v1/health
   * Health check with real source status and circuit breaker state
   */
  router.get('/health', (_req: Request, res: Response) => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const sources = aggregator.getAllSourceStatuses();
    const activeSources = sources.filter(s => s.status === 'active').length;
    const circuitBreakerActive = aggregator.isCircuitBreakerActive();
    const lastPrice = aggregator.getLastCommittedPrice();
    const trust = aggregator.getTrustState();

    let status: 'healthy' | 'degraded' | 'unhealthy';
    if (circuitBreakerActive || trust.state === 'BREAKER') {
      status = 'unhealthy';
    } else if (trust.state === 'DEGRADED' || trust.state === 'RECOVERY') {
      status = 'degraded';
    } else if (activeSources < sources.length / 2) {
      status = 'degraded';
    } else {
      status = 'healthy';
    }

    res.json({
      schema_version: PRICE_SCHEMA_VERSION,
      status,
      trust_state: trust.state,
      trust,
      uptime,
      timestamp: new Date(),
      active_sources: activeSources,
      total_sources: sources.length,
      last_price_usd: lastPrice,
      circuit_breaker_active: circuitBreakerActive,
    });
  });

  /**
   * GET /api/v1/circuit-breaker
   * Get circuit breaker status
   */
  router.get('/circuit-breaker', (_req: Request, res: Response) => {
    res.json({
      active: aggregator.isCircuitBreakerActive(),
      last_committed_price: aggregator.getLastCommittedPrice(),
    });
  });

  /**
   * POST /api/v1/circuit-breaker/reset
   * Manually reset circuit breaker (admin action)
   */
  router.post(
    '/circuit-breaker/reset',
    controlRateLimit,
    requireControlAuth,
    (_req: Request, res: Response) => {
      aggregator.resetCircuitBreaker();
      logger.warn('Circuit breaker reset via control API');
      res.json({ reset: true });
    }
  );

  /**
   * GET /api/v1/deviation-alerts
   * Get recent deviation alerts
   */
  router.get('/deviation-alerts', (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const alerts = aggregator.getDeviationAlerts(limit);
    res.json({ alerts, count: alerts.length });
  });

  return router;
}
