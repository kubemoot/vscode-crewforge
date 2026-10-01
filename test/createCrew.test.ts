import { beforeEach, describe, expect, it } from 'vitest';
import { createCrewCommand, CREW_SIZES, DEPLOY_NEXT, showCreatedCrew } from '../src/create/createCrew';
import type { SourceNode } from '../src/views/sourceTree';
import { atLeast, createArgs, KMCTL_MIN_VERSION, kmctlProblem, parseVersion, scaffoldCrew } from '../src/create/scaffold';
import type { Exec, ExecOptions } from '../src/source/render';
import { recorded, resetFake, Uri } from './vscodeFake';

let ran: { command: string; args: string[]; options?: ExecOptions }[];
let answer: { code: number; stdout: string; stderr: string };
let version: { code: number; stdout: string; stderr: string };
const exec: Exec = async (command, args, options) => {
  if (args[0] === 'version') return version;
  ran.push({ command, args, options });
  return answer;
};

beforeEach(() => {
  resetFake();
  ran = [];
  answer = { code: 0, stdout: 'Scaffolded', stderr: '' };
  version = { code: 0, stdout: '0.14.0\n', stderr: '' };
});

describe('kmctl version check', () => {
  it('parses release, prerelease, and v-prefixed versions, and nothing else', () => {
    expect(parseVersion('0.12.0')).toEqual([0, 12, 0]);
    expect(parseVersion('v0.13.0-rc.1\n')).toEqual([0, 13, 0]);
    expect(parseVersion('dev')).toBeUndefined();
    expect(parseVersion('kmctl version 0.12.0')).toBeUndefined();
  });

  it('needs the kmctl release with the starter crew: 0.13.9 is too old, 0.14.0 will do', async () => {
    expect(parseVersion(KMCTL_MIN_VERSION)).toEqual([0, 14, 0]);
    version = { code: 0, stdout: '0.13.9\n', stderr: '' };
    expect(await kmctlProblem(exec)).toContain('needs kmctl 0.14.0 or later');
    version = { code: 0, stdout: 'v0.14.0\n', stderr: '' };
    expect(await kmctlProblem(exec)).toBeUndefined();
  });

  it('compares by major, minor, then patch; a prerelease counts as its release', () => {
    const min = parseVersion('0.12.0')!;
    expect(atLeast(parseVersion('0.11.3')!, min)).toBe(false);
    expect(atLeast(parseVersion('0.11.15')!, min)).toBe(false);
    expect(atLeast(parseVersion('0.12.0')!, min)).toBe(true);
    expect(atLeast(parseVersion('0.12.0-rc.1')!, min)).toBe(true);
    expect(atLeast(parseVersion('0.12.1')!, min)).toBe(true);
    expect(atLeast(parseVersion('1.0.0')!, min)).toBe(true);
    expect(atLeast(parseVersion('0.9.9')!, min)).toBe(false);
  });

  it('accepts a new enough or development kmctl', async () => {
    expect(await kmctlProblem(exec)).toBeUndefined();
    version = { code: 0, stdout: '0.15.2\n', stderr: '' };
    expect(await kmctlProblem(exec)).toBeUndefined();
    version = { code: 0, stdout: 'dev\n', stderr: '' };
    expect(await kmctlProblem(exec)).toBeUndefined();
  });

  it('names the version found, the one needed, and where to get it', async () => {
    version = { code: 0, stdout: '0.13.0\n', stderr: '' };
    expect(await kmctlProblem(exec)).toBe(
      'Creating a crew needs kmctl 0.14.0 or later (for the starter crew); found kmctl 0.13.0. Install a current release from https://github.com/kubemoot/kmctl/releases',
    );
    version = { code: 127, stdout: '', stderr: 'not found' };
    expect(await kmctlProblem(exec)).toMatch(/needs kmctl 0\.14\.0 or later on your PATH, and none was found\. Install it from https:\/\/github\.com\/kubemoot\/kmctl\/releases/);
    version = { code: 1, stdout: '', stderr: 'unknown flag: --short' };
    expect(await kmctlProblem(exec)).toMatch(/`kmctl version` failed: unknown flag: --short/);
    version = { code: 2, stdout: 'odd', stderr: '' };
    expect(await kmctlProblem(exec)).toMatch(/failed: odd/);
  });
});

describe('createArgs', () => {
  it('asks kmctl for a chart without prompts, with the family and context when given', () => {
    expect(createArgs({ name: 'demo', parent: '/w', members: 2 })).toEqual(['create', 'demo', '--chart', '--no-input', '--members', '2', '-o', '/w']);
    expect(createArgs({ name: 'demo', parent: '/w', members: 1, modelFamily: 'qwen' }, 'lab')).toEqual([
      'create', 'demo', '--chart', '--no-input', '--members', '1', '-o', '/w', '--model-family', 'qwen', '--context', 'lab',
    ]);
  });
});

