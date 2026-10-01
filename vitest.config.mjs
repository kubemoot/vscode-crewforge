import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The extension imports 'vscode', which exists only inside VS Code; tests use a fake.
    alias: { vscode: fileURLToPath(new URL('./test/vscodeFake.ts', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      include: ['src/**'],
      thresholds: { statements: 98.5, branches: 95, functions: 96, lines: 99 },
    },
  },
});
