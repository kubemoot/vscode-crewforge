// Builds what the screenshot run needs: the extension itself, the runner that starts VS Code,
// and the suite that runs inside it. Run through `npm run screenshots`.
import * as esbuild from 'esbuild';

const common = { bundle: true, sourcemap: true, logLevel: 'info', platform: 'node', format: 'cjs', target: 'node20' };

await Promise.all([
  esbuild.build({ ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] }),
  esbuild.build({ ...common, entryPoints: ['src/webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'es2022' }),
  esbuild.build({ ...common, entryPoints: ['src/webview/page.ts'], outfile: 'dist/page.js', platform: 'browser', format: 'iife', target: 'es2022' }),
  esbuild.build({ ...common, entryPoints: ['scripts/screenshots/run.ts'], outfile: '.vscode-test/screenshots/run.js', external: ['@vscode/test-electron'] }),
  esbuild.build({ ...common, entryPoints: ['scripts/screenshots/suite.ts'], outfile: '.vscode-test/screenshots/suite.js', external: ['vscode'] }),
]);
