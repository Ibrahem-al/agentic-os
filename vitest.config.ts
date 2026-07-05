import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // Keep the forks pool: ryugraph 25.9.1 segfaults at process teardown after
    // Database.close(). A forked worker reports its results over IPC before it
    // exits, so the dirty exit is tolerated; a threads pool would take the
    // whole runner down with it.
    pool: 'forks',
    // The same teardown fault occasionally kills a worker AFTER its files
    // finished reporting; vitest surfaces that as an unhandled "Worker exited
    // unexpectedly" error and exits 1 with zero test failures (seen on every
    // CI OS). Suppress EXACTLY that error — anything else still fails the run.
    onUnhandledError(error) {
      const text = `${error.message ?? ''}\n${(error as Error & { cause?: Error }).cause?.message ?? ''}`
      if (/Worker (forks emitted error|exited unexpectedly)/.test(text)) return false
      return
    },
    // Native storage ops (index builds, migrations, backups) on CI runners.
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
