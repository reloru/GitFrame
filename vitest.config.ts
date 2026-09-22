import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    coverage: {
      provider: 'v8',
      /*
       * src/sw.js is deliberately absent. It IS tested — test/sw.test.ts drives
       * its real install, activate and fetch handlers — but that test evaluates
       * the file as the classic script the browser loads, rather than importing
       * it, so V8 cannot attribute the execution back to the file. Including it
       * reports a flat 0% for well-covered code and drags the totals toward the
       * threshold for no signal at all.
       */
      include: ['src/**/*.ts', 'worker/**/*.ts'],
      reporter: ['text-summary', 'cobertura', 'html'],
      reportsDirectory: 'coverage',
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 85,
      },
    },
  },
});
