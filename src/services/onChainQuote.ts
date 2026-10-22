/**
 * On-chain CPMM quote simulation.
 *
 * Unlike the deterministic previews in `quote.ts` and the indexed-state route,
 * this module calls the deployed contract's read-only `get_quote` view through
 * Soroban simulation. It requires an existing source account because Soroban
 * simulation builds a transaction envelope; no key is signed or submitted.
 */
import { contract, Keypair } from '@stellar/stellar-sdk';
import { config } from '../config';
import { quoteCpmm } from './quote';

export class QuoteSimulationError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'QuoteSimulationError';
  }
}

export interface SimulatedCpmmQuote {
  contract_id: string;
  token_in: string;
  token_out: string;
  amount_in_raw: string;
  amount_out_raw: string;
  reserve_in_raw: string;
  reserve_out_raw: string;
  fee_bps: number;
  ledger: number;
  preview_amount_out_raw: string;
  parity: boolean;
}

interface SimulationOptions {
  rpcUrl?: string;
  networkPassphrase?: string;
  sourceAccount?: string;
}

function unwrap(result: unknown): unknown {
  if (result && typeof result === 'object' && 'value' in (result as object)) {
    const value = (result as { value?: unknown }).value;
    if (value !== undefined) return value;
  }
  if (result && typeof result === 'object' && 'error' in (result as object)) {
    throw new QuoteSimulationError('The contract returned an error during simulation', 503);
  }
  return result;
}

async function simulate(
  client: any,
  method: string,
  args: unknown[]
): Promise<{ value: unknown; ledger: number }> {
  try {
    const tx = await client[method](...args);
    const simulated = await tx.simulate();
    return {
      value: unwrap(simulated?.result),
      ledger: Number(simulated?.simulation?.latestLedger || 0),
    };
  } catch (error: any) {
    if (error instanceof QuoteSimulationError) throw error;
    throw new QuoteSimulationError(
      `Contract simulation failed: ${error?.message || 'unknown RPC error'}`,
      503
    );
  }
}

/**
 * Simulate `get_quote` against a deployed CPMM pool and compare it with the
 * shared deterministic formula. Throws `QuoteSimulationError` with a 503 when
 * simulation is not configured or the RPC is unavailable.
 */
export async function simulateCpmmQuote(
  params: { contractId: string; tokenIn: string; amountIn: string },
  options: SimulationOptions = {}
): Promise<SimulatedCpmmQuote> {
  const rpcUrl = options.rpcUrl ?? config.quoteSimulationRpcUrl;
  const networkPassphrase =
    options.networkPassphrase ?? config.quoteSimulationNetworkPassphrase;
  const sourceAccount = options.sourceAccount ?? config.quoteSimulationSourceAccount;

  if (!sourceAccount) {
    throw new QuoteSimulationError(
      'QUOTE_SIMULATION_SOURCE_ACCOUNT is not configured; on-chain quote simulation is unavailable',
      503
    );
  }
  if (!/^\d+$/.test(params.amountIn) || BigInt(params.amountIn) <= 0n) {
    throw new QuoteSimulationError('amount_in must be a positive integer string', 400);
  }

  let client: any;
  try {
    const keypair = Keypair.fromPublicKey(sourceAccount);
    client = await contract.Client.from({
      contractId: params.contractId,
      networkPassphrase,
      rpcUrl,
      publicKey: keypair.publicKey(),
    });
  } catch (error: any) {
    throw new QuoteSimulationError(
      `Unable to create a simulation client: ${error?.message || 'invalid configuration'}`,
      503
    );
  }

  let tokenA: string;
  let tokenB: string;
  let feeBps: number;
  let reserves: [unknown, unknown];
  try {
    [tokenA, tokenB, feeBps, reserves] = await Promise.all([
      simulate(client, 'get_token_a', []).then((r) => String(r.value)),
      simulate(client, 'get_token_b', []).then((r) => String(r.value)),
      simulate(client, 'get_fee_bps', []).then((r) => Number(r.value)),
      simulate(client, 'get_reserves', []).then(
        (r) => r.value as [unknown, unknown]
      ),
    ]);
  } catch (error: any) {
    if (error instanceof QuoteSimulationError) throw error;
    throw new QuoteSimulationError(
      'The contract does not expose CPMM state or is not deployed',
      503
    );
  }

  if (params.tokenIn !== tokenA && params.tokenIn !== tokenB) {
    throw new QuoteSimulationError(
      'token_in is not one of the pool tokens',
      400
    );
  }
  if (!Array.isArray(reserves) || reserves.length !== 2) {
    throw new QuoteSimulationError('The contract returned malformed reserves', 502);
  }
  const tokenIn = params.tokenIn;
  const tokenOut = tokenIn === tokenA ? tokenB : tokenA;
  const reserveIn = String(tokenIn === tokenA ? reserves[0] : reserves[1]);
  const reserveOut = String(tokenIn === tokenA ? reserves[1] : reserves[0]);
  if (!/^\d+$/.test(reserveIn) || !/^\d+$/.test(reserveOut)) {
    throw new QuoteSimulationError('The contract returned malformed reserves', 502);
  }

  const quote = await simulate(client, 'get_quote', [
    { token_in: tokenIn, amount_in: BigInt(params.amountIn) },
  ]);
  const onChain = String(quote.value);
  if (!/^\d+$/.test(onChain)) {
    throw new QuoteSimulationError('The contract returned a malformed quote', 502);
  }

  const preview = quoteCpmm({
    reserveIn,
    reserveOut,
    amountIn: params.amountIn,
    feeBps,
  });

  return {
    contract_id: params.contractId,
    token_in: tokenIn,
    token_out: tokenOut,
    amount_in_raw: params.amountIn,
    amount_out_raw: onChain,
    reserve_in_raw: reserveIn,
    reserve_out_raw: reserveOut,
    fee_bps: feeBps,
    ledger: quote.ledger,
    preview_amount_out_raw: preview.amount_out_raw,
    parity: preview.amount_out_raw === onChain,
  };
}
