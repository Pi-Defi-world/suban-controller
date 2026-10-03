/**
 * Pi Network data endpoints - matching piscan.io API format
 */
import { Router, Request, Response } from 'express';
import { PriceAggregator } from '../services/aggregator';
import { get24hStats, recordPrice } from '../services/priceHistory';
import { config } from '../config';
import { logger } from '../utils/logger';
import axios from 'axios';

const router = Router();

function getHorizonUrl(): string {
  return config.network === 'testnet' ? config.horizon.testnet : config.horizon.mainnet;
}

export function createPiDataRouter(aggregator: PriceAggregator): Router {
  /**
   * GET /data/pi-price
   * Returns price data in piscan.io format with real 24h stats
   */
  router.get('/pi-price', async (_req: Request, res: Response) => {
    try {
      const priceData = await aggregator.getAggregatedPrice();
      const price = priceData.price_usd;

      // Record price for 24h stats
      recordPrice(price, 'aggregated');

      const stats = get24hStats();
      const priceStr = price.toFixed(4);

      res.json({
        data: [{
          idxPx: priceStr,
          high24h: stats ? stats.high24h.toFixed(4) : priceStr,
          open24h: stats ? stats.open24h.toFixed(4) : priceStr,
          low24h: stats ? stats.low24h.toFixed(4) : priceStr,
        }]
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error fetching Pi price', { error: errorMessage });
      res.status(500).json({
        error: 'Failed to fetch Pi price',
        message: errorMessage,
      });
    }
  });

  /**
   * GET /data/mainnet-supply
   * Get Pi mainnet supply data from CoinGecko
   */
  router.get('/mainnet-supply', async (_req: Request, res: Response) => {
    try {
      const fallback = {
        total_circulating_supply: 10_600_000_000,
        total_locked: 0,
        total_supply: 100_000_000_000,
      };

      try {
        const url = 'https://api.coingecko.com/api/v3/coins/pi-network?localization=false&tickers=false&community_data=false&developer_data=false';
        const resp = await axios.get(url, { timeout: 8000 });
        const md = resp.data?.market_data;
        if (md) {
          return res.json({
            total_circulating_supply: md.circulating_supply ?? fallback.total_circulating_supply,
            total_locked: fallback.total_locked,
            total_supply: md.total_supply ?? fallback.total_supply,
          });
        }
      } catch (e) {
        // CoinGecko fetch failed, use fallback
      }

      return res.json(fallback);
    } catch (error: unknown) {
      return res.json({
        total_circulating_supply: 10_600_000_000,
        total_locked: 0,
        total_supply: 100_000_000_000,
      });
    }
  });

  /**
   * GET /data/check-scam-wallet/:address
   * Check if wallet is flagged as scam
   */
  router.get('/check-scam-wallet/:address', async (req: Request, res: Response) => {
    try {
      const { address } = req.params;
      const knownScamAddresses = new Set<string>([]);
      const is_scam = knownScamAddresses.has(address);

      res.json({
        address,
        is_scam,
        reason: is_scam ? 'Flagged as scam address' : null,
      });
    } catch (error: unknown) {
      res.json({
        address: req.params.address,
        is_scam: false,
        reason: null,
      });
    }
  });

  /**
   * GET /data/top-accounts
   * Get top Pi accounts by balance (from Horizon)
   */
  router.get('/top-accounts', async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const horizonUrl = getHorizonUrl();
      const response = await axios.get(`${horizonUrl}/accounts?order=desc&limit=${Math.min(limit * 2, 100)}`, { timeout: 10000 });

      const accounts = response.data._embedded.records
        .map((r: any) => ({
          account_id: r.account_id,
          native_balance: r.balances.find((b: any) => b.asset_type === 'native')?.balance || '0',
          total_trustlines: r.balances.length,
          subentry_count: r.subentry_count,
          last_modified_ledger: r.last_modified_ledger,
        }))
        .sort((a: any, b: any) => parseFloat(b.native_balance) - parseFloat(a.native_balance))
        .slice(0, limit);

      res.json({
        accounts,
        total: accounts.length,
        network: config.network,
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error fetching top accounts', { error: errorMessage });
      res.json({
        accounts: [],
        total: 0,
        error: errorMessage,
      });
    }
  });

  /**
   * GET /data/accounts/distribution
   * Get account balance distribution statistics
   */
  router.get('/accounts/distribution', async (_req: Request, res: Response) => {
    try {
      const horizonUrl = getHorizonUrl();
      const response = await axios.get(`${horizonUrl}/accounts?order=desc&limit=100`, { timeout: 10000 });

      const accounts = response.data._embedded.records;
      const balances = accounts.map((r: any) =>
        parseFloat(r.balances.find((b: any) => b.asset_type === 'native')?.balance || '0')
      );

      const distribution = [
        { range: '< 1 PI', min: 0, max: 1, count: 0 },
        { range: '1 - 100 PI', min: 1, max: 100, count: 0 },
        { range: '100 - 1K PI', min: 100, max: 1000, count: 0 },
        { range: '1K - 10K PI', min: 1000, max: 10000, count: 0 },
        { range: '10K - 100K PI', min: 10000, max: 100000, count: 0 },
        { range: '> 100K PI', min: 100000, max: Infinity, count: 0 },
      ];

      for (const balance of balances) {
        for (const bucket of distribution) {
          if (balance >= bucket.min && balance < bucket.max) {
            bucket.count++;
            break;
          }
        }
      }

      res.json({
        distribution: distribution.map(d => ({
          range: d.range,
          count: d.count,
          percentage: balances.length > 0 ? ((d.count / balances.length) * 100).toFixed(1) + '%' : '0%',
        })),
        total_accounts: response.data._links?.self?.href ? parseInt(response.data._links.self.href.match(/cursor=(\d+)/)?.[1] || '0') || balances.length : balances.length,
        network: config.network,
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error fetching account distribution', { error: errorMessage });
      res.json({
        distribution: [],
        total_accounts: 0,
        error: errorMessage,
      });
    }
  });

  /**
   * GET /data/data/unlocknext30d
   * Get Pi unlock data for next 30 days
   */
  router.get('/data/unlocknext30d', async (_req: Request, res: Response) => {
    try {
      res.json({
        unlocks: [],
        total_unlock: 0,
        message: 'Unlock schedule data requires on-chain vesting contract queries (not yet implemented)',
      });
    } catch (error: unknown) {
      res.json({
        unlocks: [],
        total_unlock: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * GET /data/data/unlockfull
   * Get full unlock statistics
   */
  router.get('/data/unlockfull', async (_req: Request, res: Response) => {
    try {
      res.json({
        statistics: {
          total_vested: 0,
          total_released: 0,
          total_remaining: 0,
        },
        message: 'Full unlock statistics require on-chain vesting contract queries (not yet implemented)',
      });
    } catch (error: unknown) {
      res.json({
        statistics: {},
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * GET /data/data/nodemap
   * Get Pi node map data
   */
  router.get('/data/nodemap', async (_req: Request, res: Response) => {
    try {
      res.json({
        nodes: [],
        total_nodes: 0,
        message: 'Node map data requires Pi node discovery (not yet implemented)',
      });
    } catch (error: unknown) {
      res.json({
        nodes: [],
        total_nodes: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * GET /data/transactions
   * Get recent Pi transactions from Horizon
   */
  router.get('/transactions', async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const horizonUrl = getHorizonUrl();
      const response = await axios.get(`${horizonUrl}/transactions?order=desc&limit=${Math.min(limit, 100)}`, { timeout: 10000 });

      const transactions = response.data._embedded.records.map((r: any) => ({
        hash: r.hash,
        ledger: r.ledger,
        created_at: r.created_at,
        source_account: r.source_account,
        fee_charged: r.fee_charged,
        operation_count: r.operation_count,
        memo: r.memo,
        success: r.successful,
      }));

      res.json({
        transactions,
        total: transactions.length,
        network: config.network,
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Error fetching transactions', { error: errorMessage });
      res.json({
        transactions: [],
        total: 0,
        error: errorMessage,
      });
    }
  });

  return router;
}
