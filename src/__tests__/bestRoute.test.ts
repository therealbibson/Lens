import { vi, describe, it, expect, beforeEach } from 'vitest'
import { getBestRoute, _resetHorizonServers } from '../aggregator/bestRoute'
import { pgPool } from '../db'
import * as StellarSdk from '@stellar/stellar-sdk'

// Mock dependencies
vi.mock('../db', () => ({
  pgPool: {
    query: vi.fn()
  }
}))

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const { mockStellarSdk } = await import('./helpers/stellarSdkMock')
  const callFn = vi.fn()
  return mockStellarSdk(importOriginal, {
    Horizon: {
      Server: vi.fn(function() {
        return {
          strictSendPaths: vi.fn().mockReturnThis(),
          call: callFn
        }
      })
    },
    Asset: Object.assign(
      vi.fn(function(code, issuer) { return { code, issuer } }),
      { native: vi.fn(() => 'native') }
    ),
    __mockCall: callFn
  })
})

describe('getBestRoute', () => {
  const assetA = { code: 'USDC', issuer: 'GA2C5RFPE6GCKIG3EQNCIMHO7OA7Q6M2XQ2UBNR5NCTU24VTY4A2J7B2' }
  const assetB = { code: 'XLM', issuer: null }
  const pairKey = 'USDC:XLM'

  const mockQuery = vi.mocked(pgPool.query)
  const mockCall = (StellarSdk as any).__mockCall

  beforeEach(() => {
    vi.clearAllMocks()
    // horizonServers is memoised at module scope (see bestRoute.ts) — clear
    // between tests so each one observes fresh Horizon.Server() constructions.
    _resetHorizonServers()
  })

  it('Case 1: returns SDEX when SDEX price is better', async () => {
    // SDEX Price: 0.5
    mockCall.mockResolvedValue({
      records: [{ destination_amount: '500' }] // 500 / 1000 = 0.5
    })
    
    // AMM Price: 0.4
    mockQuery.mockResolvedValue({
      rows: [{ reserve_a: '10000', reserve_b: '4000', fee_bp: '30' }]
    } as any)

    const result = await getBestRoute(assetA, assetB, pairKey, 1000)

    expect(result.route).toBe('SDEX')
    expect(result.sdexPrice).toBe(0.5)
    // precision handling
    expect(result.ammPrice).toBeCloseTo(0.362644, 6) 
  })

  it('Case 2: returns AMM when AMM price is better', async () => {
    // SDEX Price: 0.4
    mockCall.mockResolvedValue({
      records: [{ destination_amount: '400' }]
    })
    
    // AMM Price: 0.5 (approx)
    mockQuery.mockResolvedValue({
      rows: [{ reserve_a: '10000', reserve_b: '5000', fee_bp: '30' }]
    } as any)

    const result = await getBestRoute(assetA, assetB, pairKey, 1000)

    expect(result.route).toBe('AMM')
  })

  it('Case 3: Only one source available (SDEX only)', async () => {
    // SDEX Price: 0.5
    mockCall.mockResolvedValue({
      records: [{ destination_amount: '500' }]
    })
    
    // AMM: No pool data
    mockQuery.mockResolvedValue({ rows: [] } as any)

    const result = await getBestRoute(assetA, assetB, pairKey, 1000)

    expect(result.route).toBe('SDEX')
    expect(result.ammPrice).toBe(0)
  })

  it('Case 4: No data available throws error', async () => {
    // SDEX: no paths
    mockCall.mockResolvedValue({ records: [] })
    
    // AMM: No pool data
    mockQuery.mockResolvedValue({ rows: [] } as any)

    await expect(getBestRoute(assetA, assetB, pairKey, 1000))
      .rejects.toThrow('No pricing data available')
  })

  it('Case 5: Spread / price calculation precision', async () => {
    // Exact SDEX Price
    mockCall.mockResolvedValue({
      records: [{ destination_amount: '123.456789' }] // 123.456789 / 1000 = 0.123456789
    })

    // AMM: no pool data to simplify test or give known value
    mockQuery.mockResolvedValue({ rows: [] } as any)

    const result = await getBestRoute(assetA, assetB, pairKey, 1000)

    expect(result.sdexPrice).toBeCloseTo(0.123457, 6)
  })

  it('Case 6: queries the mainnet Horizon server when network="mainnet"', async () => {
    mockCall.mockResolvedValue({ records: [{ destination_amount: '500' }] })
    mockQuery.mockResolvedValue({ rows: [] } as any)

    await getBestRoute(assetA, assetB, pairKey, 1000, 'mainnet')

    const HorizonServerCtor = (StellarSdk as any).Horizon.Server
    const urls = HorizonServerCtor.mock.calls.map((call: unknown[]) => call[0])
    expect(urls.some((url: string) => url.includes('horizon.stellar.org'))).toBe(true)
    expect(urls.some((url: string) => url.includes('testnet'))).toBe(false)
  })

  it('Case 7: testnet and mainnet reuse a memoised Horizon server per network', async () => {
    mockCall.mockResolvedValue({ records: [{ destination_amount: '500' }] })
    mockQuery.mockResolvedValue({ rows: [] } as any)

    const HorizonServerCtor = (StellarSdk as any).Horizon.Server
    const callsBefore = HorizonServerCtor.mock.calls.length

    await getBestRoute(assetA, assetB, pairKey, 1000, 'mainnet')
    await getBestRoute(assetA, assetB, pairKey, 1000, 'mainnet')

    // Second mainnet call reuses the cached client — only one new Server() call.
    expect(HorizonServerCtor.mock.calls.length).toBe(callsBefore + 1)
  })
})
