/**
 * API routes for the price oracle.
 *
 * All price routes accept `?asset=PI|USDC|USDT|OUSD` (default `PI`). Unknown
 * assets return 404; known-but-unconfigured assets return 503 so consumers can
 * distinguish "no such asset" from "no live feed".
 */
import { Router, Request, Response } from 'express';
import { AssetDefinition } from '../assets/types';
import { PriceAggregator } from '../services/aggregator';
import { PriceService } from '../services/priceService';
import { logger } from '../utils/logger';
import { controlRateLimit, requireControlAuth } from '../middleware/auth';
import { getPriceStore } from '../services/priceStore';
import { PRICE_SCHEMA_VERSION, PriceOracleError } from '../types';
import { TrustSnapshot } from '../services/trustState';

const router = Router();
const startTime = Date.now();
const MAX_HISTORY_HOURS = 24 * 30;
const MAX_HISTORY_LIMIT = 10_000;

function resolveAsset(
  service: PriceService,
  rawAsset: unknown,
  res: Response
): { asset: AssetDefinition; aggregator: PriceAggregator } | null {
  const id =
    typeof rawAsset === 'string' && rawAsset.length > 0 ? rawAsset.toUpperCase() : 'PI';
  const asset = service.getAsset(id);

  if (!asset) {
    res.status(404).json({
      error: 'Unknown asset',
      asset: id,
      available_assets: service.listAssets().map((entry) => entry.id),
    });
    return null;
  }

  const aggregator = service.getAggregator(id);
  if (!aggregator) {
    res.status(503).json({
      error: 'Asset is not configured',
      asset: id,
      reason: 'No price sources are configured for this asset',
    });
    return null;
  }

  return { asset, aggregator };
}

function unconfiguredTrust(): TrustSnapshot {
  return {
    state: 'DEGRADED',
    since: new Date().toISOString(),
    reason: 'asset is not configured',
    healthy_streak: 0,
  };
}

