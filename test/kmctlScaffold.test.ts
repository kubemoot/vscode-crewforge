import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Connection } from '../src/connection';
import { execProgram, readText, readYamlFiles } from '../src/source/nodeDeps';
import { RenderError, type Exec } from '../src/source/render';
import { SourceService } from '../src/source/service';
import { SourceTreeProvider, type SourceNode } from '../src/views/sourceTree';
import { FakeCluster } from './fakeCluster';
import { resetFake } from './vscodeFake';

/**
 * A crew scaffolded by `kmctl create test --chart --members 2 --model-family qwen --providers ollama`,
 * and what `helm template test <chart> --namespace default` renders from it.
 */
const SCAFFOLD = path.join(__dirname, 'fixtures', 'kmctl', 'test');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

function scaffoldFiles(root = SCAFFOLD): { charts: string[]; yamls: string[] } {
  const files = walk(root);
  return { charts: files.filter((f) => f.endsWith('Chart.yaml')), yamls: files.filter((f) => /\.ya?ml$/.test(f) && !f.endsWith('Chart.yaml')) };
}

function hasHelm(): boolean {
  return (process.env.PATH ?? '').split(path.delimiter).some((d) => fs.existsSync(path.join(d, 'helm')));
}

const RENDERED = fs.readFileSync(path.join(__dirname, 'fixtures', 'kmctl', 'rendered.yaml'), 'utf8');

/** helm answers with the scaffold's recorded render; git says there is no repository. */
const cannedHelm: Exec = async (cmd) => (cmd === 'helm' ? { code: 0, stdout: RENDERED, stderr: '' } : { code: 128, stdout: '', stderr: 'not a repo' });

const connection = (cluster: FakeCluster) => (): Connection => ({ source: '/k', context: 'dev', client: cluster as never });

const serviceWith = (exec: Exec) => new SourceService({ exec, readText, readYamlFiles, listFiles: async () => scaffoldFiles() });

function tree(exec: Exec, service = serviceWith(exec)): SourceTreeProvider {
  return new SourceTreeProvider(service, connection(new FakeCluster()));
}

const labels = (provider: SourceTreeProvider, nodes: SourceNode[]) => nodes.map((n) => provider.getTreeItem(n).label);

beforeEach(() => resetFake());

describe('an undeployed kmctl scaffold in Crew Sources', () => {
  it.each([
    ['a recorded helm render', cannedHelm, true],
    ['the real helm', execProgram, hasHelm()],
  ])('shows what it declares, then that it is not deployed (%s)', async (_name, exec, run) => {
    if (!run) return;
    const provider = tree(exec);
    const [source] = await provider.getChildren();
    expect(provider.getTreeItem(source).description).toBe('helm');
    const children = await provider.getChildren(source);
    expect(labels(provider, children)).toEqual(['test', 'Agents', 'PromptModules', 'Skills', 'Fitness Scenarios', 'Not deployed in dev']);
    const agents = await provider.getChildren(children[1]);
    expect(labels(provider, agents)).toEqual(['test-coordinator', 'test-tooler-1', 'test-tooler-2']);
    const click = provider.getTreeItem(agents[1]).command!;
    expect(click.command).toBe('vscode.open');
    expect((click.arguments![0] as { fsPath: string }).fsPath).toBe(path.join(SCAFFOLD, 'templates', 'agents.yaml'));
    expect((click.arguments![1] as { selection: { startLine: number } }).selection.startLine).toBe(20);
    expect(await provider.getChildren(children[2])).toHaveLength(7);
    expect(labels(provider, await provider.getChildren(children[4]))).toEqual(['smoke-hello', 'general-knowledge', 'honest-no-fabrication']);
    const crewItem = provider.getTreeItem(children[0]);
    expect((crewItem.command!.arguments![0] as { fsPath: string }).fsPath).toBe(path.join(SCAFFOLD, 'templates', 'crew.yaml'));
  });

  it('shows a failed render as an item that opens the file and line it names', async () => {
    const failing: Exec = async (cmd) =>
      cmd === 'helm' ? { code: 1, stdout: '', stderr: 'Error: parse error at (test/templates/agents.yaml:12): function "oops" not defined' } : { code: 128, stdout: '', stderr: '' };
    const provider = tree(failing);
    const [source] = await provider.getChildren();
    const [error] = await provider.getChildren(source);
    const item = provider.getTreeItem(error);
    expect(item.label).toMatch(/^helm template failed for test/);
    expect(item.tooltip).toContain(`${path.join(SCAFFOLD, 'templates', 'agents.yaml')}:12`);
    expect((item.command!.arguments![1] as { selection: { startLine: number } }).selection.startLine).toBe(11);
  });

  it('shows a declarations failure after load as an item too, with its location when it has one', async () => {
    const service = serviceWith(cannedHelm);
    const provider = tree(cannedHelm, service);
    const entry = { source: { kind: 'helm' as const, root: SCAFFOLD, label: 'test' }, identity: { id: 'local:test' }, crewName: 'test', rendered: [] };
    service.declarations = async () => {
      throw new RenderError('bad fitness file', path.join(SCAFFOLD, 'fitness', 'fitness.yaml'));
    };
    const [first] = await provider.getChildren({ kind: 'source', entry });
    const item = provider.getTreeItem(first);
    expect(item.label).toBe('bad fitness file');
    expect((item.command!.arguments![1] as { selection: { startLine: number } }).selection.startLine).toBe(0);
    service.declarations = async () => {
      throw new Error('plain');
    };
    const [plain] = await provider.getChildren({ kind: 'source', entry });
    expect(provider.getTreeItem(plain).command).toBeUndefined();
  });

  it('draws the root a reload made without loading the workspace again', async () => {
    let loads = 0;
    const service = new SourceService({ exec: execProgram, readText, readYamlFiles, listFiles: async () => (loads++, { charts: [], yamls: [] }) });
    const provider = new SourceTreeProvider(service, connection(new FakeCluster()));
    await provider.reload();
    await provider.getChildren();
    expect(loads).toBe(1);
    await provider.getChildren();
    expect(loads).toBe(2);
    await provider.reload();
    provider.refresh();
    await provider.getChildren();
    expect(loads).toBe(4);
  });
});
