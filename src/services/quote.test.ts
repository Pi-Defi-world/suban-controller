import { quoteCpmm, QuoteInputError } from './quote';

describe('CPMM quote preview', () => {
  it('matches the contract integer formula and rounding', () => {
    const quote = quoteCpmm({
      reserveIn: '1000000',
      reserveOut: '1000000',
      amountIn: '1000',
      feeBps: 30,
    });

    expect(quote.amount_in_after_fee_raw).toBe('997');
    expect(quote.fee_amount_raw).toBe('3');
    expect(quote.amount_out_raw).toBe('996');
    expect(quote.price_impact_bps).toBe(40);
  });

  it('handles dust that truncates to zero output without inventing liquidity', () => {
    const quote = quoteCpmm({
      reserveIn: '1000',
      reserveOut: '1000',
      amountIn: '1',
      feeBps: 30,
    });
    expect(quote.amount_in_after_fee_raw).toBe('0');
    expect(quote.amount_out_raw).toBe('0');
    expect(quote.execution_price_out_per_in).toBe(0);
  });

  it('rejects invalid reserves, amounts and fees', () => {
    expect(() =>
      quoteCpmm({ reserveIn: '0', reserveOut: '1000', amountIn: '1', feeBps: 30 })
    ).toThrow(QuoteInputError);
    expect(() =>
      quoteCpmm({ reserveIn: '1000', reserveOut: '1000', amountIn: '0', feeBps: 30 })
    ).toThrow('amount_in must be positive');
    expect(() =>
      quoteCpmm({ reserveIn: '1000', reserveOut: '1000', amountIn: '1', feeBps: 1001 })
    ).toThrow('fee_bps');
    expect(() =>
      quoteCpmm({ reserveIn: '1.5', reserveOut: '1000', amountIn: '1', feeBps: 30 })
    ).toThrow('non-negative integer string');
  });
});
