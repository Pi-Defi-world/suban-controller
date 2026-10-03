/**
 * Contract search routes, backed by the Soroban JSON-RPC.
 *
 * Contract reads belong on the RPC: getEvents is the standard interface and
 * returns contractId, ledger, txHash, topic and value. Horizon in this Pi build
 * exposes no contract-state routes, so it is not used for contract data here.
 *
 * Note on filters: getEvents applies the contractId filter, but when a contract
 * has no events in the requested range this build returns unfiltered results.
 * Callers must verify returned contractIds match what they asked for.
 */
import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger';
import axios from 'axios';

const router: Router = Router();

type Network = 'mainnet' | 'testnet';

const RPC_URLS: Record<Network, string> = {
  mainnet: process.env.CONTRACT_RPC_MAINNET_URL || 'http://suban-rpc:8000',
  testnet: process.env.CONTRACT_RPC_TESTNET_URL || 'http://stellar-rpc-testnet:8000',
};

const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const CACHE_TTL_MS = 60_000;

interface RpcEvent {
  type?: string;
  ledger?: number;
  ledgerClosedAt?: string;
  contractId?: string;
  id?: string;
  txHash?: string;
  inSuccessfulContractCall?: boolean;
  topic?: unknown[];
  value?: string;
}

interface ContractRecord {
  contractId: string;
  eventCount: number;
  firstLedger: number;
  lastLedger: number;
  lastActivity: string;
  successfulCalls: number;
  failedCalls: number;
}

interface CacheEntry {
  expires: number;
  contracts: ContractRecord[];
  scannedEvents: number;
  ledgerRange: [number, number] | null;
}

const cache = new Map<Network, CacheEntry>();

function isNetwork(value: unknown): value is Network {
  return value === 'mainnet' || value === 'testnet';
}

function resolveNetwork(req: Request): Network {
  const requested = req.query.network ?? req.params.network;
  return isNetwork(requested) ? requested : 'mainnet';
}

async function rpc(network: Network, method: string, params: unknown): Promise<any> {
  const response = await axios.post(
    RPC_URLS[network],
    { jsonrpc: '2.0', id: 1, method, params },
    { timeout: 15000, headers: { 'Content-Type': 'application/json' } },
  );
  if (response.data?.error) {
    throw new Error(response.data.error.message || 'RPC error');
  }
  return response.data?.result;
}

/** Current RPC ledger range, needed because getEvents rejects out-of-range ledgers. */
async function ledgerRange(network: Network): Promise<[number, number]> {
  const health = await rpc(network, 'getHealth', {});
  return [health.oldestLedger, health.latestLedger];
}

function blankRecord(contractId: string): ContractRecord {
  return {
    contractId,
    eventCount: 0,
    firstLedger: Number.MAX_SAFE_INTEGER,
    lastLedger: 0,
    lastActivity: '',
    successfulCalls: 0,
    failedCalls: 0,
  };
}

function applyEvent(record: ContractRecord, event: RpcEvent): void {
  record.eventCount++;
  const ledger = event.ledger ?? 0;
  if (ledger > 0) {
    if (ledger < record.firstLedger) record.firstLedger = ledger;
    if (ledger > record.lastLedger) {
      record.lastLedger = ledger;
      record.lastActivity = event.ledgerClosedAt ?? '';
    }
  }
  if (event.inSuccessfulContractCall) record.successfulCalls++;
  else record.failedCalls++;
}

/**
 * GET /api/contracts
 * Contracts observed in recent Soroban events.
 */
