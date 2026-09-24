import type { FastifyRequest } from 'fastify'
import { TransactionBuilder } from '@stellar/stellar-sdk'
import { getNetworkConfig, type NetworkName } from '../config'
import { redis } from '../redis'

/**
 * Hardening controls for POST /settle (#147): per-settlement fee ceiling,
 * rolling daily spend ceiling (per network), and an optional caller allow-list.
 *
 * Fail closed on spend-store outages — a silent Redis failure must not unlock
 * unlimited sponsored settling.
 */

export const FACILITATOR_DECLINED = 'facilitator_declined' as const

export type GuardRefusalReason =
  | 'fee_cap'
  | 'daily_cap'
  | 'caller_not_allowed'
  | 'store_unavailable'
  | 'fee_unreadable'

export interface GuardRefusal {
  ok: false
  reason: GuardRefusalReason
  errorMessage: string
  feeStroops?: number
}

export interface FeeOk {
  ok: true
  feeStroops: number
}

/** Minimal Redis surface so unit tests can substitute an in-memory store. */
export interface SpendStore {
  incrby(key: string, n: number): Promise<number>
  decrby(key: string, n: number): Promise<number>
  expire(key: string, seconds: number): Promise<unknown>
}

/**
 * Optional allow-list of resource-server origins / caller ids.
 * Empty (default) preserves open settle behaviour for the demo path.
 */
export function getAllowedCallers(): string[] {
  const raw = process.env.FACILITATOR_ALLOWED_ORIGINS ?? ''
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Resolves the caller identity from Origin or x-facilitator-caller.
 * Allow-list match is exact string equality against the configured entries.
 */
export function resolveCallerIdentity(req: FastifyRequest): string {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : ''
  if (origin) return origin
  const caller = req.headers['x-facilitator-caller']
  if (typeof caller === 'string' && caller.trim()) return caller.trim()
  return ''
}

export function assertCallerAllowed(req: FastifyRequest): GuardRefusal | null {
  const allowed = getAllowedCallers()
  if (allowed.length === 0) return null

  const identity = resolveCallerIdentity(req)
  if (identity && allowed.includes(identity)) return null

  return {
    ok: false,
    reason: 'caller_not_allowed',
    errorMessage: identity
      ? `Caller "${identity}" is not on FACILITATOR_ALLOWED_ORIGINS.`
      : 'Caller identity required when FACILITATOR_ALLOWED_ORIGINS is set (Origin or x-facilitator-caller).',
  }
}

/**
 * Reads the fee (stroops) the envelope declares — the amount the facilitator
 * will sponsor when `areFeesSponsored` is on.
 */
export function extractFeeStroops(transactionXdr: string, network: NetworkName): number | null {
  try {
    const passphrase = getNetworkConfig(network).network.passphrase
    const tx = TransactionBuilder.fromXDR(transactionXdr, passphrase)
    const fee = parseInt(tx.fee, 10)
    return Number.isFinite(fee) && fee >= 0 ? fee : null
  } catch {
    return null
  }
}

/**
 * Per-settlement fee ceiling — rejects before any ledger submission or daily
 * reservation. Independent of the rate limiter (which bounds frequency, not
 * balance).
 */
export function assertFeeWithinCap(transactionXdr: string, network: NetworkName): FeeOk | GuardRefusal {
  const feeStroops = extractFeeStroops(transactionXdr, network)
  if (feeStroops === null) {
    return {
      ok: false,
      reason: 'fee_unreadable',
      errorMessage: 'Could not read transaction fee from payment payload.',
    }
  }

  const perSettlementCap = getNetworkConfig(network).facilitator.feeStroops
  if (feeStroops > perSettlementCap) {
    return {
      ok: false,
      reason: 'fee_cap',
      feeStroops,
      errorMessage: `Settlement fee ${feeStroops} stroops exceeds per-settlement cap ${perSettlementCap} for ${network}.`,
    }
  }

  return { ok: true, feeStroops }
}

function utcDayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10)
}

export function dailySpendKey(network: NetworkName, day = utcDayKey()): string {
  return `lens:facilitator:daily-spend:${network}:${day}`
}

/**
 * Atomically reserves `feeStroops` against the network's rolling daily
 * ceiling. Increments first, then rolls back if the new total exceeds the
 * ceiling — so concurrent settles cannot race past the cap.
 *
 * Per-network keys: exhausting testnet does not block mainnet.
 * Fail closed: any store error refuses the settle.
 */
export async function reserveDailySpend(
  network: NetworkName,
  feeStroops: number,
  ceilingStroops: number,
  store: SpendStore = redis,
): Promise<GuardRefusal | { ok: true }> {
  const key = dailySpendKey(network)
  try {
    const newTotal = await store.incrby(key, feeStroops)
    // Survive process restart; TTL covers a UTC day boundary with margin.
    await store.expire(key, 60 * 60 * 48)

    if (newTotal > ceilingStroops) {
      await store.decrby(key, feeStroops)
      return {
        ok: false,
        reason: 'daily_cap',
        feeStroops,
        errorMessage: `Daily facilitator spend ceiling reached for ${network} (${ceilingStroops} stroops).`,
      }
    }
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      reason: 'store_unavailable',
      feeStroops,
      errorMessage: `Spend ledger unavailable; refusing settle (fail-closed): ${(err as Error).message}`,
    }
  }
}

/** Releases a reservation when settlement aborts before submission. */
export async function releaseDailySpend(
  network: NetworkName,
  feeStroops: number,
  store: SpendStore = redis,
): Promise<void> {
  try {
    await store.decrby(dailySpendKey(network), feeStroops)
  } catch {
    // Best-effort rollback; the key expires in 48h regardless.
  }
}
