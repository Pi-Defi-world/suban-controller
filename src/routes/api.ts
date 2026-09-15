/**
 * API routes for the price oracle
 */
import { Router, Request, Response } from 'express';
import { PriceAggregator } from '../services/aggregator';
import { logger } from '../utils/logger';

const router = Router();
const startTime = Date.now();

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
      });
    }
  });

  /**
   * POST /api/v1/price/commit
   * Commit the current aggregated price (called after successful push to on-chain oracle)
   */
  router.post('/price/commit', async (req: Request, res: Response) => {
    try {
      const { price } = req.body;
      if (typeof price !== 'number' || price <= 0) {
        res.status(400).json({ error: 'Invalid price' });
        return;
      }
      aggregator.commitPrice(price);
      res.json({ committed: true, price });
    } catch (error: any) {
      logger.error('Error committing price', { error: error.message });
      res.status(500).json({ error: 'Failed to commit price' });
    }
  });

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

    let status: 'healthy' | 'degraded' | 'unhealthy';
    if (circuitBreakerActive) {
      status = 'unhealthy';
    } else if (activeSources < sources.length / 2) {
      status = 'degraded';
    } else {
      status = 'healthy';
    }

    res.json({
      status,
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
  router.post('/circuit-breaker/reset', (_req: Request, res: Response) => {
    aggregator.resetCircuitBreaker();
    res.json({ reset: true });
  });

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
