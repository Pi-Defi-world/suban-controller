import { PriceService } from './priceService';
import { AssetDefinition } from '../assets/types';
import { PriceData, PriceSource } from '../types';
import { PriceObservationInput } from './priceStore';

class FakeSource extends PriceSource {
  constructor(name: string, public price: number) {
    super(name, 1, 'TEST');
  }

  async fetchPrice(): Promise<PriceData> {
    return {
      price: this.price,
      timestamp: new Date(),
      source: this.name,
      weight: this.weight,
    };
  }
}

class RecordingStore {
  observations: PriceObservationInput[] = [];

  record(observation: PriceObservationInput): void {
    this.observations.push(observation);
  }
}

describe('PriceService', () => {
  const definitions: AssetDefinition[] = [
    {
      id: 'PI',
      symbol: 'PI',
      name: 'Pi Network',
      enabled: true,
      oracleAsset: 'PI_ORACLE_ASSET',
      minSourcesRequired: 1,
      sources: [new FakeSource('alpha', 1)],
    },
    {
      id: 'OUSD',
      symbol: 'OUSD',
      name: 'oUSD',
      enabled: false,
      oracleAsset: 'OUSD_ORACLE_ASSET',
      minSourcesRequired: 1,
      sources: [],
    },
  ];

  it('tracks enabled and disabled assets independently', () => {
    const service = new PriceService(definitions, new RecordingStore());
    const assets = service.listAssets();

    expect(assets.map((asset) => asset.id)).toEqual(['PI', 'OUSD']);
    expect(assets[0].enabled).toBe(true);
    expect(assets[0].sources).toHaveLength(1);
    expect(assets[1].enabled).toBe(false);
    expect(assets[1].sources).toHaveLength(0);
    expect(assets[1].trust.state).toBe('DEGRADED');
    expect(assets[1].trust.reason).toMatch(/no price sources/i);
  });

  it('resolves assets case-insensitively and rejects unknown ids', () => {
    const service = new PriceService(definitions, new RecordingStore());

    expect(service.getAsset('pi')?.id).toBe('PI');
    expect(service.getAggregator('PI')).toBeDefined();
    expect(service.getAggregator('OUSD')).toBeUndefined();
    expect(service.getAsset('DOGE')).toBeUndefined();
    expect(() => service.requireAggregator('OUSD')).toThrow(/not configured/i);
    expect(() => service.requireAggregator('DOGE')).toThrow(/unknown asset/i);
  });

  it('only exposes oracle targets for enabled assets with an address', () => {
    const service = new PriceService(definitions, new RecordingStore());
    const targets = service.getOracleTargets();

    expect(targets.map((target) => target.asset.id)).toEqual(['PI']);
  });

  it('propagates the asset symbol into observations', async () => {
    const recorder = new RecordingStore();
    const service = new PriceService(definitions, recorder);

    const price = await service.requireAggregator('PI').getAggregatedPrice();

    expect(price.symbol).toBe('PI');
    expect(recorder.observations[0].symbol).toBe('PI');
  });
});
