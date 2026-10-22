/**
 * CPMM route discovery over indexed pool state.
 *
 * This module only considers pools that the data platform has actually
 * observed with enriched token/reserve/fee state. It never synthesizes a venue
 * or assumes liquidity that is not indexed. Routes are previews over indexed
 * state and can lag the chain; they are not execution guarantees.
 */
import { quoteCpmm } from './quote';

export const ROUTE_METHOD_VERSION = 'cpmm_route_v1';
export const MAX_ROUTE_HOPS = 3;

export interface RoutePool {
  contract_id: string;
  pool_kind: string;
  token_a: string;
  token_b: string;
  reserve_a_raw: string;
  reserve_b_raw: string;
  fee_bps: number;
  ledger: number;
  observed_at: string;
}

export interface RouteHop {
  pool_contract_id: string;
  token_in: string;
  token_out: string;
  reserve_in_raw: string;
  reserve_out_raw: string;
  fee_bps: number;
  amount_in_raw: string;
  amount_out_raw: string;
  price_impact_bps: number;
}

export interface CpmmRoute {
  method_version: string;
  token_in: string;
  token_out: string;
  amount_in_raw: string;
  amount_out_raw: string;
  hop_count: number;
  hops: RouteHop[];
  source_ledger_min: number;
  source_ledger_max: number;
}

export class RouteInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteInputError';
  }
}

function positiveInteger(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || BigInt(value) <= 0n) {
    throw new RouteInputError(`${field} must be a positive integer string`);
  }
  return BigInt(value);
}

function usablePool(pool: RoutePool): boolean {
  return (
    pool.pool_kind === 'cpmm' &&
    typeof pool.token_a === 'string' &&
    typeof pool.token_b === 'string' &&
    pool.token_a !== pool.token_b &&
    Number.isInteger(pool.fee_bps) &&
    pool.fee_bps >= 0 &&
    pool.fee_bps <= 1000 &&
    /^\d+$/.test(pool.reserve_a_raw) &&
    /^\d+$/.test(pool.reserve_b_raw) &&
    BigInt(pool.reserve_a_raw) > 0n &&
    BigInt(pool.reserve_b_raw) > 0n
  );
}

function direction(pool: RoutePool, tokenIn: string) {
  if (pool.token_a === tokenIn) {
    return {
      tokenOut: pool.token_b,
      reserveIn: pool.reserve_a_raw,
      reserveOut: pool.reserve_b_raw,
    };
  }
  if (pool.token_b === tokenIn) {
    return {
      tokenOut: pool.token_a,
      reserveIn: pool.reserve_b_raw,
      reserveOut: pool.reserve_a_raw,
    };
  }
  return null;
}

function better(
  candidate: { amountOut: bigint; hops: RouteHop[] },
  current: { amountOut: bigint; hops: RouteHop[] } | null
): boolean {
  if (!current) return true;
  if (candidate.amountOut !== current.amountOut) {
    return candidate.amountOut > current.amountOut;
  }
  return candidate.hops.length < current.hops.length;
}

/**
 * Find the best CPMM route between two tokens using only the supplied pools.
 * Returns `null` when no route with real indexed liquidity exists.
 */
export function findBestCpmmRoute(
  pools: RoutePool[],
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  maxHops: number = 2
): CpmmRoute | null {
  const amount = positiveInteger(amountIn, 'amount_in');
  if (!tokenIn || !tokenOut) {
    throw new RouteInputError('token_in and token_out are required');
  }
  if (tokenIn === tokenOut) {
    throw new RouteInputError('token_in and token_out must differ');
  }
  if (!Number.isInteger(maxHops) || maxHops < 1 || maxHops > MAX_ROUTE_HOPS) {
    throw new RouteInputError(`max_hops must be an integer between 1 and ${MAX_ROUTE_HOPS}`);
  }

  const byToken = new Map<string, RoutePool[]>();
  for (const pool of pools) {
    if (!usablePool(pool)) continue;
    for (const token of [pool.token_a, pool.token_b]) {
      const list = byToken.get(token) || [];
      list.push(pool);
      byToken.set(token, list);
    }
  }
  for (const list of byToken.values()) {
    list.sort((a, b) => a.contract_id.localeCompare(b.contract_id));
  }

  let best: { amountOut: bigint; hops: RouteHop[] } | null = null;

  const walk = (
    currentToken: string,
    currentAmount: bigint,
    remainingHops: number,
    visitedTokens: Set<string>,
    hops: RouteHop[]
  ) => {
    if (remainingHops === 0) return;
    const edgePools = byToken.get(currentToken);
    if (!edgePools) return;

    for (const pool of edgePools) {
      if (visitedTokens.has(pool.token_a) && visitedTokens.has(pool.token_b)) {
        // Both ends already visited would create a cycle; never beneficial.
        continue;
      }
      const leg = direction(pool, currentToken);
      if (!leg) continue;
      if (visitedTokens.has(leg.tokenOut)) continue;

      const quote = quoteCpmm({
        reserveIn: leg.reserveIn,
        reserveOut: leg.reserveOut,
        amountIn: currentAmount.toString(),
        feeBps: pool.fee_bps,
      });
      const amountOut = BigInt(quote.amount_out_raw);
      if (amountOut === 0n) continue;

      const hop: RouteHop = {
        pool_contract_id: pool.contract_id,
        token_in: currentToken,
        token_out: leg.tokenOut,
        reserve_in_raw: leg.reserveIn,
        reserve_out_raw: leg.reserveOut,
        fee_bps: pool.fee_bps,
        amount_in_raw: currentAmount.toString(),
        amount_out_raw: amountOut.toString(),
        price_impact_bps: quote.price_impact_bps,
      };
      const nextHops = [...hops, hop];

      if (leg.tokenOut === tokenOut) {
        if (better({ amountOut, hops: nextHops }, best)) {
          best = { amountOut, hops: nextHops };
        }
        continue;
      }

      const nextVisited = new Set(visitedTokens);
      nextVisited.add(leg.tokenOut);
      walk(leg.tokenOut, amountOut, remainingHops - 1, nextVisited, nextHops);
    }
  };

  walk(tokenIn, amount, maxHops, new Set([tokenIn]), []);

  if (!best) return null;
  const resolved = best as { amountOut: bigint; hops: RouteHop[] };
  const ledgers = resolved.hops.map((hop) => {
    const pool = pools.find((candidate) => candidate.contract_id === hop.pool_contract_id);
    return pool ? pool.ledger : 0;
  });

  return {
    method_version: ROUTE_METHOD_VERSION,
    token_in: tokenIn,
    token_out: tokenOut,
    amount_in_raw: amount.toString(),
    amount_out_raw: resolved.amountOut.toString(),
    hop_count: resolved.hops.length,
    hops: resolved.hops,
    source_ledger_min: Math.min(...ledgers),
    source_ledger_max: Math.max(...ledgers),
  };
}
