// ── Mocks ───────────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  db: {
    upsertPricePoints: vi.fn(),
    getIndexerCursor: vi.fn(),
    setIndexerCursor: vi.fn(),
  },
  webhook: {
    dispatchPriceUpdate: vi.fn().mockResolvedValue(undefined),
  },
  horizon: {
    mockCall: vi.fn(),
  }
}))

vi.mock('../db', () => mocks.db)
vi.mock('../webhookDispatcher', () => mocks.webhook)

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const { mockStellarSdk } = await import('./helpers/stellarSdkMock')

  class MockServer {
    constructor() {}
    trades() { return this }
    forAssetPair() { return this }
    cursor() { return this }
    limit() { return this }
    order() { return this }
    call() { return mocks.horizon.mockCall() }
  }

  return mockStellarSdk(importOriginal, {
    Horizon: {
      Server: MockServer,
    },
  })
})

// ── Imports ──────────────────────────────────────────────────────────────────
import { ingestPair } from '../ingesters/sdex'

describe('SDEX Ingester', () => {
  const mockPair = {
    pairKey: 'XLM-USD',
    assetA: { code: 'XLM', issuer: null },
    assetB: { code: 'USD', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn()
  })

  it('ingests SDEX trades correctly', async () => {
    mocks.db.getIndexerCursor.mockResolvedValue('0')
    
    mocks.horizon.mockCall.mockResolvedValue({
      records: [
        {
          id: 't-1',
          paging_token: 'p-1',
          base_asset_type: 'native',
          base_amount: '10.0',
          counter_amount: '2.0',
          price: { n: 2, d: 10 },
          ledger_close_time: '2024-01-01T00:00:00Z',
        }
      ]
    })

    await ingestPair(mockPair as any)

    expect(mocks.db.upsertPricePoints).toHaveBeenCalled()
  })

  it('handles zero trades safely', async () => {
    mocks.db.getIndexerCursor.mockResolvedValue('0')
    mocks.horizon.mockCall.mockResolvedValue({
      records: []
    })

    await ingestPair(mockPair as any)

    expect(mocks.db.upsertPricePoints).not.toHaveBeenCalled()
  })
})
