/**
 * Price aggregation service
 * Combines prices from multiple sources using weighted averages
 * with staleness checks, circuit breakers, and deviation alerts.
 */
import {
  AggregatedPrice,
  PRICE_METHOD_VERSION,
  PRICE_SCHEMA_VERSION,
  PriceData,
  PriceOracleError,
  PriceSource,
  SourcePriceDetail,
} from '../types';
import { logger } from '../utils/logger';
import { config } from '../config';
import { cacheService } from './cache';
import { TrustSnapshot, TrustStateMachine, TrustTransition } from './trustState';
import { PriceRecorder, getPriceStore } from './priceStore';
import {
  aggregationCounter,
  priceAgeGauge,
  priceConfidenceGauge,
  priceGauge,
  setTrustState,
  sourceStalenessGauge,
  sourceUpGauge,
} from './metrics';

interface AggregationResult {
  price: number;
  sourcePrices: Record<string, SourcePriceDetail>;
  confidence: number;
}

interface BuildResultParams {
  price: number;
  sourcesUsed: number;
  totalSources: number;
  aggregationMethod: string;
  sourcePrices: Record<string, SourcePriceDetail>;
  confidence: number;
  trust: TrustSnapshot;
  cacheHit?: boolean;
  circuitBreakerActive?: boolean;
  isFresh?: boolean;
  ageMs?: number;
}

interface PriceAggregatorOptions {
  /** Override persistence (tests use an in-memory recorder). */
  store?: PriceRecorder;
  /** Override the trust machine (tests use a fake clock). */
  trust?: TrustStateMachine;
}

export class PriceAggregator {
  private sources: PriceSource[] = [];
  private lastCommittedPrice: number | null = null;
  private circuitBreakerTriggeredAt: number | null = null;
  private deviationAlerts: Array<{ timestamp: Date; deviation_bps: number; old_price: number; new_price: number }> = [];

  private readonly store: PriceRecorder;
  private readonly trust: TrustStateMachine;

  constructor(options: PriceAggregatorOptions = {}) {
    this.store = options.store ?? {
      record: (observation) => getPriceStore().record(observation),
    };
    this.trust =
      options.trust ??
      new TrustStateMachine({
        degradedConfidence: config.trustDegradedConfidence,
        minSourceRatio: config.trustMinSourceRatio,
        recoveryStreak: config.trustRecoveryStreak,
      });
  }

  addSource(source: PriceSource): void {
    this.sources.push(source);
    logger.info('Price source added', { source: source.getName() });
  }

  /**
   * Check if circuit breaker is currently active.
   */
  isCircuitBreakerActive(): boolean {
    if (this.circuitBreakerTriggeredAt === null) return false;
    const elapsed = Date.now() - this.circuitBreakerTriggeredAt;
    if (elapsed > config.circuitBreakerPauseMs) {
      // Pause expired, reset
      this.circuitBreakerTriggeredAt = null;
      return false;
    }
    return true;
  }

  /**
   * Get the last committed price (before circuit breaker).
   */
  getLastCommittedPrice(): number | null {
    return this.lastCommittedPrice;
  }

  /**
   * Manually reset circuit breaker (admin action).
   */
  resetCircuitBreaker(): void {
    this.circuitBreakerTriggeredAt = null;
    logger.info('Circuit breaker manually reset');
  }

  /**
   * Current trust state, without re-evaluating sources.
   */
  getTrustState(): TrustSnapshot {
    return this.trust.snapshot();
  }

  /**
   * Recent trust-state transitions, newest first.
   */
  getTrustHistory(limit: number = 50): TrustTransition[] {
    return this.trust.getHistory(limit);
  }

  /**
   * Get recent deviation alerts.
   */
  getDeviationAlerts(limit: number = 50): Array<{ timestamp: Date; deviation_bps: number; old_price: number; new_price: number }> {
    return this.deviationAlerts.slice(-limit);
  }

