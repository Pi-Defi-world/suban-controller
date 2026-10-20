/**
 * Asset registry.
 *
 * Each asset gets its own source set and aggregator. Assets without a live
 * source are registered as disabled so consumers can see them and get an
 * explicit 503 instead of a fabricated price.
 */
import { config } from '../config';
import { PriceSource } from '../types';
import { ArcSource } from '../sources/arc';
import { BitgetSource } from '../sources/bitget';
import { CoinGeckoSource } from '../sources/coingecko';
import { HttpPriceSource } from '../sources/http';
import { MexcSource } from '../sources/mexc';
import { OKXSource } from '../sources/okx';
import { AssetDefinition } from './types';

function disabled(
  id: string,
  symbol: string,
  name: string,
  oracleAsset: string
): AssetDefinition {
  return {
    id,
    symbol,
    name,
    enabled: false,
    oracleAsset: oracleAsset || undefined,
    minSourcesRequired: 1,
    sources: [],
  };
}

export function buildAssetDefinitions(): AssetDefinition[] {
  const definitions: AssetDefinition[] = [];

  // ─── PI/USD ────────────────────────────────────────────────────────
  if (config.assets.pi.enabled) {
    const sources: PriceSource[] = [
      new MexcSource('mexc', config.weights.mexc, config.symbols.mexc),
      new CoinGeckoSource(
        'coingecko',
        config.weights.coingecko,
        config.symbols.coingecko
      ),
      new OKXSource('okx', config.weights.okx, config.symbols.okx),
      new BitgetSource('bitget', config.weights.bitget, config.symbols.bitget),
    ];
    if (config.arcRpcUrl) {
      sources.push(
        new ArcSource(
          'arc',
          config.arcWeight,
          'PI/USDC',
          config.arcRpcUrl,
          config.arcPricePairAddress
        )
      );
    }
    definitions.push({
      id: 'PI',
      symbol: 'PI',
      name: 'Pi Network',
      enabled: true,
      oracleAsset: config.assets.pi.oracleAsset || undefined,
      minSourcesRequired: config.minSourcesRequired,
      sources,
    });
  } else {
    definitions.push(
      disabled('PI', 'PI', 'Pi Network', config.assets.pi.oracleAsset)
    );
  }

  // ─── USDC/USD ──────────────────────────────────────────────────────
  if (config.assets.usdc.enabled) {
    definitions.push({
      id: 'USDC',
      symbol: 'USDC',
      name: 'USD Coin',
      enabled: true,
      oracleAsset: config.assets.usdc.oracleAsset || undefined,
      minSourcesRequired: config.stableMinSourcesRequired,
      sources: [
        new CoinGeckoSource('coingecko', 1, config.assets.usdc.coingeckoId),
        new OKXSource('okx', 1, config.assets.usdc.okxSymbol),
        new MexcSource('mexc', 1, config.assets.usdc.mexcSymbol),
      ],
    });
  } else {
    definitions.push(
      disabled('USDC', 'USDC', 'USD Coin', config.assets.usdc.oracleAsset)
    );
  }

  // ─── USDT/USD ──────────────────────────────────────────────────────
  if (config.assets.usdt.enabled) {
    definitions.push({
      id: 'USDT',
      symbol: 'USDT',
      name: 'Tether USD',
      enabled: true,
      oracleAsset: config.assets.usdt.oracleAsset || undefined,
      minSourcesRequired: config.stableMinSourcesRequired,
      sources: [
        new CoinGeckoSource('coingecko', 1, config.assets.usdt.coingeckoId),
        new OKXSource('okx', 1, config.assets.usdt.okxSymbol),
      ],
    });
  } else {
    definitions.push(
      disabled('USDT', 'USDT', 'Tether USD', config.assets.usdt.oracleAsset)
    );
  }

  // ─── oUSD/USD ──────────────────────────────────────────────────────
  if (config.assets.ousd.enabled && config.assets.ousd.url) {
    definitions.push({
      id: 'OUSD',
      symbol: 'OUSD',
      name: 'oUSD',
      enabled: true,
      oracleAsset: config.assets.ousd.oracleAsset || undefined,
      minSourcesRequired: config.stableMinSourcesRequired,
      sources: [
        new HttpPriceSource(
          'ousd-http',
          1,
          config.assets.ousd.url,
          config.assets.ousd.jsonPath
        ),
      ],
    });
  } else {
    definitions.push(
      disabled('OUSD', 'OUSD', 'oUSD', config.assets.ousd.oracleAsset)
    );
  }

  return definitions;
}
