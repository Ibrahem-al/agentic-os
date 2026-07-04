import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // Keep the forks pool: ryugraph 25.9.1 segfaults at process teardown after
    // Database.close(). A forked worker reports its results over IPC before it
    // exits, so the dirty exit is tolerated; a threads pool would take the
    // whole runner down with it.
    pool: 'forks',
    // Native storage ops (index builds, migrations, backups) on CI runners.
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
