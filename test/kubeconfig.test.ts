import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadKubeconfig, resolveKubeconfigSource } from '../src/k8s/kubeconfig';

function kubeconfig(dir: string, name: string, contexts: string[], current?: string): string {
  const file = path.join(dir, name);
  const yaml = [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    ...contexts.map((c) => `- name: ${c}\n  cluster:\n    server: https://${c}.example:6443`),
    'users:',
    ...contexts.map((c) => `- name: ${c}\n  user:\n    token: t-${c}`),
    'contexts:',
    ...contexts.map((c) => `- name: ${c}\n  context:\n    cluster: ${c}\n    user: ${c}`),
    current ? `current-context: ${current}` : '',
  ].join('\n');
  fs.writeFileSync(file, yaml);
  return file;
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-kc-'));

describe('resolveKubeconfigSource', () => {
  it('prefers the setting, then KUBECONFIG, then ~/.kube/config', () => {
    expect(resolveKubeconfigSource('/a/config', { KUBECONFIG: '/b' }, '/home/me')).toBe('/a/config');
    expect(resolveKubeconfigSource('  ', { KUBECONFIG: '/b' }, '/home/me')).toBe('/b');
    expect(resolveKubeconfigSource('', {}, '/home/me')).toBe(path.join('/home/me', '.kube', 'config'));
  });

  it('expands ~ in the setting', () => {
    expect(resolveKubeconfigSource('~/dev2next.yaml', {}, '/home/me')).toBe(path.join('/home/me', 'dev2next.yaml'));
  });
});

describe('loadKubeconfig', () => {
  it('loads a file and uses its current context', () => {
    const file = kubeconfig(tmp(), 'config', ['one', 'two'], 'two');
    const { source, config } = loadKubeconfig(file, '', {});
    expect(source).toBe(file);
    expect(config.getCurrentContext()).toBe('two');
    expect(config.getCurrentCluster()?.server).toBe('https://two.example:6443');
  });

  it('switches to a named context', () => {
    const file = kubeconfig(tmp(), 'config', ['one', 'two'], 'two');
    expect(loadKubeconfig(file, 'one', {}).config.getCurrentContext()).toBe('one');
  });

  it('names the contexts it has when asked for one it lacks', () => {
    const file = kubeconfig(tmp(), 'config', ['one', 'two'], 'one');
    expect(() => loadKubeconfig(file, 'three', {})).toThrow(/"three" is not in the kubeconfig \(it has: one, two\)/);
  });

  it('merges every file in KUBECONFIG, taking current-context from the first that sets one', () => {
    const dir = tmp();
    const a = kubeconfig(dir, 'a', ['alpha']);
    const b = kubeconfig(dir, 'b', ['beta'], 'beta');
    const { config } = loadKubeconfig('', '', { KUBECONFIG: [a, b].join(path.delimiter) });
    expect(config.getContexts().map((c) => c.name).sort()).toEqual(['alpha', 'beta']);
    expect(config.getCurrentContext()).toBe('beta');
  });

  it('keeps the first definition of a name repeated across files, as kubectl does', () => {
    const dir = tmp();
    const a = kubeconfig(dir, 'a', ['homelab'], 'homelab');
    const b = path.join(dir, 'b');
    fs.writeFileSync(b, fs.readFileSync(a, 'utf8').replace('https://homelab.example:6443', 'https://other.example:6443'));
    const c = kubeconfig(dir, 'c', ['gke']);
    const { config } = loadKubeconfig('', '', { KUBECONFIG: [a, b, c].join(path.delimiter) });
    expect(config.getClusters().map((x) => x.name).sort()).toEqual(['gke', 'homelab']);
    expect(config.getCurrentCluster()?.server).toBe('https://homelab.example:6443');
    expect(config.getContexts().map((x) => x.name).sort()).toEqual(['gke', 'homelab']);
  });

  it('fails helpfully when there is no current context', () => {
    const file = kubeconfig(tmp(), 'config', ['one']);
    expect(() => loadKubeconfig(file, '', {})).toThrow(/Select Kubernetes Context/);
  });

  it('says a missing file is missing, naming the path and where it looks', () => {
    const missing = path.join(tmp(), 'missing');
    expect(() => loadKubeconfig(missing, '', {})).toThrow(new RegExp(`no kubeconfig file at .*missing.*setting.*KUBECONFIG.*~/.kube/config.*Select Kubeconfig File`));
  });

  it('says a folder is a folder, not EISDIR', () => {
    const dir = tmp();
    const load = () => loadKubeconfig(dir, '', {});
    expect(load).toThrow(`${dir} is a folder, not a kubeconfig file`);
    expect(load).toThrow('Select Kubeconfig File');
    expect(load).not.toThrow(/EISDIR|Illegal operation/);
  });

  it('names the one bad entry in a KUBECONFIG list', () => {
    const dir = tmp();
    const good = kubeconfig(dir, 'good', ['alpha'], 'alpha');
    const folder = path.join(dir, 'a-folder');
    fs.mkdirSync(folder);
    expect(() => loadKubeconfig('', '', { KUBECONFIG: [good, folder].join(path.delimiter) })).toThrow(`${folder} is a folder`);
  });
});
