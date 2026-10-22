/**
 * Read-only client for the Suban data platform.
 *
 * The indexed lending-risk view uses this client to obtain the latest
 * position snapshot emitted by the lending-pool contract. It never pretends
 * that an indexed snapshot is live contract storage: callers must surface the
 * returned ledger/timestamp and the `indexed_contract_events` source label.
 */
import axios from 'axios';
import { config } from '../config';

export interface IndexedPoolState {
  contract_id: string;
  contract_name: string;
  pool_kind: string;
  reserve_a_raw: string;
  reserve_b_raw: string;
  total_shares_raw: string;
  token_a: string;
  token_b: string;
  fee_bps: number | null;
  amplification: string | null;
  observed_at: string;
  ledger: number;
}

export interface IndexedLendingPosition {
  account: string;
  contract_id: string;
  contract_name: string;
  position: {
    deposit_raw: string;
    borrow_raw: string;
    collateral_raw: string;
  };
  totals: {
    total_supply_raw: string | null;
    total_borrows_raw: string | null;
    total_reserves_raw: string | null;
  };
  as_of: {
    ledger: number;
    timestamp: string;
    event_id: string;
    event_type: string;
  };
  source: string;
}

export class DataPlatformError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'DataPlatformError';
  }
}

function rawInteger(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new DataPlatformError(`Invalid ${field} in data-platform response`, 502);
  }
  return value;
}

function validatePosition(body: any): IndexedLendingPosition {
  const data = body?.data;
  if (!data || typeof data !== 'object' || !data.position || !data.as_of) {
    throw new DataPlatformError('Malformed data-platform position response', 502);
  }
  return {
    account: String(data.account || ''),
    contract_id: String(data.contract_id || ''),
    contract_name: String(data.contract_name || ''),
    position: {
      deposit_raw: rawInteger(data.position.deposit_raw, 'position.deposit_raw'),
      borrow_raw: rawInteger(data.position.borrow_raw, 'position.borrow_raw'),
      collateral_raw: rawInteger(data.position.collateral_raw, 'position.collateral_raw'),
    },
    totals: {
      total_supply_raw:
        data.totals?.total_supply_raw === null ||
        data.totals?.total_supply_raw === undefined
          ? null
          : rawInteger(data.totals.total_supply_raw, 'totals.total_supply_raw'),
      total_borrows_raw:
        data.totals?.total_borrows_raw === null ||
        data.totals?.total_borrows_raw === undefined
          ? null
          : rawInteger(data.totals.total_borrows_raw, 'totals.total_borrows_raw'),
      total_reserves_raw:
        data.totals?.total_reserves_raw === null ||
        data.totals?.total_reserves_raw === undefined
          ? null
          : rawInteger(data.totals.total_reserves_raw, 'totals.total_reserves_raw'),
    },
    as_of: {
      ledger: Number(data.as_of.ledger || 0),
      timestamp: String(data.as_of.timestamp || ''),
      event_id: String(data.as_of.event_id || ''),
      event_type: String(data.as_of.event_type || ''),
    },
    source: String(data.source || 'indexed_contract_events'),
  };
}

export async function fetchIndexedLendingPosition(
  account: string,
  options: { baseUrl?: string; apiKey?: string; timeoutMs?: number } = {}
): Promise<IndexedLendingPosition> {
  const baseUrl = options.baseUrl ?? config.dataPlatformUrl;
  const apiKey = options.apiKey ?? config.dataPlatformApiKey;
  if (!baseUrl) {
    throw new DataPlatformError(
      'DATA_PLATFORM_URL is not configured; indexed lending risk is unavailable',
      503
    );
  }

  const url = `${baseUrl.replace(/\/$/, '')}/financial/lending/accounts/${encodeURIComponent(
    account
  )}`;
  const response = await axios.get(url, {
    timeout: options.timeoutMs ?? 5_000,
    validateStatus: () => true,
    headers: apiKey ? { 'x-api-key': apiKey } : undefined,
  });

  if (response.status === 404) {
    throw new DataPlatformError('Lending position not found in indexed events', 404);
  }
  if (response.status !== 200) {
    throw new DataPlatformError(
      `Data platform returned ${response.status} for the lending position`,
      503
    );
  }
  return validatePosition(response.data);
}

export async function fetchIndexedPoolState(
  contractId: string,
  options: { baseUrl?: string; apiKey?: string; timeoutMs?: number } = {}
): Promise<IndexedPoolState> {
  const baseUrl = options.baseUrl ?? config.dataPlatformUrl;
  const apiKey = options.apiKey ?? config.dataPlatformApiKey;
  if (!baseUrl) {
    throw new DataPlatformError(
      'DATA_PLATFORM_URL is not configured; indexed pool quotes are unavailable',
      503
    );
  }

  const url = `${baseUrl.replace(/\/$/, '')}/financial/pools/${encodeURIComponent(
    contractId
  )}`;
  const response = await axios.get(url, {
    timeout: options.timeoutMs ?? 5_000,
    validateStatus: () => true,
    headers: apiKey ? { 'x-api-key': apiKey } : undefined,
  });
  if (response.status === 404) {
    throw new DataPlatformError('Pool not found in indexed events', 404);
  }
  if (response.status !== 200) {
    throw new DataPlatformError(
      `Data platform returned ${response.status} for the pool state`,
      503
    );
  }

  const data = response.data?.data;
  const state = data?.state;
  if (!state || typeof state !== 'object') {
    throw new DataPlatformError(
      'Pool has no enriched state; redeploy the pool with reserve/token events',
      503
    );
  }
  for (const field of ['reserve_a_raw', 'reserve_b_raw', 'total_shares_raw'] as const) {
    rawInteger(state[field], `state.${field}`);
  }
  if (typeof state.token_a !== 'string' || typeof state.token_b !== 'string') {
    throw new DataPlatformError('Pool state is missing token addresses', 502);
  }
  return {
    contract_id: String(data.contract_id || contractId),
    contract_name: String(data.contract_name || ''),
    pool_kind: String(data.pool_kind || ''),
    reserve_a_raw: state.reserve_a_raw,
    reserve_b_raw: state.reserve_b_raw,
    total_shares_raw: state.total_shares_raw,
    token_a: state.token_a,
    token_b: state.token_b,
    fee_bps:
      typeof state.fee_bps === 'number' && Number.isInteger(state.fee_bps)
        ? state.fee_bps
        : null,
    amplification:
      state.amplification === null || state.amplification === undefined
        ? null
        : rawInteger(state.amplification, 'state.amplification'),
    observed_at: String(state.observed_at || ''),
    ledger: Number(state.ledger || 0),
  };
}

/**
 * Convert a contract integer amount to human units without inventing decimals.
 * The caller must supply the token's configured decimals.
 */
export function rawToHuman(raw: string, decimals: number): number {
  if (!/^-?\d+$/.test(raw)) {
    throw new DataPlatformError(`Invalid raw amount: ${raw}`, 400);
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 24) {
    throw new DataPlatformError('decimals must be an integer between 0 and 24', 400);
  }
  return Number(BigInt(raw)) / 10 ** decimals;
}