  async getAggregatedPrice(): Promise<AggregatedPrice> {
    // Check circuit breaker first
    if (this.isCircuitBreakerActive()) {
      logger.warn('Circuit breaker active, returning last committed price');
      const trust = this.evaluateTrust({
        sourcesUsed: 0,
        totalSources: this.sources.length,
        confidence: 0,
        minSourcesMet: false,
        circuitBreakerActive: true,
      });
      aggregationCounter.inc({ result: 'circuit_breaker' });
      return this.buildResult({
        price: this.lastCommittedPrice ?? 0,
        sourcesUsed: 0,
        totalSources: this.sources.length,
        aggregationMethod: 'circuit_breaker_fallback',
        sourcePrices: {},
        confidence: 0,
        trust,
        circuitBreakerActive: true,
        isFresh: false,
      });
    }

    // Check cache first
    const cacheKey = 'aggregated_price';
    const cached = cacheService.get<AggregatedPrice>(cacheKey);

    if (cached) {
      const ageMs = Math.max(0, Date.now() - new Date(cached.timestamp).getTime());
      const isFresh = ageMs <= config.sourceMaxAgeMs;
      const trust = this.evaluateTrust({
        sourcesUsed: cached.sources_used,
        totalSources: cached.total_sources,
        confidence: cached.confidence_score,
        minSourcesMet: cached.sources_used >= config.minSourcesRequired,
        circuitBreakerActive: false,
      });

      aggregationCounter.inc({ result: 'cache_hit' });
      priceAgeGauge.set({ symbol: cached.symbol }, ageMs);
      this.updateSourceMetrics();

      return {
        ...cached,
        cache_hit: true,
        age_ms: ageMs,
        is_fresh: isFresh,
        trust,
      };
    }

    // Fetch from all sources in parallel
    const prices = await this.fetchAllPrices();
    this.updateSourceMetrics();

    if (prices.length < config.minSourcesRequired) {
      this.evaluateTrust({
        sourcesUsed: prices.length,
        totalSources: this.sources.length,
        confidence: 0,
        minSourcesMet: false,
        circuitBreakerActive: false,
      });
      aggregationCounter.inc({ result: 'insufficient_sources' });
      throw new PriceOracleError(
        `Insufficient data sources (${prices.length}/${config.minSourcesRequired} required)`
      );
    }

    // Remove outliers
    let aggregationPrices = this.removeOutliers(prices);
    if (aggregationPrices.length < config.minSourcesRequired) {
      logger.warn('Too many outliers detected, using all prices');
      // Fall back to all prices if too many were filtered
      aggregationPrices = prices;
    }

    const aggregate = this.calculateAggregatedPrice(aggregationPrices);

    // Circuit breaker check
    if (this.lastCommittedPrice !== null) {
      const deviationBps =
        (Math.abs(aggregate.price - this.lastCommittedPrice) / this.lastCommittedPrice) * 10000;

      // Alert threshold
      if (deviationBps > config.deviationAlertThresholdBps) {
        const alert = {
          timestamp: new Date(),
          deviation_bps: deviationBps,
          old_price: this.lastCommittedPrice,
          new_price: aggregate.price,
        };
        this.deviationAlerts.push(alert);
        if (this.deviationAlerts.length > 100) {
          this.deviationAlerts = this.deviationAlerts.slice(-100);
        }

        logger.warn('Price deviation alert', {
          deviation_bps: deviationBps,
          old_price: this.lastCommittedPrice,
          new_price: aggregate.price,
          threshold_bps: config.deviationAlertThresholdBps,
        });
      }

      // Circuit breaker threshold
      if (deviationBps > config.circuitBreakerThresholdBps) {
        this.circuitBreakerTriggeredAt = Date.now();
        logger.error('CIRCUIT BREAKER TRIGGERED', {
          deviation_bps: deviationBps,
          old_price: this.lastCommittedPrice,
          new_price: aggregate.price,
          threshold_bps: config.circuitBreakerThresholdBps,
          pause_ms: config.circuitBreakerPauseMs,
        });

        const trust = this.evaluateTrust({
          sourcesUsed: aggregationPrices.length,
          totalSources: this.sources.length,
          confidence: aggregate.confidence,
          minSourcesMet: true,
          circuitBreakerActive: true,
        });
        aggregationCounter.inc({ result: 'circuit_breaker_triggered' });

        const breakerResult = this.buildResult({
          price: aggregate.price,
          sourcesUsed: aggregationPrices.length,
          totalSources: this.sources.length,
          aggregationMethod: 'weighted_average',
          sourcePrices: aggregate.sourcePrices,
          confidence: aggregate.confidence,
          trust,
          circuitBreakerActive: true,
          isFresh: true,
        });
        this.recordObservation(breakerResult);
        this.updatePriceMetrics(breakerResult);
        return breakerResult;
      }
    }

    const trust = this.evaluateTrust({
      sourcesUsed: aggregationPrices.length,
      totalSources: this.sources.length,
      confidence: aggregate.confidence,
      minSourcesMet: aggregationPrices.length >= config.minSourcesRequired,
      circuitBreakerActive: false,
    });

    const result = this.buildResult({
      price: aggregate.price,
      sourcesUsed: aggregationPrices.length,
      totalSources: this.sources.length,
      aggregationMethod: 'weighted_average',
      sourcePrices: aggregate.sourcePrices,
      confidence: aggregate.confidence,
      trust,
      isFresh: true,
    });

    aggregationCounter.inc({ result: 'success' });
    cacheService.set(cacheKey, result);
    this.recordObservation(result);
    this.updatePriceMetrics(result);

    return result;
  }

