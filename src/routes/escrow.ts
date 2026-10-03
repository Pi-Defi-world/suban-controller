/**
 * Escrow API routes - backend for the Escrow Viewer React app
 * Queries Horizon for escrow contract data.
 */
import { Router, Request, Response } from 'express';
import { config } from '../config';
import { logger } from '../utils/logger';
import axios from 'axios';

const router: Router = Router();

type Network = 'mainnet' | 'testnet';

function isNetwork(value: unknown): value is Network {
  return value === 'mainnet' || value === 'testnet';
}

/**
 * Resolve the target network for a request.
 * Falls back to the configured default when ?network= is absent or invalid.
 */
function resolveNetwork(req: Request): Network {
  const requested = req.query.network;
  return isNetwork(requested) ? requested : config.network;
}

function getHorizonUrl(network: Network): string {
  return network === 'testnet' ? config.horizon.testnet : config.horizon.mainnet;
}

/**
 * GET /api/escrow/:escrowId
 * Get escrow contract state from Horizon
 */
router.get('/escrow/:escrowId', async (req: Request, res: Response) => {
  try {
    const { escrowId } = req.params;
    const network = resolveNetwork(req);
    const horizonUrl = getHorizonUrl(network);

    // Try to get account data from Horizon
    try {
      const response = await axios.get(`${horizonUrl}/accounts/${escrowId}`, { timeout: 10000 });
      const account = response.data;

      res.json({
        escrowId,
        network,
        status: 'active',
        funder: account.source_account || '',
        receiver: '',
        totalDeposited: account.balances?.find((b: any) => b.asset_type === 'native')?.balance || '0',
        totalReleased: '0',
        milestones: [],
        sequence: account.sequence,
        subentry_count: account.subentry_count,
      });
      return;
    } catch (e: any) {
      if (e.response?.status !== 404) {
        logger.warn('Horizon account lookup failed for escrow', { escrowId, network, error: e.message });
      }
    }

    // Fallback: return basic info
    res.json({
      escrowId,
      network,
      status: 'unknown',
      funder: '',
      receiver: '',
      totalDeposited: '0',
      totalReleased: '0',
      milestones: [],
      message: 'Escrow contract data could not be decoded. The contract may not be deployed or the ID is invalid.',
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Error fetching escrow state', { error: errorMessage, escrowId: req.params.escrowId });
    res.status(500).json({
      error: 'Failed to fetch escrow state',
      message: errorMessage,
    });
  }
});

/**
 * GET /api/gateway/events
 * Get contract events from Horizon (compatible with escrow viewer)
 */
router.get('/gateway/events', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const network = resolveNetwork(req);
    const horizonUrl = getHorizonUrl(network);

    // Query Horizon for contract events.
// This Horizon build exposes no /events route and silently ignores the effects
// `type`/`type_code` filters, so a wider page is pulled and contract-related
// effects are selected here.
const response = await axios.get(`${horizonUrl}/effects`, {
  params: {
    limit: 200,
    order: 'desc',
  },
  timeout: 15000,
});

const allEffects = response.data._embedded?.records || [];
const effects = allEffects.filter(
  (e: any) =>
    typeof e.type === 'string' &&
    (e.type.startsWith('contract') || typeof e.contract === 'string'),
);

const sliced = effects.slice(0, Math.min(limit, 100));

res.json({
  network,
  events: sliced.map((e: any) => ({
    id: e.id,
    event_type: e.type,
    tx_hash: e.transaction_hash,
    contract: e.contract || '',
    ledger: parseInt(e.ledger || '0'),
    timestamp: e.created_at,
    data: e.value,
  })),
  total: sliced.length,
});
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Error fetching gateway events', { error: errorMessage });
    res.json({
      events: [],
      total: 0,
      error: errorMessage,
    });
  }
});

export { router as escrowRouter };
