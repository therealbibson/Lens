import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    setupFiles: ['./vitest.setup.ts'],
    // Parallel file runs contend on transform/import; the default 5s timeout
    // flakes on cold Fastify boots (auth/pairs) and resetModules+config imports.
    // Keep fileParallelism on — isolation is fixed via env restore, not by
    // serialising the suite.
    testTimeout: 20_000,
  },
})
