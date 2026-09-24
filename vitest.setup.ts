/**
 * Isolate process.env across tests.
 *
 * Several suites mutate env vars (ADMIN_API_KEY, ADMIN_TOKEN, STELLAR_NETWORK,
 * WATCHED_PAIRS_*, REQUIRE_API_KEY, …). Vitest reuses worker processes across
 * files, and with `--pool=threads` files can even share one process concurrently.
 * Without a restore, one file's leftovers become another file's flake.
 *
 * Snapshot once per worker at load time; reset after every test. Suites that
 * need a sticky env for the whole file should set it in beforeEach (not only
 * beforeAll).
 */
import { afterEach } from 'vitest'

const ENV_SNAPSHOT: Record<string, string | undefined> = { ...process.env }

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ENV_SNAPSHOT)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(ENV_SNAPSHOT)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})
