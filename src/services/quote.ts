/**
 * Deterministic CPMM quote preview.
 *
 * This mirrors `contracts/cpmm-pool/src/lib.rs` integer arithmetic exactly:
 *
 *   amount_in_after_fee = amount_in * (10_000 - fee_bps) / 10_000
 *   amount_out = reserve_out * amount_in_after_fee
 *                / (reserve_in + amount_in_after_fee)
 *
 * It is a preview, not an execution-time guarantee. The HTTP layer labels
 * whether reserves came from the request or from indexed pool events.
 */
export const QUOTE_METHOD_VERSION = 'cpmm_integer_v1';

export interface CpmmQuoteInput {
  reserveIn: string;
  reserveOut: string;
  amountIn: string;
  feeBps: number;
}

export interface CpmmQuote {
  method_version: string;
  amount_in_raw: string;
  amount_in_after_fee_raw: string;
  fee_amount_raw: string;
  amount_out_raw: string;
  fee_bps: number;
  spot_price_out_per_in: number;
  execution_price_out_per_in: number;
  price_impact_bps: number;
}

export class QuoteInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuoteInputError';
  }
}

function toUnits(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new QuoteInputError(`${field} must be non-negative`);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new QuoteInputError(`${field} must be a safe non-negative integer`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  throw new QuoteInputError(`${field} must be a non-negative integer string`);
}

function toNumber(value: bigint, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new QuoteInputError(`${field} is too large to represent`);
  }
  return number;
}

export function quoteCpmm(input: CpmmQuoteInput): CpmmQuote {
  const reserveIn = toUnits(input.reserveIn, 'reserve_in');
  const reserveOut = toUnits(input.reserveOut, 'reserve_out');
  const amountIn = toUnits(input.amountIn, 'amount_in');

  if (reserveIn <= 0n || reserveOut <= 0n) {
    throw new QuoteInputError('reserves must be positive');
  }
  if (amountIn <= 0n) {
    throw new QuoteInputError('amount_in must be positive');
  }
  if (!Number.isInteger(input.feeBps) || input.feeBps < 0 || input.feeBps > 1000) {
    throw new QuoteInputError('fee_bps must be an integer between 0 and 1000');
  }

  const amountInAfterFee = (amountIn * BigInt(10_000 - input.feeBps)) / 10_000n;
  const amountOut =
    (reserveOut * amountInAfterFee) / (reserveIn + amountInAfterFee);
  const feeAmount = amountIn - amountInAfterFee;

  const numerator = amountIn * reserveOut - amountOut * reserveIn;
  const denominator = amountIn * reserveOut;
  const rawImpactBps =
    denominator === 0n ? 0n : (numerator * 10_000n) / denominator;

  return {
    method_version: QUOTE_METHOD_VERSION,
    amount_in_raw: amountIn.toString(),
    amount_in_after_fee_raw: amountInAfterFee.toString(),
    fee_amount_raw: feeAmount.toString(),
    amount_out_raw: amountOut.toString(),
    fee_bps: input.feeBps,
    spot_price_out_per_in:
      toNumber(reserveOut, 'reserve_out') / toNumber(reserveIn, 'reserve_in'),
    execution_price_out_per_in:
      amountOut === 0n
        ? 0
        : toNumber(amountOut, 'amount_out') / toNumber(amountIn, 'amount_in'),
    price_impact_bps: rawImpactBps < 0n ? 0 : toNumber(rawImpactBps, 'price_impact'),
  };
}