router.get('/contracts', async (req: Request, res: Response) => {
  const network = resolveNetwork(req);
  try {
    let entry = cache.get(network);
    if (entry && entry.expires > Date.now()) {
      // fall through to filter/respond
    } else {
      const [oldest, latest] = await ledgerRange(network);
      const byContract = new Map<string, ContractRecord>();
      let cursor: string | undefined;
      let scanned = 0;

      for (let page = 0; page < MAX_PAGES; page++) {
        // getEvents rejects a cursor combined with an explicit ledger range,
        // so only the first page states the range; later pages page by cursor.
        const params: Record<string, unknown> = {
          filters: [{ type: 'contract' }],
          pagination: { limit: PAGE_SIZE },
        };
        if (cursor) {
          params.pagination = { limit: PAGE_SIZE, cursor };
        } else {
          params.startLedger = oldest;
          params.endLedger = latest;
        }

        const result = await rpc(network, 'getEvents', params);

        const events: RpcEvent[] = result?.events ?? [];
        if (events.length === 0) break;

        for (const event of events) {
          scanned++;
          if (!event.contractId) continue;
          const record = byContract.get(event.contractId) ?? blankRecord(event.contractId);
          applyEvent(record, event);
          byContract.set(event.contractId, record);
        }

        cursor = result?.cursor;
        if (!cursor) break;
      }

      const contracts = [...byContract.values()]
        .map((c) => ({ ...c, firstLedger: c.firstLedger === Number.MAX_SAFE_INTEGER ? 0 : c.firstLedger }))
        .sort((a, b) => b.eventCount - a.eventCount);

      entry = {
        expires: Date.now() + CACHE_TTL_MS,
        contracts,
        scannedEvents: scanned,
        ledgerRange: [oldest, latest],
      };
      cache.set(network, entry);
    }

    const query = typeof req.query.q === 'string' ? req.query.q.trim().toUpperCase() : '';
    const contracts = query ? entry.contracts.filter((c) => c.contractId.includes(query)) : entry.contracts;

    res.json({
      network,
      query: query || null,
      total: contracts.length,
      contracts,
      window: {
        eventsScanned: entry.scannedEvents,
        pages: MAX_PAGES,
        ledgerRange: entry.ledgerRange,
      },
      note: 'Derived from recent Soroban events via the JSON-RPC.',
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Contract list failed', { error: message, network });
    res.status(502).json({ error: 'Contract list unavailable', message });
  }
});

/**
 * GET /api/contracts/:contractId
 * Events emitted by one contract, straight from the RPC.
 */
router.get('/contracts/:contractId', async (req: Request, res: Response) => {
  const network = resolveNetwork(req);
  const contractId = (req.params.contractId || '').trim().toUpperCase();

  if (!/^C[A-Z2-7]{55}$/.test(contractId)) {
    res.status(400).json({
      error: 'Invalid contract ID',
      message: 'A Stellar contract ID is a C followed by 55 base32 characters.',
    });
    return;
  }

  try {
    const [oldest, latest] = await ledgerRange(network);
    const result = await rpc(network, 'getEvents', {
      startLedger: oldest,
      endLedger: latest,
      filters: [{ type: 'contract', contractId }],
      pagination: { limit: 50 },
    });

    // This build returns unfiltered events when a filter matches nothing,
    // so only keep events that genuinely belong to the requested contract.
    const events: RpcEvent[] = ((result?.events ?? []) as RpcEvent[]).filter((e) => e.contractId === contractId);

    res.json({
      network,
      contractId,
      found: events.length > 0,
      eventCount: events.length,
      events: events.slice(0, 50).map((e) => ({
        id: e.id,
        ledger: e.ledger,
        ledgerClosedAt: e.ledgerClosedAt,
        txHash: e.txHash,
        inSuccessfulContractCall: e.inSuccessfulContractCall,
        topicCount: Array.isArray(e.topic) ? e.topic.length : 0,
      })),
      window: { ledgerRange: [oldest, latest] },
      note: events.length
        ? undefined
        : 'No contract events in the RPC retention window. The contract may still exist with no recent events, or may predate the window.',
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Contract lookup failed', { error: message, network, contractId });
    res.status(502).json({ error: 'Contract lookup unavailable', message });
  }
});

/**
 * GET /api/contracts/:contractId/state
 * Read contract storage without needing to hand-encode a LedgerKey.
 *
 *   ?key=NAME            symbol-keyed storage entry (e.g. name, symbol, decimals)
 *   (key omitted)        the contract instance storage entry
 *   ?durability=persistent|temporary   contract data durability class
 *
 * The RPC's getLedgerEntries accepts shorthand ledger keys, so the XDR encoding
 * (including Pi's Durability field, which upstream SDKs do not carry) stays on
 * the RPC where the schema is guaranteed to match.
 */
router.get('/contracts/:contractId/state', async (req: Request, res: Response) => {
  const network = resolveNetwork(req);
  const contractId = (req.params.contractId || '').trim().toUpperCase();

  if (!/^C[A-Z2-7]{55}$/.test(contractId)) {
    res.status(400).json({
      error: 'Invalid contract ID',
      message: 'A Stellar contract ID is a C followed by 55 base32 characters.',
    });
    return;
  }

  const rawDurability = typeof req.query.durability === 'string' ? req.query.durability.trim() : '';
  if (rawDurability && rawDurability !== 'persistent' && rawDurability !== 'temporary') {
    res.status(400).json({
      error: 'Invalid durability',
      message: 'durability must be persistent or temporary',
    });
    return;
  }
  const rawKey = typeof req.query.key === 'string' ? req.query.key.trim() : '';
  if (rawKey && !/^[A-Za-z0-9_]{1,32}$/.test(rawKey)) {
    res.status(400).json({
      error: 'Invalid storage key',
      message: 'key must be 1-32 characters of letters, digits or underscore (a Soroban symbol)',
    });
    return;
  }

  const durability = rawDurability || 'persistent';

  // Shorthand ledger keys require suban-rpc. The official stellar-rpc image
  // accepts only raw base64 XDR ledger keys, so encoding is left to the caller
  // there rather than silently returning a misleading empty result.
  const ledgerKey = rawKey
    ? `contractDataSymbol:${contractId}:${rawKey}:${durability}`
    : `contract:${contractId}:${durability}`;

  try {
    const result = await rpc(network, 'getLedgerEntries', { keys: [ledgerKey], format: 'json' });
    const entries: any[] = result?.entries ?? [];

    if (entries.length === 0) {
      res.json({
        network,
        contractId,
        storageKey: rawKey || null,
        durability,
        found: false,
        note: 'No entry for this storage key at the RPC retention boundary. The contract may exist without this key.',
      });
      return;
    }

    const entry = entries[0];
    res.json({
      network,
      contractId,
      storageKey: rawKey || null,
      durability,
      found: true,
      valueXdr: entry.xdr ?? null,
      extXdr: entry.extXdr ?? null,
      lastModifiedLedgerSeq: entry.lastModifiedLedgerSeq ?? null,
      liveUntilLedgerSeq: entry.liveUntilLedgerSeq ?? null,
      note: 'valueXdr is the raw base64 LedgerEntryData. Decode it with the Stellar SDK for a typed value.',
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (/cannot unmarshal key value/.test(message)) {
      res.status(501).json({
        error: 'Shorthand ledger keys not supported by this RPC',
        message:
          'This network RPC only accepts raw base64 XDR ledger keys. Use suban-rpc, or supply a pre-encoded ledgerKey.',
        network,
      });
      return;
    }
    logger.error('Contract state read failed', { error: message, network, contractId, rawKey });
    res.status(502).json({ error: 'Contract state unavailable', message });
  }
});

export { router as contractsRouter };