describe('scaffoldCrew', () => {
  it('runs kmctl with the kubeconfig and returns the chart folder and warnings', async () => {
    answer = { code: 0, stdout: 'ok', stderr: 'warning: no Models were generated\n' };
    const out = await scaffoldCrew(exec, { name: 'demo', parent: '/w', members: 1 }, { source: '/k/config', context: 'lab' });
    expect(out).toEqual({ root: '/w/demo', warnings: 'warning: no Models were generated' });
    expect(ran[0]).toMatchObject({ command: 'kmctl', options: { env: { KUBECONFIG: '/k/config' }, cwd: '/w' } });
    await scaffoldCrew(exec, { name: 'demo', parent: '/w', members: 1 });
    expect(ran[1].options?.env).toBeUndefined();
  });

  it('says how to get kmctl when it is missing, and passes its errors on', async () => {
    answer = { code: 127, stdout: '', stderr: 'kmctl was not found on PATH' };
    await expect(scaffoldCrew(exec, { name: 'demo', parent: '/w', members: 1 })).rejects.toThrow('needs kmctl 0.14.0 or later on your PATH, and none was found');
    answer = { code: 1, stdout: '', stderr: 'directory "/w/demo" already exists\n' };
    await expect(scaffoldCrew(exec, { name: 'demo', parent: '/w', members: 1 })).rejects.toThrow('kmctl create failed: directory "/w/demo" already exists');
  });
});

describe('createCrewCommand', () => {
  let created: string[] = [];
  const run = (folder?: string) => createCrewCommand(exec, { source: '/k/config', context: 'lab' }, async (root) => void created.push(root), folder);
  const first = (items: { label: string }[]) => items[0];

  beforeEach(() => (created = []));

  it('asks for the folder, name, size, and family, scaffolds, and hands over the new chart', async () => {
    recorded.workspaceFolders = [{ name: 'crews', uri: Uri.file('/w') }];
    recorded.inputs.push('demo');
    recorded.quickPicks.push(first, (items: { label: string }[]) => items[1], first);
    answer = { code: 0, stdout: '', stderr: 'warning: check models' };
    await run();
    expect(ran[0].args).toEqual(['create', 'demo', '--chart', '--no-input', '--members', '2', '-o', '/w', '--model-family', 'qwen', '--context', 'lab']);
    expect(created).toEqual(['/w/demo']);
    expect(recorded.warnings).toEqual(['warning: check models']);
  });

  it('offers the starter crew from 1 to 5 specialists, each size naming what it adds, and passes the size on', async () => {
    recorded.workspaceFolders = [{ name: 'crews', uri: Uri.file('/w') }];
    recorded.inputs.push('demo');
    let offered: { label: string; description?: string }[] = [];
    recorded.quickPicks.push(first, (items: typeof offered) => ((offered = items), items[4]), first);
    await run();
    expect(offered).toEqual(CREW_SIZES);
    expect(offered.map((i) => i.label)).toEqual(['1', '2', '3', '4', '5']);
    ['workloads', 'events', 'networking', 'config', 'reviewer'].forEach((key, i) => expect(offered[i].description).toContain(key));
    expect(ran[0].args.slice(4, 6)).toEqual(['--members', '5']);
  });

  it('creates in the Explorer folder of New Kubemoot Crew Here without asking for a folder', async () => {
    recorded.inputs.push('demo');
    recorded.quickPicks.push(first, first);
    await run('/w/crews/team');
    expect(ran[0].args).toContain('/w/crews/team');
    expect(created).toEqual(['/w/crews/team/demo']);
  });

  it("offers the active file's folder first, then the workspace folders, then a folder picker", async () => {
    recorded.workspaceFolders = [{ name: 'a', uri: Uri.file('/a') }, { name: 'b', uri: Uri.file('/b') }];
    recorded.activeEditor = { document: { uri: Uri.file('/b/sub/notes.md'), languageId: 'markdown', getText: () => '' }, selection: undefined };
    let offered: { detail?: string; description?: string; label: string }[] = [];
    recorded.quickPicks.push((items: typeof offered) => ((offered = items), items[0]), first, first);
    recorded.inputs.push('demo');
    await run();
    expect(offered.map((i) => i.detail)).toEqual(['/b/sub', '/a', '/b', undefined]);
    expect(offered[0].description).toBe("the active file's folder");
    expect(offered.at(-1)?.label).toContain('Browse');
    expect(created).toEqual(['/b/sub/demo']);
    recorded.openDialog = [Uri.file('/elsewhere')];
    recorded.quickPicks.push((items: typeof offered) => items.at(-1), first, first);
    recorded.inputs.push('demo');
    await run();
    expect(created.at(-1)).toBe('/elsewhere/demo');
    recorded.openDialog = undefined;
    recorded.quickPicks.push((items: typeof offered) => items.at(-1));
    await run();
    expect(created).toHaveLength(2);
  });

  it('starts from the first workspace folder when the active file is outside the workspace or not a file', async () => {
    recorded.workspaceFolders = [{ name: 'a', uri: Uri.file('/a') }];
    let offered: { detail?: string; description?: string }[] = [];
    for (const uri of [Uri.file('/tmp/x.yaml'), Uri.parse('untitled:Untitled-1')]) {
      recorded.activeEditor = { document: { uri, languageId: 'yaml', getText: () => '' }, selection: undefined };
      recorded.quickPicks.push((items: typeof offered) => ((offered = items), undefined));
      await run();
      expect(offered.map((i) => [i.detail, i.description])).toEqual([['/a', undefined], [undefined, undefined]]);
    }
    expect(ran).toEqual([]);
  });

  it('leaves the family out on none, and stops when anything is cancelled', async () => {
    recorded.workspaceFolders = [{ name: 'a', uri: Uri.file('/a') }];
    recorded.quickPicks.push(first, first, (items: { label: string }[]) => items.find((i) => i.label === 'none'));
    recorded.inputs.push('demo');
    await run();
    expect(ran[0].args).toEqual(['create', 'demo', '--chart', '--no-input', '--members', '1', '-o', '/a', '--context', 'lab']);
    recorded.quickPicks.push(undefined);
    await run();
    recorded.quickPicks.push(first);
    recorded.inputs.push(undefined);
    await run();
    recorded.quickPicks.push(first, undefined);
    recorded.inputs.push('demo');
    await run();
    recorded.quickPicks.push(first, first, undefined);
    recorded.inputs.push('demo');
    await run();
    expect(ran).toHaveLength(1);
  });

  it('needs an open folder', async () => {
    await run();
    expect(recorded.info[0]).toContain('Open a folder first');
    expect(ran).toEqual([]);
  });

  it('checks kmctl before asking anything, and stops with a modal error when it is too old', async () => {
    recorded.workspaceFolders = [{ name: 'crews', uri: Uri.file('/w') }];
    version = { code: 0, stdout: '0.11.3\n', stderr: '' };
    await run();
    expect(recorded.modalErrors).toHaveLength(1);
    expect(recorded.modalErrors[0]).toContain('found kmctl 0.11.3');
    expect(recorded.modalErrors[0]).toContain('https://github.com/kubemoot/kmctl/releases');
    expect(recorded.inputs).toEqual([]);
    expect(ran).toEqual([]);
  });

  it('stops with a modal error when kmctl is not on the PATH', async () => {
    recorded.workspaceFolders = [{ name: 'crews', uri: Uri.file('/w') }];
    version = { code: 127, stdout: '', stderr: 'kmctl was not found on PATH' };
    await run();
    expect(recorded.modalErrors).toEqual(['Creating a crew needs kmctl 0.14.0 or later on your PATH, and none was found. Install it from https://github.com/kubemoot/kmctl/releases']);
    expect(ran).toEqual([]);
  });

  it("shows a failed scaffold as a modal error with kmctl's message, and hands nothing over", async () => {
    recorded.workspaceFolders = [{ name: 'crews', uri: Uri.file('/w') }];
    recorded.inputs.push('demo');
    recorded.quickPicks.push(first, first, first);
    answer = { code: 1, stdout: '', stderr: 'Error: unknown flag: --chart\n' };
    await run();
    expect(recorded.modalErrors).toEqual(['CrewForge could not create demo. kmctl create failed: Error: unknown flag: --chart']);
    expect(created).toEqual([]);
  });
});

