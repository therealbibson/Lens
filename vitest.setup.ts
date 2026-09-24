/**
 * Enforce process.env isolation across the suite.
 *
 * Root cause of intermittent auth.test.ts / pairs.test.ts (and rotating
 * victims like networkVenueConfig.test.ts) failures: Vitest's default
 * `threads` pool runs multiple files concurrently inside one Node process,
 * so one file's `process.env` writes are visible to another mid-assertion.
 *
 * This setup file snapshots `process.env` before every test and restores it
 * afterwards so mutations cannot leak to the next test in the same worker.
 * Combined with `pool: 'forks'` in vitest.config.ts (separate process per
 * concurrent file), cross-file races are eliminated without giving up
 * file parallelism.
 */
import { beforeEach, afterEach } from 'vitest'

let envSnapshot: Record<string, string | undefined>

beforeEach(() => {
  envSnapshot = { ...process.env }
})

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})
