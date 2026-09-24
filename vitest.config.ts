import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    // forks: each concurrent file gets its own process, so process.env
    // mutations cannot race across files (the flake root cause).
    pool: 'forks',
    setupFiles: ['./vitest.setup.ts'],
    // resetModules()+@stellar/stellar-sdk reimport (networkVenueConfig) and
    // 10k-iteration property tests need headroom under parallel fork load;
    // the 5s default was itself a source of intermittent reds.
    testTimeout: 60_000,
  },
})