describe('showCreatedCrew', () => {
  const entry = (root: string) => ({ source: { kind: 'helm' as const, root, label: 'demo' }, identity: { id: 'local:demo' }, crewName: 'demo' });
  const nodes: SourceNode[] = [{ kind: 'message', text: 'x' }, { kind: 'source', entry: entry('/w/other') }, { kind: 'source', entry: entry('/w/demo') }];
  let revealed: SourceNode[];
  const deps = () => ({ reload: async () => nodes, reveal: async (node: SourceNode) => void revealed.push(node) });

  beforeEach(() => (revealed = []));

  it('selects the crew in Crew Sources, opens crew.yaml beside the README, and offers the dev deploy', async () => {
    recorded.infoAnswers.push(DEPLOY_NEXT);
    await showCreatedCrew('/w/demo', deps());
    expect(revealed).toEqual([nodes[2]]);
    expect(recorded.shownDocuments).toEqual(['/w/demo/README.md', '/w/demo/templates/crew.yaml']);
    expect(recorded.shownOptions[1]).toEqual({ viewColumn: -2, preview: false });
    expect(recorded.info[0]).toContain('Next: deploy it to a namespace');
    await new Promise((r) => setTimeout(r, 0));
    expect(recorded.executed).toEqual([{ id: 'crewforge.deployToNamespace', args: [nodes[2]] }]);
  });

  it('does nothing more when the offer is dismissed, and says when the crew is outside the workspace', async () => {
    await showCreatedCrew('/w/demo', deps());
    await new Promise((r) => setTimeout(r, 0));
    expect(recorded.executed).toEqual([]);
    await showCreatedCrew('/tmp/lost', deps());
    expect(revealed).toHaveLength(1);
    expect(recorded.info.at(-1)).toContain('outside this workspace');
    expect(recorded.shownDocuments.slice(-2)).toEqual(['/tmp/lost/README.md', '/tmp/lost/templates/crew.yaml']);
  });
});
