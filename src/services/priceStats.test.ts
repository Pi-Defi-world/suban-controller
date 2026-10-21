import {
  computePriceStatistics,
  MAX_WINDOW_SECONDS,
  parseAsOf,
  parseWindow,
} from './priceStats';

describe('price statistics', () => {
  const asOf = 1_700_000_000_000;

  it('parses supported windows and rejects out-of-range values', () => {
    expect(parseWindow('5m')).toEqual({ seconds: 300, label: '5m' });
    expect(parseWindow('24h')).toEqual({ seconds: 86_400, label: '24h' });
    expect(parseWindow('30d')).toEqual({ seconds: MAX_WINDOW_SECONDS, label: '30d' });
    expect(parseWindow('3600')).toEqual({ seconds: 3_600, label: '1h' });
    expect(parseWindow('31d')).toBeNull();
    expect(parseWindow('30s')).toBeNull();
    expect(parseWindow('tomorrow')).toBeNull();
  });

  it('parses ISO timestamps, epoch seconds and epoch milliseconds', () => {
    expect(parseAsOf('2023-11-14T22:13:20.000Z')).toBe(1_700_000_000_000);
    expect(parseAsOf(1_700_000_000)).toBe(1_700_000_000_000);
    expect(parseAsOf(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(parseAsOf('not-a-date')).toBeNull();
  });

  it('time-weights observations and produces reproducible summary values', () => {
    const result = computePriceStatistics(
      [
        { price: 1, observed_at: asOf - 10_800_000 },
        { price: 2, observed_at: asOf - 7_200_000 },
        { price: 3, observed_at: asOf - 3_600_000 },
      ],
      10_800,
      asOf
    );

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      method_version: 'twap_volatility_v1',
      sample_count: 3,
      twap_usd: 2,
      min_price_usd: 1,
      max_price_usd: 3,
      change_pct: 200,
      coverage_seconds: 10_800,
      coverage_ratio: 1,
      returns_count: 2,
    });
    expect(result?.realized_volatility).toBeGreaterThan(0);
    expect(result?.annualized_volatility).toBeGreaterThan(
      result?.realized_volatility ?? 0
    );
  });

  it('reports partial coverage instead of silently extending the window', () => {
    const result = computePriceStatistics(
      [{ price: 2, observed_at: asOf - 3_600_000 }],
      7_200,
      asOf
    );

    expect(result).toMatchObject({
      sample_count: 1,
      coverage_seconds: 3_600,
      coverage_ratio: 0.5,
      realized_volatility: null,
      annualized_volatility: null,
      returns_count: 0,
    });
    expect(result?.warnings).toContain('single observation; volatility is unavailable');
    expect(result?.warnings).toContain('partial window coverage');
  });

  it('returns null when no persisted observations exist in the window', () => {
    expect(
      computePriceStatistics(
        [{ price: 1, observed_at: asOf - 10_000_000 }],
        3_600,
        asOf
      )
    ).toBeNull();
  });

  it('falls back to an equal-weight mean for observations sharing a timestamp', () => {
    const result = computePriceStatistics(
      [
        { price: 1, observed_at: asOf },
        { price: 3, observed_at: asOf },
      ],
      3_600,
      asOf
    );

    expect(result?.twap_usd).toBe(2);
    expect(result?.coverage_seconds).toBe(0);
  });
});