export function createApiRouter(service: PriceService): Router {
  /**
   * GET /api/v1/assets
   * Registry of all assets with independent health.
   */
  router.get('/assets', (_req: Request, res: Response) => {
    res.json({
      schema_version: PRICE_SCHEMA_VERSION,
      assets: service.listAssets(),
    });
  });

  /**
   * GET /api/v1/price?asset=PI
   * Get the current aggregated price for one asset.
   */
  router.get('/price', async (req: Request, res: Response) => {
    const resolved = resolveAsset(service, req.query.asset, res);
    if (!resolved) return;

    try {
      const price = await resolved.aggregator.getAggregatedPrice();
      res.json(price);
    } catch (error: any) {
      const unavailable = error instanceof PriceOracleError;
      logger.error('Error fetching aggregated price', {
        asset: resolved.asset.id,
        error: error.message,
      });
      res.status(unavailable ? 503 : 500).json({
        error: unavailable ? 'No price available' : 'Failed to fetch price',
        message: error.message,
        asset: resolved.asset.id,
        trust_state: resolved.aggregator.getTrustState().state,
      });
    }
  });

  /**
   * GET /api/v1/trust?asset=PI
   * Current trust state and recent transitions for one asset.
   */
  router.get('/trust', (req: Request, res: Response) => {
    const resolved = resolveAsset(service, req.query.asset, res);
    if (!resolved) return;

    const requested = parseInt(req.query.limit as string, 10);
    const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 50, 1), 100);

    res.json({
      asset: resolved.asset.id,
      current: resolved.aggregator.getTrustState(),
      history: resolved.aggregator.getTrustHistory(limit),
    });
  });

  /**
   * GET /api/v1/history?asset=PI&hours=24&limit=1000
   * Persisted price observations (newest first) plus window stats.
   */
  router.get('/history', (req: Request, res: Response) => {
    const resolved = resolveAsset(service, req.query.asset, res);
    if (!resolved) return;

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
      const rows = store.getHistory({
        symbol: resolved.asset.symbol,
        sinceMs,
        limit,
      });
      const stats = store.getStats({
        symbol: resolved.asset.symbol,
        sinceMs,
      });

      res.json({
        schema_version: PRICE_SCHEMA_VERSION,
        asset: resolved.asset.id,
        symbol: resolved.asset.symbol,
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
      logger.error('Error fetching price history', {
        asset: resolved.asset.id,
        error: error.message,
      });
      res.status(500).json({
        error: 'Failed to fetch price history',
        message: error.message,
      });
    }
  });

  /**
   * POST /api/v1/price/commit
   * Commit the current aggregated price (called after a successful oracle push).
   * Body: { price: number, asset?: string }
   */
  router.post(
    '/price/commit',
    controlRateLimit,
    requireControlAuth,
    (req: Request, res: Response) => {
      const resolved = resolveAsset(service, req.body?.asset, res);
      if (!resolved) return;

      try {
        const { price } = req.body;
        if (typeof price !== 'number' || price <= 0) {
          res.status(400).json({ error: 'Invalid price' });
          return;
        }
        resolved.aggregator.commitPrice(price);
        logger.info('Price committed via control API', {
          asset: resolved.asset.id,
          price,
        });
        res.json({ committed: true, asset: resolved.asset.id, price });
      } catch (error: any) {
        logger.error('Error committing price', { error: error.message });
        res.status(500).json({ error: 'Failed to commit price' });
      }
    }
  );

  /**
   * GET /api/v1/sources?asset=PI
   * Source status. Without `asset`, returns PI plus a summary of all assets.
   */
  router.get('/sources', (req: Request, res: Response) => {
    try {
      if (req.query.asset !== undefined) {
        const resolved = resolveAsset(service, req.query.asset, res);
        if (!resolved) return;
        res.json({
          asset: resolved.asset.id,
          sources: resolved.aggregator.getAllSourceStatuses(),
        });
        return;
      }

      const pi = service.getAggregator('PI');
      res.json({
        asset: 'PI',
        sources: pi ? pi.getAllSourceStatuses() : [],
        assets: service.listAssets().map((asset) => ({
          id: asset.id,
          enabled: asset.enabled,
          trust_state: asset.trust.state,
          source_count: asset.sources.length,
        })),
      });
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
   * Health check with PI trust, all asset summaries and circuit-breaker state.
   */
  router.get('/health', (_req: Request, res: Response) => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const piAggregator = service.getAggregator('PI');
    const sources = piAggregator ? piAggregator.getAllSourceStatuses() : [];
    const activeSources = sources.filter((s) => s.status === 'active').length;
    const circuitBreakerActive = piAggregator
      ? piAggregator.isCircuitBreakerActive()
      : false;
    const lastPrice = piAggregator ? piAggregator.getLastCommittedPrice() : null;
    const trust = piAggregator ? piAggregator.getTrustState() : unconfiguredTrust();

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
      assets: service.listAssets().map((asset) => ({
        id: asset.id,
        enabled: asset.enabled,
        trust_state: asset.trust.state,
        source_count: asset.sources.length,
        last_committed_price: asset.last_committed_price,
      })),
    });
  });

  /**
   * GET /api/v1/circuit-breaker?asset=PI
   * Get circuit breaker status.
   */
  router.get('/circuit-breaker', (req: Request, res: Response) => {
    const resolved = resolveAsset(service, req.query.asset, res);
    if (!resolved) return;

    res.json({
      asset: resolved.asset.id,
      active: resolved.aggregator.isCircuitBreakerActive(),
      last_committed_price: resolved.aggregator.getLastCommittedPrice(),
    });
  });

  /**
   * POST /api/v1/circuit-breaker/reset
   * Manually reset the circuit breaker. Body or query: { asset?: string }
   */
  router.post(
    '/circuit-breaker/reset',
    controlRateLimit,
    requireControlAuth,
    (req: Request, res: Response) => {
      const resolved = resolveAsset(
        service,
        req.body?.asset ?? req.query.asset,
        res
      );
      if (!resolved) return;

      resolved.aggregator.resetCircuitBreaker();
      logger.warn('Circuit breaker reset via control API', {
        asset: resolved.asset.id,
      });
      res.json({ reset: true, asset: resolved.asset.id });
    }
  );

  /**
   * GET /api/v1/deviation-alerts?asset=PI
   * Get recent deviation alerts.
   */
  router.get('/deviation-alerts', (req: Request, res: Response) => {
    const resolved = resolveAsset(service, req.query.asset, res);
    if (!resolved) return;

    const limit = parseInt(req.query.limit as string) || 50;
    const alerts = resolved.aggregator.getDeviationAlerts(limit);
    res.json({ asset: resolved.asset.id, alerts, count: alerts.length });
  });

  return router;
}
