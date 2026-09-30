import { beforeEach, describe, expect, it } from 'vitest';
import { createCrewCommand } from '../src/create/createCrew';
import { atLeast, createArgs, kmctlProblem, parseVersion, scaffoldCrew } from '../src/create/scaffold';
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
  version = { code: 0, stdout: '0.13.0\n', stderr: '' };
});

describe('kmctl version check', () => {
  it('parses release, prerelease, and v-prefixed versions, and nothing else', () => {
    expect(parseVersion('0.12.0')).toEqual([0, 12, 0]);
    expect(parseVersion('v0.13.0-rc.1\n')).toEqual([0, 13, 0]);
    expect(parseVersion('dev')).toBeUndefined();
    expect(parseVersion('kmctl version 0.12.0')).toBeUndefined();
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
    version = { code: 0, stdout: '0.12.0\n', stderr: '' };
    expect(await kmctlProblem(exec)).toBeUndefined();
    version = { code: 0, stdout: 'dev\n', stderr: '' };
    expect(await kmctlProblem(exec)).toBeUndefined();
  });

  it('names the version found, the one needed, and where to get it', async () => {
    version = { code: 0, stdout: '0.11.3\n', stderr: '' };
    expect(await kmctlProblem(exec)).toBe(
      'Creating a crew needs kmctl 0.12.0 or later (for create --chart); found kmctl 0.11.3. Install a current release from https://github.com/kubemoot/kmctl/releases',
    );
    version = { code: 127, stdout: '', stderr: 'not found' };
    expect(await kmctlProblem(exec)).toMatch(/needs kmctl 0\.12\.0 or later on your PATH, and none was found\. Install it from https:\/\/github\.com\/kubemoot\/kmctl\/releases/);
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
    await expect(scaffoldCrew(exec, { name: 'demo', parent: '/w', members: 1 })).rejects.toThrow('needs kmctl 0.12.0 or later on your PATH, and none was found');
    answer = { code: 1, stdout: '', stderr: 'directory "/w/demo" already exists\n' };
    await expect(scaffoldCrew(exec, { name: 'demo', parent: '/w', members: 1 })).rejects.toThrow('kmctl create failed: directory "/w/demo" already exists');
  });
});

describe('createCrewCommand', () => {
  let refreshed = 0;
  const run = () => createCrewCommand(exec, { source: '/k/config', context: 'lab' }, () => refreshed++);

  it('asks for the name, size, and family, scaffolds, refreshes, and opens the README', async () => {
    recorded.workspaceFolders = [{ name: 'crews', uri: Uri.file('/w') }];
    recorded.inputs.push('demo');
    recorded.quickPicks.push((items: { label: string }[]) => items[1], (items: { label: string }[]) => items[0]);
    answer = { code: 0, stdout: '', stderr: 'warning: check models' };
    await run();
    expect(ran[0].args).toEqual(['create', 'demo', '--chart', '--no-input', '--members', '2', '-o', '/w', '--model-family', 'qwen', '--context', 'lab']);
    expect(refreshed).toBe(1);
    expect(recorded.warnings).toEqual(['warning: check models']);
    expect(recorded.shownDocuments).toEqual(['/w/demo/README.md']);
  });

  it('picks among several folders, leaves the family out on none, and stops when anything is cancelled', async () => {
    recorded.workspaceFolders = [{ name: 'a', uri: Uri.file('/a') }, { name: 'b', uri: Uri.file('/b') }];
    recorded.quickPicks.push((items: { label: string }[]) => items[1], (items: { label: string }[]) => items[0], (items: { label: string }[]) => items.find((i) => i.label === 'none'));
    recorded.inputs.push('demo');
    await run();
    expect(ran[0].args).toEqual(['create', 'demo', '--chart', '--no-input', '--members', '1', '-o', '/b', '--context', 'lab']);
    expect(recorded.warnings).toEqual([]);
    recorded.quickPicks.push(undefined);
    await run();
    recorded.quickPicks.push((items: { label: string }[]) => items[0]);
    recorded.inputs.push(undefined);
    await run();
    recorded.quickPicks.push((items: { label: string }[]) => items[0], undefined);
    recorded.inputs.push('demo');
    await run();
    recorded.quickPicks.push((items: { label: string }[]) => items[0], (items: { label: string }[]) => items[0], undefined);
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
    expect(recorded.modalErrors).toEqual(['Creating a crew needs kmctl 0.12.0 or later on your PATH, and none was found. Install it from https://github.com/kubemoot/kmctl/releases']);
    expect(ran).toEqual([]);
  });

  it('shows a failed scaffold as a modal error with kmctl\'s message, and does not refresh', async () => {
    recorded.workspaceFolders = [{ name: 'crews', uri: Uri.file('/w') }];
    recorded.inputs.push('demo');
    recorded.quickPicks.push((items: { label: string }[]) => items[0], (items: { label: string }[]) => items[0]);
    answer = { code: 1, stdout: '', stderr: 'Error: unknown flag: --chart\n' };
    const before = refreshed;
    await run();
    expect(recorded.modalErrors).toEqual(['CrewForge could not create demo. kmctl create failed: Error: unknown flag: --chart']);
    expect(refreshed).toBe(before);
    expect(recorded.shownDocuments).toEqual([]);
  });
});
