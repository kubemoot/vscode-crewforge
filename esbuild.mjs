import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const integration = process.argv.includes('--integration');

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

const builds = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  },
  {
    ...common,
    entryPoints: ['src/webview/page.ts'],
    outfile: 'dist/page.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  },
];

// The integration suite: a runner that starts VS Code, and the tests that run inside it.
const integrationBuilds = [
  {
    ...common,
    entryPoints: ['test/integration/runTest.ts'],
    outfile: '.vscode-test/out/runTest.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['@vscode/test-electron'],
  },
  {
    ...common,
    entryPoints: ['test/integration/suite/index.ts', 'test/integration/suite/*.it.ts'],
    outdir: '.vscode-test/out/suite',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode', 'mocha'],
  },
];

if (integration) {
  await Promise.all(integrationBuilds.map((b) => esbuild.build(b)));
} else if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
