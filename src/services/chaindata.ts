/**
 * On-chain data service for Suban Controller
 * Fetches blockchain analytics from our local Horizon nodes
 */
import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

const cache = new Map<string, { data: any; expiry: number }>();

function getCached(key: string): any | null {
  const entry = cache.get(key);
  if (entry && Date.now() < entry.expiry) return entry.data;
  cache.delete(key);
  return null;
}

function setCache(key: string, data: any, ttlSeconds: number): void {
  cache.set(key, { data, expiry: Date.now() + ttlSeconds * 1000 });
}

function getHorizonUrl(): string {
  return config.network === 'testnet' ? config.horizon.testnet : config.horizon.mainnet;
}

export interface LedgerStats {
  sequence: number;
  transaction_count: number;
  operation_count: number;
  closed_at: string;
  hash: string;
}

export interface NetworkStats {
  latest_ledger: number;
  total_accounts: number;
  total_transactions: number;
  total_operations: number;
  ledger_close_time_avg_ms: number;
  network: string;
}

export interface AccountInfo {
  account_id: string;
  balances: Array<{
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    balance: string;
  }>;
  sequence: string;
  subentry_count: number;
  last_modified_ledger: number;
}

/**
 * Get the latest ledgers from Horizon
 */
export async function getLatestLedgers(limit: number = 10): Promise<LedgerStats[]> {
  const cacheKey = `ledgers:${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const url = `${getHorizonUrl()}/ledgers?order=desc&limit=${limit}`;
    const response = await axios.get(url, { timeout: 10000 });
    const ledgers = response.data._embedded.records.map((r: any) => ({
      sequence: r.sequence,
      transaction_count: r.transaction_count,
      operation_count: r.operation_count,
      closed_at: r.closed_at,
      hash: r.hash,
    }));

    setCache(cacheKey, ledgers, config.chainDataCacheTTL);
    return ledgers;
  } catch (error: any) {
    logger.error('Failed to fetch ledgers', { error: error.message });
    throw error;
  }
}

/**
 * Get network-wide statistics
 */
export async function getNetworkStats(): Promise<NetworkStats> {
  const cacheKey = 'network-stats';
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    // Get latest ledger
    const ledgerRes = await axios.get(`${getHorizonUrl()}/ledgers?order=desc&limit=1`, { timeout: 10000 });
    const latestLedger = ledgerRes.data._embedded.records[0];

    // Get accounts count
    const accountsRes = await axios.get(`${getHorizonUrl()}/accounts?order=desc&limit=1`, { timeout: 10000 });
    const totalAccounts = parseInt(accountsRes.data._links?.self?.href?.match(/cursor=(\d+)/)?.[1] || '0') || accountsRes.data._embedded.records.length;

    // Get recent ledgers for avg close time
    const recentLedgers = await getLatestLedgers(20);
    let avgCloseTimeMs = 5000; // default 5s
    if (recentLedgers.length >= 2) {
      const times = [];
      for (let i = 0; i < recentLedgers.length - 1; i++) {
        const t1 = new Date(recentLedgers[i].closed_at).getTime();
        const t2 = new Date(recentLedgers[i + 1].closed_at).getTime();
        times.push(Math.abs(t1 - t2));
      }
      avgCloseTimeMs = times.reduce((a, b) => a + b, 0) / times.length;
    }

    // Get transactions count from recent ledgers
    const totalTransactions = recentLedgers.reduce((sum, l) => sum + l.transaction_count, 0);
    const totalOperations = recentLedgers.reduce((sum, l) => sum + l.operation_count, 0);

    const stats: NetworkStats = {
      latest_ledger: latestLedger.sequence,
      total_accounts: totalAccounts,
      total_transactions: totalTransactions,
      total_operations: totalOperations,
      ledger_close_time_avg_ms: Math.round(avgCloseTimeMs),
      network: config.network,
    };

    setCache(cacheKey, stats, config.chainDataCacheTTL);
    return stats;
  } catch (error: any) {
    logger.error('Failed to fetch network stats', { error: error.message });
    throw error;
  }
}

/**
 * Get account information from Horizon
 */
export async function getAccountInfo(accountId: string): Promise<AccountInfo> {
  const cacheKey = `account:${accountId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const url = `${getHorizonUrl()}/accounts/${accountId}`;
    const response = await axios.get(url, { timeout: 10000 });
    const account = response.data;

    const info: AccountInfo = {
      account_id: account.account_id,
      balances: account.balances,
      sequence: account.sequence,
      subentry_count: account.subentry_count,
      last_modified_ledger: account.last_modified_ledger,
    };

    setCache(cacheKey, info, config.chainDataCacheTTL);
    return info;
  } catch (error: any) {
    logger.error('Failed to fetch account info', { accountId, error: error.message });
    throw error;
  }
}

/**
 * Get recent transactions from Horizon
 */
export async function getRecentTransactions(limit: number = 20): Promise<any[]> {
  const cacheKey = `transactions:${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const url = `${getHorizonUrl()}/transactions?order=desc&limit=${limit}`;
    const response = await axios.get(url, { timeout: 10000 });
    const transactions = response.data._embedded.records.map((r: any) => ({
      hash: r.hash,
      ledger: r.ledger,
      created_at: r.created_at,
      source_account: r.source_account,
      fee_charged: r.fee_charged,
      operation_count: r.operation_count,
      memo: r.memo,
    }));

    setCache(cacheKey, transactions, config.chainDataCacheTTL);
    return transactions;
  } catch (error: any) {
    logger.error('Failed to fetch transactions', { error: error.message });
    throw error;
  }
}

/**
 * Get top accounts by balance
 */
export async function getTopAccounts(limit: number = 10): Promise<any[]> {
  const cacheKey = `top-accounts:${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    // Horizon doesn't have a direct "sort by balance" endpoint
    // We get recent accounts and sort by native balance
    const url = `${getHorizonUrl()}/accounts?order=desc&limit=${limit * 2}`;
    const response = await axios.get(url, { timeout: 10000 });

    const accounts = response.data._embedded.records
      .map((r: any) => ({
        account_id: r.account_id,
        native_balance: r.balances.find((b: any) => b.asset_type === 'native')?.balance || '0',
        total_trustlines: r.balances.length,
        subentry_count: r.subentry_count,
      }))
      .sort((a: any, b: any) => parseFloat(b.native_balance) - parseFloat(a.native_balance))
      .slice(0, limit);

    setCache(cacheKey, accounts, config.chainDataCacheTTL);
    return accounts;
  } catch (error: any) {
    logger.error('Failed to fetch top accounts', { error: error.message });
    throw error;
  }
}
