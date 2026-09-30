import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Connection } from '../src/connection';
import { connectionLines, ConnectionStatus, findKubemoot, imageTag, readConnectionInfo, showConnectionInfo, statusText, type ConnectionInfo } from '../src/connectionInfo';
import { KubeError, type KubeTransport } from '../src/k8s/request';
import { recorded, resetFake } from './vscodeFake';

/** A cluster that answers /version, Deployments by label, and the Crew CRD, or fails where told. */
class VersionCluster implements KubeTransport {
  calls: string[] = [];
  version: unknown = { gitVersion: 'v1.33.2' };
  deployments: unknown = { items: [operator()] };
  namespaced: unknown = { items: [operator()] };
  crd: unknown = { metadata: { annotations: { 'meta.helm.sh/release-namespace': 'kubemoot' } } };
  failures = new Map<string, Error>();

  async request(_method: string, p: string): Promise<string> {
    this.calls.push(p);
    for (const [prefix, err] of this.failures) if (p.startsWith(prefix)) throw err;
    if (p === '/version') return JSON.stringify(this.version);
    if (p.startsWith('/apis/apps/v1/deployments')) return JSON.stringify(this.deployments);
    if (p.startsWith('/apis/apps/v1/namespaces/kubemoot/deployments')) return JSON.stringify(this.namespaced);
    if (p.startsWith('/apis/apiextensions.k8s.io')) return JSON.stringify(this.crd);
    throw new KubeError(`no route ${p}`, 404);
  }

  stream(): Promise<void> {
    return Promise.reject(new Error('no stream'));
  }
}

function operator(containers = [{ name: 'kube-rbac-proxy', image: 'proxy:1' }, { name: 'manager', image: 'harbor.example/kubemoot/operator:0.46.0-rc.3@sha256:abc' }]) {
  return { metadata: { namespace: 'kubemoot', labels: { 'helm.sh/chart': 'kubemoot-operator-0.46.0-rc.3' } }, spec: { template: { spec: { containers } } } };
}

let cluster: VersionCluster;
const connection = (): Connection => ({ source: '/home/me/.kube/lab.yaml', context: 'lab', client: cluster as never, server: 'https://10.0.0.1:6443' });

beforeEach(() => {
  resetFake();
  cluster = new VersionCluster();
});

describe('imageTag', () => {
  it('reads the tag of an image reference, with or without a registry port or digest', () => {
    expect(imageTag('harbor.example:5000/kubemoot/operator:0.46.0@sha256:abc')).toBe('0.46.0');
    expect(imageTag('operator:1.2')).toBe('1.2');
    expect(imageTag('harbor.example:5000/kubemoot/operator')).toBeUndefined();
    expect(imageTag(undefined)).toBeUndefined();
  });
});

describe('findKubemoot', () => {
  it('finds the operator by label across the cluster, preferring the manager container', async () => {
    expect(await findKubemoot(cluster)).toEqual({ namespace: 'kubemoot', image: 'harbor.example/kubemoot/operator:0.46.0-rc.3@sha256:abc', version: '0.46.0-rc.3', chart: '0.46.0-rc.3' });
    expect(cluster.calls[0]).toBe('/apis/apps/v1/deployments?labelSelector=app.kubernetes.io%2Fname%3Dkubemoot-operator');
  });

  it('falls back to the namespace of the release that owns the Crew CRD, and takes the first container when none is the manager', async () => {
    cluster.failures.set('/apis/apps/v1/deployments', new KubeError('forbidden', 403));
    cluster.namespaced = { items: [{ ...operator([{ name: 'op', image: 'op:2.0' }]), metadata: {} }] };
    expect(await findKubemoot(cluster)).toEqual({ namespace: '', image: 'op:2.0', version: '2.0', chart: undefined });
    cluster.namespaced = { items: [{}] };
    expect(await findKubemoot(cluster)).toEqual({ namespace: '', image: undefined, version: undefined, chart: undefined });
    cluster.crd = {};
    expect(await findKubemoot(cluster)).toBeUndefined();
    cluster.deployments = {};
    cluster.failures.clear();
    expect(await findKubemoot(cluster)).toBeUndefined();
  });
});

