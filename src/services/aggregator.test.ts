import { PriceAggregator } from './aggregator';
import { PriceData, PriceSource } from '../types';
import { PriceObservationInput } from './priceStore';
import { TrustStateMachine } from './trustState';
import { cacheService } from './cache';

class FakeSource extends PriceSource {
  constructor(name: string, public price: number, weight: number = 1) {
    super(name, weight, 'PIUSDT');
  }

  async fetchPrice(): Promise<PriceData> {
    return {
      price: this.price,
      timestamp: new Date(),
      source: this.getName(),
      weight: this.getWeight(),
    };
  }
}

class RecordingStore {
  observations: PriceObservationInput[] = [];

  record(observation: PriceObservationInput): void {
    this.observations.push(observation);
  }
}

describe('PriceAggregator', () => {
  beforeEach(() => {
    cacheService.flush();
  });

  it('adds provenance, freshness and trust to a fresh aggregation', async () => {
    const recorder = new RecordingStore();
    const aggregator = new PriceAggregator({ store: recorder });

    aggregator.addSource(new FakeSource('alpha', 1));
    aggregator.addSource(new FakeSource('beta', 1));

    const result = await aggregator.getAggregatedPrice();

    expect(result.schema_version).toBe('1.0');
    expect(result.method_version).toBe('weighted_average_v1');
    expect(result.price_usd).toBeCloseTo(1);
    expect(result.sources_used).toBe(2);
    expect(result.total_sources).toBe(2);
    expect(result.cache_hit).toBe(false);
    expect(result.age_ms).toBeGreaterThanOrEqual(0);
    expect(result.is_fresh).toBe(true);
    expect(result.trust.state).toBe('HEALTHY');
    expect(result.source_prices.alpha).toMatchObject({
      price: 1,
      is_fresh: true,
    });
    expect(result.source_prices.alpha.age_ms).toBeGreaterThanOrEqual(0);

    expect(recorder.observations).toHaveLength(1);
    expect(recorder.observations[0]).toMatchObject({
      symbol: 'PI',
      price: 1,
      sourcesUsed: 2,
      trustState: 'HEALTHY',
    });
  });

  it('keeps cache and provenance isolated per asset symbol', async () => {
    const recorder = new RecordingStore();
    const pi = new PriceAggregator({ symbol: 'PI', store: recorder });
    pi.addSource(new FakeSource('alpha', 1));
    const usdc = new PriceAggregator({ symbol: 'USDC', store: recorder });
    usdc.addSource(new FakeSource('alpha', 1.01));

    const piPrice = await pi.getAggregatedPrice();
    const usdcPrice = await usdc.getAggregatedPrice();

    expect(piPrice.symbol).toBe('PI');
    expect(piPrice.price_usd).toBeCloseTo(1);
    expect(usdcPrice.symbol).toBe('USDC');
    expect(usdcPrice.price_usd).toBeCloseTo(1.01);
    expect(usdcPrice.cache_hit).toBe(false);
    expect(recorder.observations.map((o) => o.symbol)).toEqual(
      expect.arrayContaining(['PI', 'USDC'])
    );
  });

  it('serves cache hits without writing duplicate observations', async () => {
    const recorder = new RecordingStore();
    const aggregator = new PriceAggregator({ store: recorder });
    aggregator.addSource(new FakeSource('alpha', 1));
    aggregator.addSource(new FakeSource('beta', 1));

    const first = await aggregator.getAggregatedPrice();
    const second = await aggregator.getAggregatedPrice();

    expect(second.cache_hit).toBe(true);
    expect(second.price_usd).toBe(first.price_usd);
    expect(second.age_ms).toBeGreaterThanOrEqual(0);
    expect(recorder.observations).toHaveLength(1);
  });

  it('rejects when there are not enough usable sources', async () => {
    const aggregator = new PriceAggregator({ store: new RecordingStore() });

    await expect(aggregator.getAggregatedPrice()).rejects.toThrow(
      /Insufficient data sources/
    );
    expect(aggregator.getTrustState().state).toBe('DEGRADED');
  });

  it('triggers the breaker, falls back, then recovers through RECOVERY', async () => {
    const recorder = new RecordingStore();
    const trust = new TrustStateMachine({ recoveryStreak: 2 });
    const aggregator = new PriceAggregator({ store: recorder, trust });
    const alpha = new FakeSource('alpha', 1);
    const beta = new FakeSource('beta', 1);
    aggregator.addSource(alpha);
    aggregator.addSource(beta);

    const first = await aggregator.getAggregatedPrice();
    aggregator.commitPrice(first.price_usd);

    alpha.price = 2;
    beta.price = 2;
    cacheService.flush();

    const triggered = await aggregator.getAggregatedPrice();
    expect(triggered.circuit_breaker_active).toBe(true);
    expect(triggered.trust.state).toBe('BREAKER');
    expect(aggregator.isCircuitBreakerActive()).toBe(true);

    const fallback = await aggregator.getAggregatedPrice();
    expect(fallback.aggregation_method).toBe('circuit_breaker_fallback');
    expect(fallback.price_usd).toBe(1);
    expect(fallback.trust.state).toBe('BREAKER');
    expect(fallback.is_fresh).toBe(false);

    aggregator.resetCircuitBreaker();
    alpha.price = 1;
    beta.price = 1;
    cacheService.flush();

    const recovering = await aggregator.getAggregatedPrice();
    expect(recovering.trust.state).toBe('RECOVERY');

    cacheService.flush();
    const healthy = await aggregator.getAggregatedPrice();
    expect(healthy.trust.state).toBe('HEALTHY');
  });
});
