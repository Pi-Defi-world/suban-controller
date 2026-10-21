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
import {
  computePriceStatistics,
  MAX_WINDOW_SECONDS,
  parseAsOf,
  parseWindow,
  PRICE_STATS_METHOD_VERSION,
} from '../services/priceStats';
import {
  computeLendingRisk,
  DEFAULT_LIQUIDATION_THRESHOLD,
  DEFAULT_TARGET_HEALTH_FACTOR,
  PricedRiskPosition,
  RISK_METHOD_VERSION,
  RiskInputError,
} from '../services/risk';

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
   * GET /api/v1/statistics?asset=PI&window=24h&as_of=...
   * GET /api/v1/twap?asset=PI&window=1h
   * GET /api/v1/volatility?asset=PI&window=24h
   *
   * All three paths expose the same versioned, deterministic calculation from
   * persisted observations. They differ only in the documented entry point.
   */
  router.get(['/statistics', '/twap', '/volatility'], (req: Request, res: Response) => {
    const resolved = resolveAsset(service, req.query.asset, res);
    if (!resolved) return;

    const parsedWindow = parseWindow(req.query.window);
    if (!parsedWindow) {
      res.status(400).json({
        error: 'Invalid window',
        message: `window must be between 60 seconds and ${MAX_WINDOW_SECONDS} seconds (for example 1h or 30d)`,
      });
      return;
    }

    const requestedAsOf = parseAsOf(req.query.as_of);
    if (req.query.as_of !== undefined && requestedAsOf === null) {
      res.status(400).json({
        error: 'Invalid as_of',
        message: 'as_of must be an ISO-8601 timestamp, epoch seconds or epoch milliseconds',
      });
      return;
    }
    const asOfMs = requestedAsOf ?? Date.now();
    if (asOfMs > Date.now() + 60_000) {
      res.status(400).json({
        error: 'Invalid as_of',
        message: 'as_of cannot be in the future',
      });
      return;
    }
    const sinceMs = asOfMs - parsedWindow.seconds * 1_000;

    try {
      const rows = getPriceStore().getHistoryChronological({
        symbol: resolved.asset.symbol,
        sinceMs,
        untilMs: asOfMs,
      });
      const statistics = computePriceStatistics(
        rows.map((row) => ({ price: row.price, observed_at: row.observed_at })),
        parsedWindow.seconds,
        asOfMs
      );

      if (!statistics) {
        res.status(503).json({
          error: 'Insufficient price history',
          asset: resolved.asset.id,
          symbol: resolved.asset.symbol,
          window: parsedWindow.label,
          window_seconds: parsedWindow.seconds,
          as_of: new Date(asOfMs).toISOString(),
          method_version: PRICE_STATS_METHOD_VERSION,
          reason: 'No persisted observations in the requested window',
        });
        return;
      }

      res.json({
        schema_version: PRICE_SCHEMA_VERSION,
        asset: resolved.asset.id,
        symbol: resolved.asset.symbol,
        window: parsedWindow.label,
        window_seconds: parsedWindow.seconds,
        as_of: new Date(asOfMs).toISOString(),
        method_version: statistics.method_version,
        statistics: {
          ...statistics,
          first_observed_at: new Date(statistics.first_observed_at_ms).toISOString(),
          last_observed_at: new Date(statistics.last_observed_at_ms).toISOString(),
        },
      });
    } catch (error: any) {
      logger.error('Error computing price statistics', {
        asset: resolved.asset.id,
        error: error.message,
      });
      res.status(500).json({
        error: 'Failed to compute price statistics',
        message: error.message,
      });
    }
  });

  /**
   * GET /api/v1/methodology
   * Versioned methodology and explicit capability gaps.
   */
  router.get('/methodology', (_req: Request, res: Response) => {
    res.json({
      schema_version: PRICE_SCHEMA_VERSION,
      methods: {
        price_aggregation: 'weighted_average_v1',
        twap_volatility: PRICE_STATS_METHOD_VERSION,
        lending_risk: RISK_METHOD_VERSION,
      },
      price_quality: {
        provenance_fields: ['source_prices', 'confidence_score', 'age_ms', 'is_fresh', 'trust'],
        trust_states: ['HEALTHY', 'DEGRADED', 'BREAKER', 'RECOVERY'],
        liquidity_aware: false,
        liquidity_source: null,
      },
      gaps: [
        'Pricing is source-agreement weighted but not liquidity-aware; no pool depth or slippage input is available yet.',
        'TWAP and volatility are computed only from persisted controller observations.',
        'Risk is a deterministic calculator; it does not read on-chain lending positions.',
      ],
    });
  });

  /**
   * GET /api/v1/risk/methods
   * Published formulas, versions and defaults.
   */
  router.get('/risk/methods', (_req: Request, res: Response) => {
    res.json({
      method_version: RISK_METHOD_VERSION,
      defaults: {
        liquidation_threshold: DEFAULT_LIQUIDATION_THRESHOLD,
        target_health_factor: DEFAULT_TARGET_HEALTH_FACTOR,
      },
      formulas: {
        collateral_value_usd: 'sum(collateral_amount * price_usd)',
        debt_value_usd: 'sum(debt_amount * price_usd)',
        health_factor:
          'collateral_value_usd * liquidation_threshold / debt_value_usd',
        max_borrow_usd:
          'collateral_value_usd * liquidation_threshold / target_health_factor',
        liquidation_price_usd_per_collateral_unit:
          'debt_value_usd / (collateral_amount * liquidation_threshold)',
      },
      statuses: ['no_debt', 'healthy', 'at_risk', 'liquidatable'],
      limitations: [
        'The calculator does not index on-chain lending positions.',
        'Liquidation price is only defined for a single collateral asset.',
        'A stale or missing price returns 503; a fresh non-HEALTHY price is returned with data_quality.degraded=true.',
      ],
    });
  });

  /**
   * POST /api/v1/risk/lending
   * Body: { collateral: [{asset, amount}], debt: [{asset, amount}],
   *         liquidation_threshold?, target_health_factor? }
   *
   * Unknown assets return 404; registered assets with no configured source
   * return 503; missing/stale inputs are never replaced with invented prices.
   */
  router.post('/risk/lending', async (req: Request, res: Response) => {
    const body = req.body || {};
    if (!Array.isArray(body.collateral) || !Array.isArray(body.debt)) {
      res.status(400).json({
        error: 'Invalid risk input',
        message: 'collateral and debt must be arrays',
      });
      return;
    }

    const resolvePosition = async (
      raw: any,
      field: string
    ): Promise<
      | PricedRiskPosition
      | {
          error: string;
          status: number;
          asset?: string;
          age_ms?: number;
          trust_state?: string;
        }
    > => {
      const assetId =
        typeof raw?.asset === 'string' ? raw.asset.toUpperCase() : '';
      if (!assetId) {
        return { error: `${field}.asset is required`, status: 400 };
      }
      if (
        typeof raw.amount !== 'number' ||
        !Number.isFinite(raw.amount) ||
        raw.amount < 0
      ) {
        return { error: `${field}.amount must be a finite non-negative number`, status: 400 };
      }

      const asset = service.getAsset(assetId);
      if (!asset) {
        return { error: 'Unknown asset', status: 404, asset: assetId };
      }
      const aggregator = service.getAggregator(assetId);
      if (!aggregator) {
        return { error: 'Asset is not configured', status: 503, asset: assetId };
      }

      try {
        const price = await aggregator.getAggregatedPrice();
        if (!price.is_fresh) {
          return {
            error: 'Price is stale',
            status: 503,
            asset: assetId,
            age_ms: price.age_ms,
            trust_state: price.trust.state,
          };
        }
        return {
          asset: assetId,
          amount: raw.amount,
          price_usd: price.price_usd,
          is_fresh: price.is_fresh,
          trust_state: price.trust.state,
          age_ms: price.age_ms,
          observed_at: price.timestamp,
        } as PricedRiskPosition & {
          is_fresh: boolean;
          trust_state: string;
          age_ms: number;
          observed_at: Date;
        };
      } catch (error: any) {
        logger.warn('Risk calculation could not resolve a price', {
          asset: assetId,
          error: error.message,
        });
        return { error: 'No price available', status: 503, asset: assetId };
      }
    };

    try {
      const collateral: Array<PricedRiskPosition & Record<string, unknown>> = [];
      const debt: Array<PricedRiskPosition & Record<string, unknown>> = [];

      for (let index = 0; index < body.collateral.length; index += 1) {
        const result = await resolvePosition(body.collateral[index], `collateral[${index}]`);
        if ('error' in result) {
          res.status(result.status).json({
            error: result.error,
            asset: result.asset,
            age_ms: result.age_ms,
            trust_state: result.trust_state,
            available_assets: service.listAssets().map((entry) => entry.id),
          });
          return;
        }
        collateral.push(result as PricedRiskPosition & Record<string, unknown>);
      }

      for (let index = 0; index < body.debt.length; index += 1) {
        const result = await resolvePosition(body.debt[index], `debt[${index}]`);
        if ('error' in result) {
          res.status(result.status).json({
            error: result.error,
            asset: result.asset,
            age_ms: result.age_ms,
            trust_state: result.trust_state,
            available_assets: service.listAssets().map((entry) => entry.id),
          });
          return;
        }
        debt.push(result as PricedRiskPosition & Record<string, unknown>);
      }

      const risk = computeLendingRisk({
        collateral,
        debt,
        liquidation_threshold: body.liquidation_threshold,
        target_health_factor: body.target_health_factor,
      });

      const prices = [...collateral, ...debt].map((position) => ({
        asset: position.asset,
        price_usd: position.price_usd,
        is_fresh: Boolean(position.is_fresh),
        trust_state: String(position.trust_state),
        age_ms: Number(position.age_ms),
        observed_at:
          position.observed_at instanceof Date
            ? position.observed_at.toISOString()
            : position.observed_at,
      }));
      const degraded = prices.some(
        (price) => !price.is_fresh || price.trust_state !== 'HEALTHY'
      );
      const warnings = [...risk.warnings];
      if (degraded) {
        warnings.push(
          'one or more prices have a non-HEALTHY oracle trust state'
        );
      }

      res.json({
        schema_version: PRICE_SCHEMA_VERSION,
        method_version: risk.method_version,
        data_quality: {
          status: degraded ? 'degraded' : 'ok',
          warnings,
        },
        prices,
        risk: {
          ...risk,
          warnings,
        },
      });
    } catch (error: any) {
      if (error instanceof RiskInputError) {
        res.status(400).json({ error: 'Invalid risk input', message: error.message });
        return;
      }
      logger.error('Error computing lending risk', { error: error.message });
      res.status(500).json({ error: 'Failed to compute lending risk' });
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