describe('readConnectionInfo', () => {
  it('reads the Kubernetes and Kubemoot versions', async () => {
    const info = await readConnectionInfo(connection, '0.14.0');
    expect(info).toMatchObject({ crewforge: '0.14.0', context: 'lab', server: 'https://10.0.0.1:6443', kubernetes: 'v1.33.2', kubemoot: { version: '0.46.0-rc.3' } });
    expect(connectionLines(info)).toEqual([
      'CrewForge 0.14.0',
      'Context: lab',
      'Server: https://10.0.0.1:6443',
      'Kubeconfig: /home/me/.kube/lab.yaml',
      'Kubernetes v1.33.2',
      'Kubemoot 0.46.0-rc.3, chart 0.46.0-rc.3 (operator in kubemoot)',
    ]);
  });

  it('says plainly when the kubeconfig or the cluster cannot be read, and when Kubemoot is missing', async () => {
    const noConfig = await readConnectionInfo(() => {
      throw new Error('no kubeconfig at ~/.kube/config');
    }, 'dev');
    expect(connectionLines(noConfig)).toEqual(['CrewForge dev', 'Cannot reach the cluster: no kubeconfig at ~/.kube/config']);
    cluster.failures.set('/version', new Error('connect ECONNREFUSED 10.0.0.1:6443'));
    const down = await readConnectionInfo(connection, 'dev');
    expect(connectionLines(down).at(-1)).toBe('Cannot reach the cluster: connect ECONNREFUSED 10.0.0.1:6443');
    cluster.failures.clear();
    cluster.deployments = { items: [] };
    cluster.version = {};
    const missing = await readConnectionInfo(connection, 'dev');
    expect(connectionLines(missing).slice(-2)).toEqual(['Kubernetes version unknown', 'Kubemoot: no Kubemoot operator found']);
    cluster.failures.set('/apis/apps/v1/deployments', new Error('forbidden'));
    cluster.failures.set('/apis/apiextensions.k8s.io', new Error('crd forbidden'));
    expect(connectionLines(await readConnectionInfo(connection, 'dev')).at(-1)).toBe('Kubemoot: cannot tell (crd forbidden)');
    const bare: ConnectionInfo = { crewforge: 'dev', kubernetes: 'v1', kubemoot: { namespace: 'k' } };
    expect(connectionLines(bare)).toEqual(['CrewForge dev', 'Kubernetes v1', 'Kubemoot version unknown (operator in k)']);
  });
});

describe('the connection status bar item', () => {
  it('names the context, and the kubeconfig file when it is not the default one', () => {
    expect(statusText({ context: 'lab', kubeconfig: path.join(os.homedir(), '.kube', 'config') })).toBe('$(plug) lab');
    expect(statusText({ context: 'lab', kubeconfig: '/home/me/.kube/lab.yaml' })).toBe('$(plug) lab (lab.yaml)');
    expect(statusText({ context: 'lab' })).toBe('$(plug) lab');
    expect(statusText({})).toBe('$(plug) not connected');
  });

  it('shows the connection, selects the context on click, and lists the versions on hover', async () => {
    const status = new ConnectionStatus(connection, '0.14.0');
    const [item] = recorded.statusBarItems;
    expect(item.command).toEqual({ command: 'crewforge.selectContext', title: 'Select Kubernetes Context' });
    const info = await status.update();
    expect(status.latest).toBe(info);
    expect(item).toMatchObject({ visible: true, text: '$(plug) lab (lab.yaml)' });
    expect(item.tooltip).toContain('Kubemoot 0.46.0-rc.3');
    status.dispose();
    expect(item.visible).toBe(false);
  });

  it('shows the details in a quick pick, and copies them for a bug report', async () => {
    const info = await readConnectionInfo(connection, '0.14.0');
    recorded.quickPicks.push((items: { label: string }[]) => items.at(-1));
    await showConnectionInfo(info);
    expect(recorded.clipboard).toEqual([connectionLines(info).join('\n')]);
    recorded.quickPicks.push((items: { label: string }[]) => items[0]);
    await showConnectionInfo(info);
    recorded.quickPicks.push(undefined);
    await showConnectionInfo(info);
    expect(recorded.clipboard).toHaveLength(1);
  });
});
