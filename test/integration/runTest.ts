/**
 * Runs the integration suite in a real VS Code: it packages CrewForge exactly as it ships
 * (the .vsix), unpacks it, and starts VS Code with it, a workspace holding a crew source,
 * and a kubeconfig that points at a local fake API server. No cluster is needed.
 *
 *   CREWFORGE_IT_EXTENSION  an unpacked extension folder to test instead of packaging one
 *   CREWFORGE_IT_VSIX       a .vsix to unpack and test instead of packaging one
 *   VSCODE_VERSION          the VS Code to download ("stable" by default)
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { startFakeApi } from '../fakeApiServer';
import { integrationCluster } from './cluster';

const repo = path.resolve(__dirname, '..', '..');
const work = path.join(repo, '.vscode-test');

/** Packages the extension as `npm run package` does, into .vscode-test. */
function packageVsix(): string {
  const vsix = path.join(work, 'crewforge.vsix');
  execFileSync(process.execPath, ['esbuild.mjs', '--production'], { cwd: repo, stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(repo, 'node_modules', '@vscode', 'vsce', 'vsce'), 'package', '--no-dependencies', '-o', vsix], { cwd: repo, stdio: 'inherit' });
  return vsix;
}

/** The files of a .vsix as VS Code installs them. */
function unpack(vsix: string): string {
  const into = path.join(work, 'unpacked');
  fs.rmSync(into, { recursive: true, force: true });
  execFileSync('unzip', ['-q', '-o', vsix, '-d', into]);
  return path.join(into, 'extension');
}

function extensionUnderTest(): string {
  if (process.env.CREWFORGE_IT_EXTENSION) return path.resolve(process.env.CREWFORGE_IT_EXTENSION);
  return unpack(process.env.CREWFORGE_IT_VSIX ? path.resolve(process.env.CREWFORGE_IT_VSIX) : packageVsix());
}

/** A workspace with the demo bundle source, and a user profile whose settings point CrewForge at the fake API server. */
function prepare(kubeconfig: string): { workspace: string; userData: string } {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-it-'));
  const workspace = path.join(scratch, 'workspace');
  fs.cpSync(path.join(repo, 'test', 'fixtures', 'sources', 'bundles', 'demo'), path.join(workspace, 'demo'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'notes'));
  fs.writeFileSync(path.join(workspace, 'notes', 'readme.md'), 'A folder outside any crew source.\n');
  const userData = path.join(scratch, 'user');
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  const settings = {
    'crewforge.kubeconfig': kubeconfig,
    'security.workspace.trust.enabled': false,
    'workbench.startupEditor': 'none',
    'extensions.autoUpdate': false,
    'update.mode': 'none',
    'telemetry.telemetryLevel': 'off',
  };
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify(settings, null, 2));
  return { workspace, userData };
}

async function main(): Promise<void> {
  fs.mkdirSync(work, { recursive: true });
  const extensionDevelopmentPath = extensionUnderTest();
  const api = await startFakeApi({ cluster: integrationCluster(), context: 'kind-fake' });
  const { workspace, userData } = prepare(api.kubeconfig);
  try {
    const vscodeExecutablePath = await downloadAndUnzipVSCode(process.env.VSCODE_VERSION ?? 'stable');
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath: path.join(__dirname, 'suite', 'index.js'),
      launchArgs: [workspace, '--user-data-dir', userData, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu'],
      extensionTestsEnv: { CREWFORGE_IT_WORKSPACE: workspace, CREWFORGE_IT_API: api.url, CREWFORGE_IT_LOGS: path.join(userData, 'logs') },
    });
  } finally {
    await api.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
