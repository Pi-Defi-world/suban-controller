/**
 * Multi-asset price service.
 *
 * Owns one PriceAggregator per asset. Aggregators are isolated: separate
 * sources, cache keys, circuit breakers and trust machines.
 */
import { AssetDefinition } from '../assets/types';
import { PriceAggregator } from './aggregator';
import { PriceRecorder, getPriceStore } from './priceStore';
import { SourceStatus } from '../types';
import { TrustSnapshot } from './trustState';
import { config } from '../config';

export interface AssetStatus {
  id: string;
  symbol: string;
  name: string;
  enabled: boolean;
  oracle_asset: string | null;
  min_sources_required: number;
  sources: SourceStatus[];
  trust: TrustSnapshot;
  last_committed_price: number | null;
}

export interface OracleTarget {
  asset: AssetDefinition;
  aggregator: PriceAggregator;
}

export class PriceService {
  private readonly definitions = new Map<string, AssetDefinition>();
  private readonly aggregators = new Map<string, PriceAggregator>();
  private readonly disabledSince = new Date().toISOString();

  constructor(
    definitions: AssetDefinition[],
    private readonly store: PriceRecorder = {
      record: (observation) => getPriceStore().record(observation),
    }
  ) {
    for (const definition of definitions) {
      const id = definition.id.toUpperCase();
      this.definitions.set(id, definition);

      if (!definition.enabled || definition.sources.length === 0) {
        continue;
      }

      const aggregator = new PriceAggregator({
        symbol: definition.symbol,
        minSourcesRequired: definition.minSourcesRequired,
        store: this.store,
      });
      for (const source of definition.sources) {
        aggregator.addSource(source);
      }
      this.aggregators.set(id, aggregator);
    }
  }

  /** Resolve an asset id (case-insensitive). Defaults to PI. */
  getAsset(id: string = 'PI'): AssetDefinition | undefined {
    return this.definitions.get(id.toUpperCase());
  }

  getAggregator(id: string = 'PI'): PriceAggregator | undefined {
    return this.aggregators.get(id.toUpperCase());
  }

  requireAggregator(id: string): PriceAggregator {
    const aggregator = this.getAggregator(id);
    if (!aggregator) {
      const asset = this.getAsset(id);
      const reason = asset
        ? `Asset ${id} is not configured (no sources)`
        : `Unknown asset ${id}`;
      throw new Error(reason);
    }
    return aggregator;
  }

  listAssets(): AssetStatus[] {
    return [...this.definitions.values()].map((definition) => {
      const id = definition.id.toUpperCase();
      const aggregator = this.aggregators.get(id);
      if (!aggregator) {
        return {
          id,
          symbol: definition.symbol,
          name: definition.name,
          enabled: false,
          oracle_asset: definition.oracleAsset ?? null,
          min_sources_required: definition.minSourcesRequired,
          sources: [],
          trust: {
            state: 'DEGRADED',
            since: this.disabledSince,
            reason: 'no price sources configured',
            healthy_streak: 0,
          },
          last_committed_price: null,
        };
      }

      return {
        id,
        symbol: definition.symbol,
        name: definition.name,
        enabled: true,
        oracle_asset: definition.oracleAsset ?? null,
        min_sources_required: definition.minSourcesRequired,
        sources: aggregator.getAllSourceStatuses(),
        trust: aggregator.getTrustState(),
        last_committed_price: aggregator.getLastCommittedPrice(),
      };
    });
  }

  /** Enabled assets with an oracle address, ready for the push loop. */
  getOracleTargets(): OracleTarget[] {
    const targets: OracleTarget[] = [];
    for (const definition of this.definitions.values()) {
      const aggregator = this.aggregators.get(definition.id.toUpperCase());
      if (!aggregator || !definition.oracleAsset) {
        continue;
      }
      targets.push({ asset: definition, aggregator });
    }
    return targets;
  }

  /** Default PI aggregator; the controller cannot start without it. */
  getDefaultAggregator(): PriceAggregator {
    return this.requireAggregator('PI');
  }

  getSummary() {
    return this.listAssets().map((asset) => ({
      id: asset.id,
      enabled: asset.enabled,
      trust_state: asset.trust.state,
      sources: asset.sources.length,
    }));
  }

  getConfig() {
    return {
      assets: [...this.definitions.keys()],
      min_sources_required: config.minSourcesRequired,
      stable_min_sources_required: config.stableMinSourcesRequired,
    };
  }
}
