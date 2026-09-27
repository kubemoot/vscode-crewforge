import { beforeEach, describe, expect, it } from 'vitest';
import { createCrewCommand } from '../src/create/createCrew';
import { createArgs, scaffoldCrew } from '../src/create/scaffold';
import type { Exec, ExecOptions } from '../src/source/render';
import { recorded, resetFake, Uri } from './vscodeFake';

let ran: { command: string; args: string[]; options?: ExecOptions }[];
let answer: { code: number; stdout: string; stderr: string };
const exec: Exec = async (command, args, options) => {
  ran.push({ command, args, options });
  return answer;
};

beforeEach(() => {
  resetFake();
  ran = [];
  answer = { code: 0, stdout: 'Scaffolded', stderr: '' };
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
    await expect(scaffoldCrew(exec, { name: 'demo', parent: '/w', members: 1 })).rejects.toThrow('needs kmctl on your PATH');
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
});
