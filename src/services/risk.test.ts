import {
  computeLendingRisk,
  RISK_METHOD_VERSION,
  RiskInputError,
} from './risk';

describe('lending risk', () => {
  it('computes deterministic health factor, max borrow and liquidation price', () => {
    const result = computeLendingRisk({
      collateral: [{ asset: 'PI', amount: 100, price_usd: 0.1 }],
      debt: [{ asset: 'USDC', amount: 5, price_usd: 1 }],
      liquidation_threshold: 0.8,
      target_health_factor: 1.5,
    });

    expect(result.method_version).toBe(RISK_METHOD_VERSION);
    expect(result.status).toBe('healthy');
    expect(result.health_factor).toBeCloseTo(1.6, 12);
    expect(result.collateral_value_usd).toBeCloseTo(10, 12);
    expect(result.debt_value_usd).toBeCloseTo(5, 12);
    expect(result.max_borrow_usd).toBeCloseTo(5.333333333333, 10);
    expect(result.liquidation_price_usd_per_collateral_unit).toBeCloseTo(
      0.0625,
      12
    );
    expect(result.liquidation_price_asset).toBe('PI');
    expect(result.warnings).toEqual([]);
  });

  it('marks a position at risk when the health factor is below the target', () => {
    const result = computeLendingRisk({
      collateral: [{ asset: 'PI', amount: 100, price_usd: 0.1 }],
      debt: [{ asset: 'USDC', amount: 5, price_usd: 1 }],
      liquidation_threshold: 0.8,
      target_health_factor: 2,
    });

    expect(result.status).toBe('at_risk');
    expect(result.health_factor).toBeCloseTo(1.6, 12);
  });

  it('marks a position healthy when the health factor exceeds the target', () => {
    const result = computeLendingRisk({
      collateral: [{ asset: 'PI', amount: 100, price_usd: 0.1 }],
      debt: [{ asset: 'USDC', amount: 1, price_usd: 1 }],
    });

    expect(result.status).toBe('healthy');
    expect(result.health_factor).toBeCloseTo(8, 12);
  });

  it('marks a position liquidatable below a health factor of one', () => {
    const result = computeLendingRisk({
      collateral: [{ asset: 'PI', amount: 10, price_usd: 0.1 }],
      debt: [{ asset: 'USDC', amount: 1, price_usd: 1 }],
    });

    expect(result.status).toBe('liquidatable');
    expect(result.health_factor).toBeCloseTo(0.8, 12);
  });

  it('returns no_debt without inventing a health factor', () => {
    const result = computeLendingRisk({
      collateral: [{ asset: 'PI', amount: 10, price_usd: 0.1 }],
      debt: [],
    });

    expect(result.status).toBe('no_debt');
    expect(result.health_factor).toBeNull();
    expect(result.liquidation_price_usd_per_collateral_unit).toBeNull();
    expect(result.max_borrow_usd).toBeCloseTo(0.533333333333, 10);
  });

  it('does not publish a basket liquidation price for multiple collateral assets', () => {
    const result = computeLendingRisk({
      collateral: [
        { asset: 'PI', amount: 10, price_usd: 0.1 },
        { asset: 'USDC', amount: 10, price_usd: 1 },
      ],
      debt: [{ asset: 'USDC', amount: 5, price_usd: 1 }],
    });

    expect(result.liquidation_price_usd_per_collateral_unit).toBeNull();
    expect(result.warnings.join(' ')).toContain('multi-collateral');
  });

  it('rejects invalid thresholds and prices', () => {
    expect(() =>
      computeLendingRisk({
        collateral: [{ asset: 'PI', amount: 1, price_usd: 1 }],
        debt: [],
        liquidation_threshold: 0,
      })
    ).toThrow(RiskInputError);

    expect(() =>
      computeLendingRisk({
        collateral: [{ asset: 'PI', amount: 1, price_usd: 0 }],
        debt: [],
      })
    ).toThrow(RiskInputError);
  });
});