  /**
   * Commit the current price as the "last known" price.
   * Call after a successful aggregation cycle.
   */
  commitPrice(price: number): void {
    this.lastCommittedPrice = price;
    logger.info('Price committed', { price });
  }

  private async fetchAllPrices(): Promise<PriceData[]> {
    const now = Date.now();
    const promises = this.sources.map(async (source) => {
      try {
        const priceData = await source.fetchPrice();

        // Staleness check: exclude prices older than maxAgeMs
        const priceAge = now - priceData.timestamp.getTime();
        if (priceAge > config.sourceMaxAgeMs) {
          logger.warn('Source price too stale, excluding', {
            source: source.getName(),
            age_ms: priceAge,
            max_age_ms: config.sourceMaxAgeMs,
          });
          return null;
        }

        return priceData;
      } catch (error: any) {
        logger.warn('Failed to fetch from source', {
          source: source.getName(),
          error: error.message,
        });
        return null;
      }
    });

    const results = await Promise.allSettled(promises);

    return results
      .filter((result): result is PromiseFulfilledResult<PriceData> =>
        result.status === 'fulfilled' && result.value !== null
      )
      .map(result => result.value);
  }

  private removeOutliers(prices: PriceData[]): PriceData[] {
    if (prices.length < 3) {
      return prices; // Need at least 3 prices for outlier detection
    }

    // Calculate median
    const sortedPrices = [...prices].sort((a, b) => a.price - b.price);
    const median = sortedPrices[Math.floor(sortedPrices.length / 2)].price;

    // Filter out prices that deviate more than threshold from median
    const threshold = (config.outlierThresholdPercent / 100) * median;

    const filtered = prices.filter(p => {
      const deviation = Math.abs(p.price - median);
      const isOutlier = deviation > threshold;

      if (isOutlier) {
        logger.warn('Outlier detected', {
          source: p.source,
          price: p.price,
          median,
          deviation,
          threshold,
        });
      }

      return !isOutlier;
    });

    return filtered;
  }

