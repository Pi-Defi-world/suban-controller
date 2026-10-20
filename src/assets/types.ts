import type { PriceSource } from '../types';

/**
 * One tradable asset tracked by the controller. Each asset owns its sources,
 * health and oracle address; aggregators never share state.
 */
export interface AssetDefinition {
  /** Stable identifier used by the API, e.g. `PI`, `USDC`. */
  id: string;
  /** Display symbol stored with observations and exposed in responses. */
  symbol: string;
  name: string;
  /** False when no source is configured; requests return 503, never a fake price. */
  enabled: boolean;
  /** On-chain asset address used by the oracle publisher, if configured. */
  oracleAsset?: string;
  minSourcesRequired: number;
  sources: PriceSource[];
}
