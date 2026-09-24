import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'

const {
  mockCreate,
  mockFindUnique,
  mockUpdate,
  mockGetFacilitator,
  mockSettle,
  mockIncrby,
  mockDecrby,
  mockExpire,
} = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockFindUnique: vi.fn(),
  mockUpdate: vi.fn(),
  mockGetFacilitator: vi.fn(),
  mockSettle: vi.fn(),
  mockIncrby: vi.fn(),
  mockDecrby: vi.fn(),
  mockExpire: vi.fn(),
}))

vi.mock('../db', () => ({
  prisma: {
    settlementAttempt: {
      create: mockCreate,
      findUnique: mockFindUnique,
      update: mockUpdate,
    },
  },
}))

vi.mock('../redis', () => ({
  redis: {
    incrby: mockIncrby,
    decrby: mockDecrby,
    expire: mockExpire,
  },
}))

vi.mock('../x402/facilitator', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, getFacilitator: mockGetFacilitator }
})

import {
  assertCallerAllowed,
  assertFeeWithinCap,
  dailySpendKey,
  FACILITATOR_DECLINED,
  reserveDailySpend,
} from '../x402/settleGuards'
import { registerSettleRoute, SETTLE_ERROR_REASONS } from '../routes/facilitator'

function buildEnvelope(passphrase: string, fee: string): string {
  const keypair = Keypair.random()
  const account = new Account(keypair.publicKey(), '1')
  const tx = new TransactionBuilder(account, { fee, networkPassphrase: passphrase })
    .addOperation(Operation.payment({ destination: keypair.publicKey(), asset: Asset.native(), amount: '1' }))
    .setTimeout(60)
    .build()
  tx.sign(keypair)
  return tx.toXDR()
}

const LOW_FEE_ENVELOPE = buildEnvelope(Networks.TESTNET, '100')
const HIGH_FEE_ENVELOPE = buildEnvelope(Networks.TESTNET, '999999')

function settleBody(transaction = LOW_FEE_ENVELOPE, network = 'stellar:testnet') {
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      scheme: 'exact',
      network,
      payload: { transaction },
    },
    paymentRequirements: {
      scheme: 'exact',
      network,
      amount: '1000000',
      asset: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      payTo: 'G' + 'A'.repeat(55),
      maxTimeoutSeconds: 60,
    },
  }
}

async function buildApp() {
  const app = Fastify({ logger: false })
  await registerSettleRoute(app)
  await app.ready()
  return app
}

beforeEach(() => {
  mockCreate.mockReset().mockResolvedValue({ id: 'attempt-1' })
  mockFindUnique.mockReset().mockResolvedValue(null)
  mockUpdate.mockReset().mockResolvedValue({})
  mockSettle.mockReset().mockResolvedValue({
    success: true,
    transaction: 'onchain-hash',
    network: 'stellar:testnet',
    payer: 'GPAYER',
  })
  mockGetFacilitator.mockReset().mockReturnValue({ settle: mockSettle })
  mockIncrby.mockReset().mockResolvedValue(100)
  mockDecrby.mockReset().mockResolvedValue(0)
  mockExpire.mockReset().mockResolvedValue(1)
  delete process.env.FACILITATOR_ALLOWED_ORIGINS
})

afterEach(() => {
  delete process.env.FACILITATOR_ALLOWED_ORIGINS
})

describe('settle guards — unit', () => {
  it('rejects a fee above the per-settlement cap before any store write', () => {
    // Default FACILITATOR_FEE_STROOPS is 50000; 999999 must fail.
    const result = assertFeeWithinCap(HIGH_FEE_ENVELOPE, 'testnet')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('fee_cap')
  })

  it('accepts a fee within the per-settlement cap', () => {
    const result = assertFeeWithinCap(LOW_FEE_ENVELOPE, 'testnet')
    expect(result).toEqual({ ok: true, feeStroops: 100 })
  })

  it('allows any caller when the allow-list is empty', () => {
    const req = { headers: {} } as any
    expect(assertCallerAllowed(req)).toBeNull()
  })

  it('refuses a caller outside the allow-list', () => {
    process.env.FACILITATOR_ALLOWED_ORIGINS = 'https://allowed.example'
    const req = { headers: { origin: 'https://evil.example' } } as any
    const block = assertCallerAllowed(req)
    expect(block?.reason).toBe('caller_not_allowed')
  })

  it('allows a caller on the allow-list', () => {
    process.env.FACILITATOR_ALLOWED_ORIGINS = 'https://allowed.example'
    const req = { headers: { origin: 'https://allowed.example' } } as any
    expect(assertCallerAllowed(req)).toBeNull()
  })

  it('reserves against the daily ceiling and rolls back when exceeded', async () => {
    const store = {
      incrby: vi.fn().mockResolvedValue(600),
      decrby: vi.fn().mockResolvedValue(500),
      expire: vi.fn().mockResolvedValue(1),
    }
    const refused = await reserveDailySpend('testnet', 100, 500, store)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toBe('daily_cap')
    expect(store.decrby).toHaveBeenCalledWith(dailySpendKey('testnet'), 100)
  })

  it('scopes daily spend keys per network', () => {
    expect(dailySpendKey('testnet')).not.toBe(dailySpendKey('mainnet'))
  })

  it('fails closed when the spend store is unavailable', async () => {
    const store = {
      incrby: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      decrby: vi.fn(),
      expire: vi.fn(),
    }
    const refused = await reserveDailySpend('testnet', 100, 1_000_000, store)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.reason).toBe('store_unavailable')
  })
})

