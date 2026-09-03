/**
 * On-chain data routes for Suban Controller
 */
import { Router, Request, Response } from 'express';
import {
  getLatestLedgers,
  getNetworkStats,
  getAccountInfo,
  getRecentTransactions,
  getTopAccounts,
} from '../services/chaindata';

export function createChainDataRouter(): Router {
  const router = Router();

  // Network statistics
  router.get('/stats', async (_req: Request, res: Response) => {
    try {
      const stats = await getNetworkStats();
      res.json({ data: stats });
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to fetch network stats', message: error.message });
    }
  });

  // Latest ledgers
  router.get('/ledgers', async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const ledgers = await getLatestLedgers(Math.min(limit, 100));
      res.json({ data: ledgers });
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to fetch ledgers', message: error.message });
    }
  });

  // Account information
  router.get('/accounts/:accountId', async (req: Request, res: Response) => {
    try {
      const account = await getAccountInfo(req.params.accountId);
      res.json({ data: account });
    } catch (error: any) {
      if (error.response?.status === 404) {
        res.status(404).json({ error: 'Account not found' });
      } else {
        res.status(500).json({ error: 'Failed to fetch account', message: error.message });
      }
    }
  });

  // Top accounts
  router.get('/accounts', async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const accounts = await getTopAccounts(Math.min(limit, 100));
      res.json({ data: accounts });
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to fetch top accounts', message: error.message });
    }
  });

  // Recent transactions
  router.get('/transactions', async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const transactions = await getRecentTransactions(Math.min(limit, 100));
      res.json({ data: transactions });
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to fetch transactions', message: error.message });
    }
  });

  return router;
}
