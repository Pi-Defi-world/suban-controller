import { findBestCpmmRoute, MAX_ROUTE_HOPS, RouteInputError, RoutePool } from './route';

const A = 'CA' + 'A'.repeat(54);
const B = 'CB' + 'B'.repeat(54);
const C = 'CC' + 'C'.repeat(54);
const D = 'CD' + 'D'.repeat(54);

function pool(overrides: Partial<RoutePool> = {}): RoutePool {
  return {
    contract_id: A,
    pool_kind: 'cpmm',
    token_a: A,
    token_b: B,
    reserve_a_raw: '1000000',
    reserve_b_raw: '1000000',
    fee_bps: 30,
    ledger: 100,
    observed_at: '2026-10-22T00:00:00.000Z',
    ...overrides,
  };
}

describe('CPMM route discovery', () => {
  it('picks the direct pool with the best output', () => {
    const route = findBestCpmmRoute(
      [
        pool({ contract_id: 'CPOOL1', reserve_b_raw: '1000000' }),
        pool({ contract_id: 'CPOOL2', reserve_b_raw: '2000000' }),
      ],
      A,
      B,
      '1000'
    );

    expect(route).not.toBeNull();
    expect(route!.hop_count).toBe(1);
    expect(route!.amount_out_raw).toBe('1992');
    expect(route!.hops[0].pool_contract_id).toBe('CPOOL2');
    expect(route!.method_version).toBe('cpmm_route_v1');
  });

  it('finds a two-hop route and compounds integer truncation per hop', () => {
    const route = findBestCpmmRoute(
      [
        pool({ contract_id: 'CAB' }),
        pool({ contract_id: 'CBC', token_a: B, token_b: C }),
        pool({ contract_id: 'CCD', token_a: C, token_b: D, reserve_a_raw: '0' }),
      ],
      A,
      C,
      '1000',
      2
    );

    expect(route).not.toBeNull();
    expect(route!.hop_count).toBe(2);
    expect(route!.amount_out_raw).toBe('992');
    expect(route!.hops.map((hop) => hop.pool_contract_id)).toEqual(['CAB', 'CBC']);
    expect(route!.hops[0].amount_out_raw).toBe('996');
    expect(route!.source_ledger_min).toBe(100);
    expect(route!.source_ledger_max).toBe(100);
  });

  it('returns null rather than inventing a venue', () => {
    expect(findBestCpmmRoute([], A, B, '1000')).toBeNull();
    expect(
      findBestCpmmRoute([pool({ reserve_a_raw: '0' })], A, B, '1000')
    ).toBeNull();
    expect(
      findBestCpmmRoute([pool({ pool_kind: 'stableswap' })], A, B, '1000')
    ).toBeNull();
  });

  it('respects max_hops and rejects cycles', () => {
    const pools = [
      pool({ contract_id: 'CAB' }),
      pool({ contract_id: 'CBC', token_a: B, token_b: C }),
    ];
    expect(findBestCpmmRoute(pools, A, C, '1000', 1)).toBeNull();
    expect(findBestCpmmRoute(pools, A, C, '1000', 2)).not.toBeNull();
  });

  it('rejects malformed inputs', () => {
    expect(() => findBestCpmmRoute([], A, B, '0')).toThrow(RouteInputError);
    expect(() => findBestCpmmRoute([], A, B, '1.5')).toThrow(RouteInputError);
    expect(() => findBestCpmmRoute([], A, A, '1')).toThrow('must differ');
    expect(() => findBestCpmmRoute([], A, B, '1', 0)).toThrow('max_hops');
    expect(() => findBestCpmmRoute([], A, B, '1', MAX_ROUTE_HOPS + 1)).toThrow(
      'max_hops'
    );
  });
});
