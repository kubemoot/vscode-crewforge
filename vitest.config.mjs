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
      thresholds: { statements: 90, branches: 80, functions: 90, lines: 90 },
    },
  },
});