  private calculateAggregatedPrice(prices: PriceData[]): AggregationResult {
    // Calculate weighted average
    let totalWeight = 0;
    let weightedSum = 0;
    const sourcePrices: Record<string, SourcePriceDetail> = {};
    const now = Date.now();

    for (const priceData of prices) {
      const weight = priceData.weight || 1.0;
      weightedSum += priceData.price * weight;
      totalWeight += weight;

      const ageMs = Math.max(0, now - priceData.timestamp.getTime());
      sourcePrices[priceData.source] = {
        price: priceData.price,
        weight,
        timestamp: priceData.timestamp,
        age_ms: ageMs,
        is_fresh: ageMs <= config.sourceMaxAgeMs,
        staleness_ms: priceData.staleness_ms,
      };
    }

    const aggregatedPrice = weightedSum / totalWeight;

    // Calculate confidence score (0-1)
    // Based on number of sources and price consistency
    const sourceRatio = Math.min(prices.length / this.sources.length, 1.0);

    // Calculate coefficient of variation (CV) for consistency
    const mean = prices.reduce((sum, p) => sum + p.price, 0) / prices.length;
    const variance = prices.reduce((sum, p) => sum + Math.pow(p.price - mean, 2), 0) / prices.length;
    const stdDev = Math.sqrt(variance);
    const cv = mean > 0 ? stdDev / mean : 0;

    // Lower CV means higher consistency
    const consistencyScore = Math.max(0, 1 - cv * 10);

    const confidenceScore = (sourceRatio * 0.6 + consistencyScore * 0.4);

    logger.info('Price aggregated', {
      price: aggregatedPrice,
      sources_used: prices.length,
      confidence: confidenceScore,
      cv,
    });

    return {
      price: aggregatedPrice,
      sourcePrices,
      confidence: confidenceScore,
    };
  }

  private evaluateTrust(input: {
    sourcesUsed: number;
    totalSources: number;
    confidence: number;
    minSourcesMet: boolean;
    circuitBreakerActive: boolean;
  }): TrustSnapshot {
    const trust = this.trust.evaluate(input);
    setTrustState(trust.state);
    return trust;
  }

  private buildResult(params: BuildResultParams): AggregatedPrice {
    return {
      schema_version: PRICE_SCHEMA_VERSION,
      method_version: PRICE_METHOD_VERSION,
      symbol: 'PI',
      price_usd: params.price,
      timestamp: new Date(),
      age_ms: params.ageMs ?? 0,
      is_fresh: params.isFresh ?? true,
      sources_used: params.sourcesUsed,
      total_sources: params.totalSources,
      aggregation_method: params.aggregationMethod,
      source_prices: params.sourcePrices,
      confidence_score: params.confidence,
      cache_hit: params.cacheHit ?? false,
      trust: params.trust,
      ...(params.circuitBreakerActive ? { circuit_breaker_active: true } : {}),
    };
  }

  private recordObservation(result: AggregatedPrice): void {
    try {
      this.store.record({
        symbol: result.symbol,
        price: result.price_usd,
        confidence: result.confidence_score,
        sourcesUsed: result.sources_used,
        trustState: result.trust.state,
        observedAt: result.timestamp.getTime(),
      });
    } catch (error) {
      // Persistence must never break price serving.
      logger.warn('Failed to persist price observation', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private updatePriceMetrics(result: AggregatedPrice): void {
    priceGauge.set({ symbol: result.symbol }, result.price_usd);
    priceConfidenceGauge.set({ symbol: result.symbol }, result.confidence_score);
    priceAgeGauge.set({ symbol: result.symbol }, result.age_ms);
  }

  private updateSourceMetrics(): void {
    for (const status of this.getAllSourceStatuses()) {
      sourceUpGauge.set({ source: status.name }, status.status === 'active' ? 1 : 0);
      sourceStalenessGauge.set({ source: status.name }, Math.max(0, status.staleness_ms));
    }
  }

  getAllSourceStatuses() {
    return this.sources.map(source => source.getStatus());
  }
}
