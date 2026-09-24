import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'

// vi.mock factories are hoisted — declare all mock fns with vi.hoisted()
const { mockHasPair, mockRegisterPair, mockPersistPair, mockGetActivePairs, mockQuery } = vi.hoisted(() => ({
  mockHasPair: vi.fn(),
  mockRegisterPair: vi.fn(),
  mockPersistPair: vi.fn(),
  mockGetActivePairs: vi.fn(),
  mockQuery: vi.fn(),
}))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
  prisma: {},
}))

vi.mock('../pairsRegistry', () => ({
  getActivePairs: mockGetActivePairs,
  hasPair: mockHasPair,
  registerPair: mockRegisterPair,
  persistPair: mockPersistPair,
  parseAssetStr: (s: string) => {
    const parts = s.split(':')
    const code = parts[0]?.toUpperCase()
    if (!code) return null
    const issuer = parts[1] && parts[1].toLowerCase() !== 'native' ? parts[1] : null
    if (issuer && !/^G[A-Z2-7]{55}$/.test(issuer)) return null
    return { code, issuer }
  },
  makePairKey: (a: any, b: any) => {
    const aStr = a.issuer ? `${a.code}:${a.issuer}` : a.code
    const bStr = b.issuer ? `${b.code}:${b.issuer}` : b.code
    return [aStr, bStr].sort().join('/')
  },
}))

import { registerPairsRoutes } from '../routes/pairs'

const ADMIN_KEY = 'test-admin-key-abc'
const VALID_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

async function buildApp() {
  // Keep ADMIN_API_KEY set through inject — the route reads it at request time.
  // Restoring here (before inject) raced with parallel files mutating process.env.
  process.env.ADMIN_API_KEY = ADMIN_KEY
  const app = Fastify({ logger: false })
  await registerPairsRoutes(app)
  await app.ready()
  return app
}

beforeEach(() => {
  process.env.ADMIN_API_KEY = ADMIN_KEY
  mockHasPair.mockReset().mockReturnValue(false)
  mockRegisterPair.mockReset().mockReturnValue(true)
  mockPersistPair.mockReset().mockResolvedValue(undefined)
  mockGetActivePairs.mockReset().mockReturnValue([])
  mockQuery.mockReset().mockResolvedValue({ rows: [] })
})

afterEach(() => {
  delete process.env.ADMIN_API_KEY
})

describe('POST /pairs', () => {
  it('adds a new pair and returns 201 with pairKey', async () => {
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/pairs',
      headers: { 'x-admin-key': ADMIN_KEY, 'content-type': 'application/json' },
      payload: { assetA: 'XLM:native', assetB: `USDC:${VALID_ISSUER}` },
    })

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body).toHaveProperty('pairKey')
    expect(mockRegisterPair).toHaveBeenCalledOnce()
    expect(mockPersistPair).toHaveBeenCalledOnce()
  })

  it('returns 401 when no auth key provided', async () => {
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/pairs',
      headers: { 'content-type': 'application/json' },
      payload: { assetA: 'XLM:native', assetB: `USDC:${VALID_ISSUER}` },
    })

    expect(res.statusCode).toBe(401)
    expect(mockRegisterPair).not.toHaveBeenCalled()
  })

  it('returns 401 when wrong auth key provided', async () => {
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/pairs',
      headers: { 'x-admin-key': 'wrong-key', 'content-type': 'application/json' },
      payload: { assetA: 'XLM:native', assetB: `USDC:${VALID_ISSUER}` },
    })

    expect(res.statusCode).toBe(401)
  })

  it('returns 400 when assetA is missing', async () => {
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/pairs',
      headers: { 'x-admin-key': ADMIN_KEY, 'content-type': 'application/json' },
      payload: { assetB: `USDC:${VALID_ISSUER}` },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/assetA/)
  })

  it('returns 400 for invalid assetA issuer format', async () => {
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/pairs',
      headers: { 'x-admin-key': ADMIN_KEY, 'content-type': 'application/json' },
      payload: { assetA: 'XLM:NOTAVALIDISSUER', assetB: `USDC:${VALID_ISSUER}` },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/assetA/)
  })

  it('returns 409 when pair already exists', async () => {
    mockHasPair.mockReturnValue(true)
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/pairs',
      headers: { 'x-admin-key': ADMIN_KEY, 'content-type': 'application/json' },
      payload: { assetA: 'XLM:native', assetB: `USDC:${VALID_ISSUER}` },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/already/)
    expect(mockRegisterPair).not.toHaveBeenCalled()
  })

  it('accepts Bearer token in Authorization header', async () => {
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/pairs',
      headers: { 'authorization': `Bearer ${ADMIN_KEY}`, 'content-type': 'application/json' },
      payload: { assetA: 'XLM:native', assetB: `USDC:${VALID_ISSUER}` },
    })

    expect(res.statusCode).toBe(201)
  })
})

describe('GET /pairs', () => {
  it('returns the list of active pairs', async () => {
    mockGetActivePairs.mockReturnValue([
      { pairKey: 'USDC/XLM', assetA: { code: 'XLM', issuer: null }, assetB: { code: 'USDC', issuer: VALID_ISSUER } },
    ])
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/pairs' })

    expect(res.statusCode).toBe(200)
    expect(res.json().pairs).toHaveLength(1)
    expect(res.json().pairs[0].pairKey).toBe('USDC/XLM')
  })
})
