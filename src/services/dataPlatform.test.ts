import axios from 'axios';
import {
  DataPlatformError,
  fetchIndexedLendingPosition,
  fetchIndexedPools,
  rawToHuman,
} from './dataPlatform';

jest.mock('axios');
const mockedGet = axios.get as jest.MockedFunction<typeof axios.get>;

const ACCOUNT = 'GB6PCM5GBUZR3EYET4IWQ4TBI7IYPFXFJI4TX3BHDPC6H3PSGB5UYB7W';

describe('data platform lending client', () => {
  beforeEach(() => {
    mockedGet.mockReset();
  });

  it('returns a validated indexed position snapshot', async () => {
    mockedGet.mockResolvedValue({
      status: 200,
      data: {
        data: {
          account: ACCOUNT,
          contract_id: 'CCJZ5DGASBWQXR5MP74KZQ6ZJZ3M7N5ZL7QX2X7ZM7ZP5W5Q5X5Q5X5Q',
          contract_name: 'lending-pool',
          position: {
            deposit_raw: '1000',
            borrow_raw: '100',
            collateral_raw: '500',
          },
          totals: {
            total_supply_raw: '1000',
            total_borrows_raw: '100',
            total_reserves_raw: '0',
          },
          as_of: {
            ledger: 106,
            timestamp: '2026-10-22T00:00:00.000Z',
            event_id: 'E6',
            event_type: 'borrow',
          },
          source: 'indexed_contract_events',
        },
      },
    } as any);

    const position = await fetchIndexedLendingPosition(ACCOUNT, {
      baseUrl: 'http://data.test',
      apiKey: 'test-key',
    });

    expect(mockedGet).toHaveBeenCalledWith(
      `http://data.test/financial/lending/accounts/${ACCOUNT}`,
      expect.objectContaining({
        headers: { 'x-api-key': 'test-key' },
      })
    );
    expect(position.position).toEqual({
      deposit_raw: '1000',
      borrow_raw: '100',
      collateral_raw: '500',
    });
    expect(position.as_of.event_type).toBe('borrow');
  });

  it('maps a missing position to 404 and a missing base URL to 503', async () => {
    mockedGet.mockResolvedValue({ status: 404, data: {} } as any);
    await expect(
      fetchIndexedLendingPosition(ACCOUNT, { baseUrl: 'http://data.test' })
    ).rejects.toMatchObject({ status: 404 });

    mockedGet.mockClear();
    await expect(
      fetchIndexedLendingPosition(ACCOUNT, { baseUrl: '', apiKey: '' })
    ).rejects.toBeInstanceOf(DataPlatformError);
  });

  it('converts raw contract integers without inferring decimals', () => {
    expect(rawToHuman('12345678', 7)).toBeCloseTo(1.2345678);
    expect(() => rawToHuman('1', -1)).toThrow('decimals');
    expect(() => rawToHuman('not-an-int', 7)).toThrow('Invalid raw amount');
  });

  it('lists indexed pools and preserves unenriched pools as null state', async () => {
    mockedGet.mockResolvedValue({
      status: 200,
      data: {
        data: [
          {
            contract_id: 'CPOOL1',
            contract_name: 'cpmm-pool',
            pool_kind: 'cpmm',
            event_count: 4,
            trade_count: 2,
            last_event_at: '2026-10-22T00:00:00.000Z',
            state: {
              reserve_a_raw: '1000',
              reserve_b_raw: '2000',
              total_shares_raw: '1400',
              token_a: 'CTOKENA',
              token_b: 'CTOKENB',
              fee_bps: 30,
              amplification: null,
              observed_at: '2026-10-22T00:00:00.000Z',
              ledger: 106,
            },
          },
          {
            contract_id: 'CPOOL2',
            contract_name: 'cpmm-pool',
            pool_kind: 'cpmm',
            event_count: 1,
            trade_count: 0,
            last_event_at: null,
            state: null,
          },
        ],
      },
    } as any);

    const pools = await fetchIndexedPools({ baseUrl: 'http://data.test' });
    expect(mockedGet).toHaveBeenCalledWith(
      'http://data.test/financial/pools?limit=1000',
      expect.any(Object)
    );
    expect(pools).toHaveLength(2);
    expect(pools[0].state).toMatchObject({
      token_a: 'CTOKENA',
      reserve_a_raw: '1000',
      fee_bps: 30,
      ledger: 106,
    });
    expect(pools[1].state).toBeNull();
  });

  it('maps a malformed pool list to a 502', async () => {
    mockedGet.mockResolvedValue({ status: 200, data: { data: {} } } as any);
    await expect(
      fetchIndexedPools({ baseUrl: 'http://data.test' })
    ).rejects.toMatchObject({ status: 502 });
  });
});