describe('POST /settle — hardening (#147)', () => {
  it('rejects an over-cap fee before creating an attempt or submitting', async () => {
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      payload: settleBody(HIGH_FEE_ENVELOPE),
    })

    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({
      success: false,
      errorReason: FACILITATOR_DECLINED,
    })
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockSettle).not.toHaveBeenCalled()
    expect(mockIncrby).not.toHaveBeenCalled()
  })

  it('refuses further settles once the daily cap is reached', async () => {
    mockIncrby.mockResolvedValueOnce(100_000_001) // default testnet ceiling 1e8
    const app = await buildApp()

    const res = await app.inject({ method: 'POST', url: '/settle', payload: settleBody() })

    expect(res.statusCode).toBe(403)
    expect(res.json().errorReason).toBe(SETTLE_ERROR_REASONS.declined)
    expect(res.json().errorMessage).toMatch(/Daily facilitator spend ceiling/)
    expect(mockSettle).not.toHaveBeenCalled()
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'failed' }) }),
    )
  })

  it('tracks daily spend under a per-network redis key', async () => {
    const app = await buildApp()
    await app.inject({ method: 'POST', url: '/settle', payload: settleBody() })

    expect(mockIncrby).toHaveBeenCalledWith(
      expect.stringContaining('lens:facilitator:daily-spend:testnet:'),
      100,
    )
  })

  it('does not share daily ceilings across networks', async () => {
    // Exhausting testnet reservation must use the testnet key only.
    const app = await buildApp()
    await app.inject({ method: 'POST', url: '/settle', payload: settleBody() })
    const key = mockIncrby.mock.calls[0][0] as string
    expect(key).toContain(':testnet:')
    expect(key).not.toContain(':mainnet:')
  })

  it('refuses a caller outside the allow-list with a SettleResponse shape', async () => {
    process.env.FACILITATOR_ALLOWED_ORIGINS = 'https://rs.example'
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/settle',
      headers: { origin: 'https://other.example' },
      payload: settleBody(),
    })

    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ success: false, errorReason: FACILITATOR_DECLINED })
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockSettle).not.toHaveBeenCalled()
  })

  it('is unchanged when the allow-list is empty', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url: '/settle', payload: settleBody() })
    expect(res.statusCode).toBe(200)
    expect(mockSettle).toHaveBeenCalledTimes(1)
  })

  it('replays an identical settle without a second submission or second spend', async () => {
    const app = await buildApp()
    const body = settleBody()

    const first = await app.inject({ method: 'POST', url: '/settle', payload: body })
    expect(first.statusCode).toBe(200)

    const stored = first.json()
    mockCreate.mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }))
    mockFindUnique.mockResolvedValue({ id: 'attempt-1', state: 'settled', response: stored })

    const second = await app.inject({ method: 'POST', url: '/settle', payload: body })

    expect(mockSettle).toHaveBeenCalledTimes(1)
    expect(mockIncrby).toHaveBeenCalledTimes(1)
    expect(second.json()).toEqual(stored)
  })

  it('registers a /settle rate limit tighter than the global 100/min default', async () => {
    const app = await buildApp()
    expect(app.hasRoute({ method: 'POST', url: '/settle' })).toBe(true)

    // Pull the route config Fastify stored when registerSettleRoute ran.
    const routes: Array<{ method: string | string[]; path?: string; url?: string; opts?: any; config?: any }> =
      (app as any).routes ?? []
    const post = routes.find(r => {
      const methods = Array.isArray(r.method) ? r.method : [r.method]
      const path = r.path ?? r.url
      return methods.includes('POST') && path === '/settle'
    })
    const max = post?.opts?.config?.rateLimit?.max ?? post?.config?.rateLimit?.max
    expect(max).toBeDefined()
    expect(max!).toBeLessThan(100)
    expect(max!).toBe(20)
  })
}
)
