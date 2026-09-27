import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DeployCommands } from '../src/deploy/commands';
import type { KubeClient } from '../src/k8s/request';
import { listRevisions, materialize } from '../src/revisions/revisions';
import type { Deployment } from '../src/source/deployments';
import type { CrewSource } from '../src/source/discover';
import { execProgram } from '../src/source/nodeDeps';
import type { Exec, ExecOptions } from '../src/source/render';
import type { SourceTreeProvider } from '../src/views/sourceTree';
import { FakeCluster } from './fakeCluster';
import { recorded, resetFake } from './vscodeFake';

let repo: string;
let source: CrewSource;
let first: string;

function git(...args: string[]): string {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

function write(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
}

const crewYaml = (description: string) => `apiVersion: kubemoot.ai/v1alpha1\nkind: Crew\nmetadata:\n  name: demo\nspec:\n  description: ${description}\n`;

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-rev-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  write('crews/demo/Chart.yaml', 'apiVersion: v2\nname: demo\nversion: 0.1.0\n');
  write('crews/demo/templates/crew.yaml', crewYaml('first'));
  write('other/readme.md', 'unrelated');
  git('add', '.');
  git('commit', '-q', '-m', 'feat: first crew');
  first = git('rev-parse', '--short', 'HEAD');
  write('crews/demo/templates/crew.yaml', crewYaml('second'));
  git('commit', '-q', '-am', 'fix: sharper description');
  write('other/readme.md', 'changed');
  git('commit', '-q', '-am', 'docs: not the crew');
  source = { kind: 'helm', root: path.join(repo, 'crews', 'demo'), label: 'demo' };
});

describe('listRevisions', () => {
  it('lists only the commits that touched the source, newest first', async () => {
    const revisions = await listRevisions(execProgram, source);
    expect(revisions.map((r) => r.subject)).toEqual(['fix: sharper description', 'feat: first crew']);
    expect(revisions[1].hash).toBe(first);
    expect(revisions[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('says when there is no history', async () => {
    const lonely = { ...source, root: fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-nogit-')) };
    await expect(listRevisions(execProgram, lonely)).rejects.toThrow('demo has no git history');
  });
});

describe('materialize', () => {
  it('writes the source as it was, leaving the working tree alone', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-mat-'));
    const old = await materialize(execProgram, source, first, base);
    expect(fs.readFileSync(path.join(old.root, 'templates', 'crew.yaml'), 'utf8')).toContain('description: first');
    expect(fs.existsSync(path.join(old.root, 'Chart.yaml'))).toBe(true);
    expect(fs.readFileSync(path.join(source.root, 'templates', 'crew.yaml'), 'utf8')).toContain('description: second');
    expect(git('status', '--porcelain')).toBe('');
    expect(old).toMatchObject({ kind: 'helm', label: 'demo' });
  });

  it('refuses an unknown revision, a revision without the source, and an unreadable file', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-mat-'));
    await expect(materialize(execProgram, source, 'deadbeef', base)).rejects.toThrow('cannot read demo at deadbeef');
    const newer = { ...source, root: path.join(repo, 'other'), label: 'other' };
    write('other/new.yaml', 'x: 1');
    git('add', 'other/new.yaml');
    git('commit', '-q', '-m', 'add new');
    const empty = await execProgram('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: repo });
    const root = empty.stdout.trim();
    await expect(materialize(execProgram, { ...newer, root: path.join(repo, 'crews', 'missing') }, root, base)).rejects.toThrow();
    const failingShow: Exec = async (cmd, args, options) => (args[0] === 'show' ? { code: 128, stdout: '', stderr: 'bad object' } : execProgram(cmd, args, options));
    await expect(materialize(failingShow, source, first, base)).rejects.toThrow('cannot read Chart.yaml');
    const nothing: Exec = async () => ({ code: 0, stdout: '', stderr: '' });
    await expect(materialize(nothing, source, first, base)).rejects.toThrow(`demo did not exist at ${first}`);
  });
});

describe('deployRevision', () => {
  let ran: { command: string; args: string[]; options?: ExecOptions }[];
  let scratch: string;
  const exec: Exec = async (command, args, options) => {
    ran.push({ command, args, options });
    return command === 'git' ? execProgram(command, args, options) : { code: 0, stdout: `${command} done`, stderr: '' };
  };

  function commands(): DeployCommands {
    const output = { appendLine: (l: string) => recorded.output.push(l), show: () => undefined } as never;
    return new DeployCommands({ known: [] } as unknown as SourceTreeProvider, { exec, readYamlFiles: async () => [] }, output, () => undefined, () => ({
      source: '/k/config',
      context: 'lab',
      client: new FakeCluster() as unknown as KubeClient,
    }), scratch);
  }

  const node = (channel: Deployment['channel'], revision?: string) => ({
    kind: 'deployment' as const,
    entry: { source, identity: { id: 'x' }, crewName: 'demo' },
    deployment: { namespace: 'team-a', crew: { name: 'demo', namespace: 'team-a', ready: true, phase: 'Ready' }, channel, linked: true, release: 'rel', revision } as Deployment,
  });

  beforeEach(() => {
    resetFake();
    ran = [];
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-scratch-'));
  });

  it('deploys the chosen revision through the same channel, stamps it, and cleans up', async () => {
    let offered: { label: string; description: string }[] = [];
    recorded.quickPicks.push((items: { label: string; description: string; revision: { hash: string } }[]) => {
      offered = items;
      return items.find((i) => i.revision.hash === first);
    });
    recorded.warningAnswers.push('Deploy revision');
    await commands().deployRevision(node('helm', `${first}-dirty`));
    expect(offered.find((i) => i.label === first)?.description).toContain('deployed now');
    const helm = ran.find((r) => r.command === 'helm')!;
    expect(helm.args.slice(2, 5)).toEqual(['upgrade', '--install', 'rel']);
    expect(helm.args[5]).toContain(path.join(scratch, `demo-${first}-`));
    expect(recorded.warnings[0]).toContain(`as of ${first} (feat: first crew)`);
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  it('stops when no revision is picked or the developer declines, and sends Flux to git', async () => {
    recorded.quickPicks.push(undefined, (items: unknown[]) => items[0]);
    recorded.warningAnswers.push(undefined);
    await commands().deployRevision(node('bundle'));
    await commands().deployRevision(node('bundle'));
    await commands().deployRevision(node('flux'));
    expect(recorded.info[0]).toContain('revert the commit instead');
    await commands().deployRevision({ kind: 'message', text: 'x' } as never);
    expect(ran.filter((r) => r.command !== 'git')).toEqual([]);
  });
});
