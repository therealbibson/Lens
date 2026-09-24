/**
 * Vitest helper for partial `@stellar/stellar-sdk` mocks.
 *
 * Spreading an ESM module namespace (`{ ...await importOriginal() }`) drops
 * non-enumerable named exports such as `Networks`. Vitest then reports:
 *   No "Networks" export is defined on the "@stellar/stellar-sdk" mock
 * which made Typecheck & build red on every PR (including markdown-only ones).
 *
 * Copy own-property names explicitly so the real SDK surface stays intact,
 * then layer only the overrides a test needs.
 */
export async function mockStellarSdk(
  importOriginal: <T = typeof import('@stellar/stellar-sdk')>() => Promise<T>,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>()
  const exports: Record<string, unknown> = Object.fromEntries(
    Object.getOwnPropertyNames(actual).map((key) => [
      key,
      (actual as unknown as Record<string, unknown>)[key],
    ]),
  )
  return { ...exports, ...overrides }
}
