/**
 * Type definitions for the Pi Price Oracle
 */

export interface PriceData {
  price: number;
  timestamp: Date;
  source: string;
  weight?: number;
  /** How old the price is at the source (ms since last update). 0 = fresh. */
  staleness_ms?: number;
}

export interface AggregatedPrice {
  symbol: string;
  price_usd: number;
  timestamp: Date;
  sources_used: number;
  total_sources: number;
  aggregation_method: string;
  source_prices: Record<string, SourcePriceDetail>;
  confidence_score: number;
  cache_hit: boolean;
  /** Set to true if circuit breaker was triggered and price is from last committed */
  circuit_breaker_active?: boolean;
}

export interface SourcePriceDetail {
  price: number;
  weight: number;
  timestamp: Date;
  staleness_ms?: number;
}

export interface SourceStatus {
  name: string;
  status: 'active' | 'error' | 'disabled' | 'stale';
  last_success: Date | null;
  last_error: string | null;
  success_rate: number;
  avg_response_time_ms: number;
  /** How stale the last successful price is (ms). -1 = unknown. */
  staleness_ms: number;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  timestamp: Date;
  active_sources: number;
  total_sources: number;
  last_price_usd: number | null;
  circuit_breaker_active: boolean;
}

export interface SourceConfig {
  name: string;
  enabled: boolean;
  weight: number;
  symbol: string;
  apiKey?: string;
  apiSecret?: string;
}

export abstract class PriceSource {
  protected name: string;
  protected weight: number;
  protected symbol: string;
  protected lastSuccess: Date | null = null;
  protected lastError: string | null = null;
  protected successCount: number = 0;
  protected errorCount: number = 0;
  protected responseTimes: number[] = [];
  protected lastPriceTimestamp: Date | null = null;

  constructor(name: string, weight: number, symbol: string) {
    this.name = name;
    this.weight = weight;
    this.symbol = symbol;
  }

  abstract fetchPrice(): Promise<PriceData>;

  getName(): string {
    return this.name;
  }

  getWeight(): number {
    return this.weight;
  }

  /** Returns staleness in ms of last successful fetch, or -1 if unknown. */
  getStalenessMs(): number {
    if (!this.lastPriceTimestamp) return -1;
    return Date.now() - this.lastPriceTimestamp.getTime();
  }

  getStatus(): SourceStatus {
    const totalRequests = this.successCount + this.errorCount;
    const successRate = totalRequests > 0 ? this.successCount / totalRequests : 0;
    const avgResponseTime = 
      this.responseTimes.length > 0
        ? this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length
        : 0;

    const stalenessMs = this.getStalenessMs();
    const isStale = stalenessMs > 30000; // 30s threshold for status

    return {
      name: this.name,
      status: this.errorCount > 0 && this.successCount === 0
        ? 'error'
        : isStale
          ? 'stale'
          : 'active',
      last_success: this.lastSuccess,
      last_error: this.lastError,
      success_rate: successRate,
      avg_response_time_ms: avgResponseTime,
      staleness_ms: stalenessMs,
    };
  }

  protected recordSuccess(responseTime: number): void {
    this.successCount++;
    this.lastSuccess = new Date();
    this.lastPriceTimestamp = new Date();
    this.responseTimes.push(responseTime);
    
    // Keep only last 100 response times
    if (this.responseTimes.length > 100) {
      this.responseTimes.shift();
    }
  }

  protected recordError(error: string): void {
    this.errorCount++;
    this.lastError = error;
  }
}

export class PriceOracleError extends Error {
  constructor(message: string, public source?: string) {
    super(message);
    this.name = 'PriceOracleError';
  }
}

export class SourceError extends Error {
  constructor(message: string, public source: string) {
    super(message);
    this.name = 'SourceError';
  }
}

