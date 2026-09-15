/**
 * Price aggregation service
 * Combines prices from multiple sources using weighted averages
 * with staleness checks, circuit breakers, and deviation alerts.
 */
import { PriceSource, PriceData, AggregatedPrice, SourcePriceDetail, PriceOracleError } from '../types';
import { logger } from '../utils/logger';
import { config } from '../config';
import { cacheService } from './cache';

export class PriceAggregator {
  private sources: PriceSource[] = [];
  private lastCommittedPrice: number | null = null;
  private circuitBreakerTriggeredAt: number | null = null;
  private deviationAlerts: Array<{ timestamp: Date; deviation_bps: number; old_price: number; new_price: number }> = [];

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
   * Get recent deviation alerts.
   */
  getDeviationAlerts(limit: number = 50): Array<{ timestamp: Date; deviation_bps: number; old_price: number; new_price: number }> {
    return this.deviationAlerts.slice(-limit);
  }

  async getAggregatedPrice(): Promise<AggregatedPrice> {
    // Check circuit breaker first
    if (this.isCircuitBreakerActive()) {
      logger.warn('Circuit breaker active, returning last committed price');
      return {
        symbol: 'PI',
        price_usd: this.lastCommittedPrice ?? 0,
        timestamp: new Date(),
        sources_used: 0,
        total_sources: this.sources.length,
        aggregation_method: 'circuit_breaker_fallback',
        source_prices: {},
        confidence_score: 0,
        cache_hit: false,
        circuit_breaker_active: true,
      };
    }

    // Check cache first
    const cacheKey = 'aggregated_price';
    const cached = cacheService.get<AggregatedPrice>(cacheKey);
    
    if (cached) {
      return { ...cached, cache_hit: true };
    }

    // Fetch from all sources in parallel
    const prices = await this.fetchAllPrices();

    if (prices.length < config.minSourcesRequired) {
      throw new PriceOracleError(
        `Insufficient data sources (${prices.length}/${config.minSourcesRequired} required)`
      );
    }

    // Remove outliers
    const filteredPrices = this.removeOutliers(prices);

    if (filteredPrices.length < config.minSourcesRequired) {
      logger.warn('Too many outliers detected, using all prices');
      // Fall back to all prices if too many were filtered
      return this.calculateAggregatedPrice(prices, false);
    }

    const result = this.calculateAggregatedPrice(filteredPrices, false);
    
    // Circuit breaker check
    if (this.lastCommittedPrice !== null) {
      const deviationBps = Math.abs(result.price_usd - this.lastCommittedPrice) / this.lastCommittedPrice * 10000;

      // Alert threshold
      if (deviationBps > config.deviationAlertThresholdBps) {
        const alert = {
          timestamp: new Date(),
          deviation_bps: deviationBps,
          old_price: this.lastCommittedPrice,
          new_price: result.price_usd,
        };
        this.deviationAlerts.push(alert);
        if (this.deviationAlerts.length > 100) {
          this.deviationAlerts = this.deviationAlerts.slice(-100);
        }

        logger.warn('Price deviation alert', {
          deviation_bps: deviationBps,
          old_price: this.lastCommittedPrice,
          new_price: result.price_usd,
          threshold_bps: config.deviationAlertThresholdBps,
        });
      }

      // Circuit breaker threshold
      if (deviationBps > config.circuitBreakerThresholdBps) {
        this.circuitBreakerTriggeredAt = Date.now();
        logger.error('CIRCUIT BREAKER TRIGGERED', {
          deviation_bps: deviationBps,
          old_price: this.lastCommittedPrice,
          new_price: result.price_usd,
          threshold_bps: config.circuitBreakerThresholdBps,
          pause_ms: config.circuitBreakerPauseMs,
        });
        return {
          ...result,
          circuit_breaker_active: true,
        };
      }
    }

    // Cache the result
    cacheService.set(cacheKey, result);

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

  private calculateAggregatedPrice(prices: PriceData[], cacheHit: boolean): AggregatedPrice {
    // Calculate weighted average
    let totalWeight = 0;
    let weightedSum = 0;
    const sourcePrices: Record<string, SourcePriceDetail> = {};

    for (const priceData of prices) {
      const weight = priceData.weight || 1.0;
      weightedSum += priceData.price * weight;
      totalWeight += weight;

      sourcePrices[priceData.source] = {
        price: priceData.price,
        weight,
        timestamp: priceData.timestamp,
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
      symbol: 'PI',
      price_usd: aggregatedPrice,
      timestamp: new Date(),
      sources_used: prices.length,
      total_sources: this.sources.length,
      aggregation_method: 'weighted_average',
      source_prices: sourcePrices,
      confidence_score: confidenceScore,
      cache_hit: cacheHit,
    };
  }

  getAllSourceStatuses() {
    return this.sources.map(source => source.getStatus());
  }
}
