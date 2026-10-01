import { beforeEach, describe, expect, it } from 'vitest';
import { crewButtons } from '../src/dashboard/crewPage';
import type { CrewVitals } from '../src/dashboard/crewVitals';
import { renderFitnessPage } from '../src/dashboard/fitnessPage';
import { unreachable } from '../src/discussion/availability';
import { showError } from '../src/views/notify';
import { ConnectionError, CredentialsError, isConnectionProblem, KubeError, type KubeClient } from '../src/k8s/request';
import type { SourceEntry, SourceService } from '../src/source/service';
import { CrewTreeProvider } from '../src/views/crewTree';
import { SourceTreeProvider } from '../src/views/sourceTree';
import { errorDetail, errorItems, rawDetail } from '../src/views/errors';
import { recorded, resetFake } from './vscodeFake';

const refused = new ConnectionError('No response from context lab at https://127.0.0.1:6443. Is the cluster running?', 'connect ECONNREFUSED 127.0.0.1:6443');

beforeEach(resetFake);

describe('an unreachable cluster, everywhere', () => {
  it('keeps the raw error for the tooltip only when it says more', () => {
    expect(rawDetail(refused)).toBe('connect ECONNREFUSED 127.0.0.1:6443');
    expect(errorDetail(refused)).toBe('No response from context lab at https://127.0.0.1:6443. Is the cluster running?\n\nDetails: connect ECONNREFUSED 127.0.0.1:6443');
    const repeated = new KubeError('Not found. GET /x returned 404', 404, 'GET /x returned 404');
    expect(rawDetail(repeated)).toBeUndefined();
    expect(errorDetail(repeated)).toBe('Not found. GET /x returned 404');
    expect(errorDetail(new Error('plain'))).toBe('plain');
  });

  it('knows which errors another context may fix', () => {
    expect(isConnectionProblem(refused)).toBe(true);
    expect(isConnectionProblem(new CredentialsError('no login'))).toBe(true);
    expect(isConnectionProblem(new KubeError('who are you', 401))).toBe(true);
    expect(isConnectionProblem(new KubeError('not you', 403))).toBe(false);
    expect(isConnectionProblem(new KubeError('gone', 404))).toBe(false);
    expect(isConnectionProblem(new Error('x'))).toBe(false);
  });

  it('shows the plain message in a tree, the raw one on hover, and Select Kubernetes Context under it', () => {
    expect(errorItems(refused)).toEqual([
      { kind: 'message', text: 'No response from context lab at https://127.0.0.1:6443.', detail: errorDetail(refused) },
      { kind: 'message', text: 'Select Kubernetes Context...', detail: 'Pick another context from the kubeconfig.', icon: 'server-environment', command: { command: 'crewforge.selectContext', title: 'Select Kubernetes Context' } },
    ]);
    expect(errorItems(new Error('Bad YAML. More.'))).toEqual([{ kind: 'message', text: 'Bad YAML.', detail: 'Bad YAML. More.' }]);
  });

  it('lists Deployed Crews as the plain error and the action that may fix it', async () => {
    const client = { request: () => Promise.reject(refused), stream: () => Promise.reject(refused) } as unknown as KubeClient;
    const tree = new CrewTreeProvider(() => ({ source: '/k', context: 'lab', client }));
    const nodes = await tree.getChildren();
    const items = nodes.map((n) => tree.getTreeItem(n));
    expect(items.map((i) => i.label)).toEqual(['No response from context lab at https://127.0.0.1:6443.', 'Select Kubernetes Context...']);
    expect(items[0].tooltip).toContain('Details: connect ECONNREFUSED');
    expect(items[1].command).toEqual({ command: 'crewforge.selectContext', title: 'Select Kubernetes Context' });
  });

  it('shows the same items in Crew Sources when a source cannot read its deployments', async () => {
    const service = { deployments: () => [] } as unknown as SourceService;
    const client = { request: () => Promise.reject(refused), stream: () => Promise.reject(refused) } as unknown as KubeClient;
    const tree = new SourceTreeProvider(service, () => ({ source: '/k', context: 'lab', client }));
    const nodes = await tree.loadDeployments({ source: { root: '/w/demo' } } as unknown as SourceEntry);
    const items = nodes.map((n) => tree.getTreeItem(n));
    expect(items.map((i) => i.label)).toEqual(['No response from context lab at https://127.0.0.1:6443.', 'Select Kubernetes Context...']);
    expect(items[1].command?.command).toBe('crewforge.selectContext');
    expect((items[1].iconPath as { id: string }).id).toBe('server-environment');
  });

  it('offers Select Kubernetes Context on the crew and fitness dashboards when they cannot read the cluster', () => {
    const v = { name: 'demo', context: 'lab', agents: [], agentsFrom: 'none', models: [], conversations: { total: 0, turns: 0, errors: [] }, deploymentError: refused.message } as unknown as CrewVitals;
    expect(crewButtons(v).at(-1)?.action).toBe('selectContext');
    expect(crewButtons({ ...v, deploymentError: undefined }).map((b) => b.action)).not.toContain('selectContext');
    const fitness = { crew: 'demo', namespace: 'ns', runs: [], iterations: [], controls: { suspend: false, cancel: false } };
    expect(renderFitnessPage({ ...fitness, error: refused.message })).toContain('data-action="selectContext"');
    expect(renderFitnessPage(fitness)).not.toContain('selectContext');
  });

  it('says so in the chat without repeating itself', () => {
    expect(unreachable(refused)).toEqual({ state: 'unreachable', reason: refused.message });
    expect(unreachable(new Error('odd'))).toEqual({ state: 'unreachable', reason: 'Cannot reach the cluster: odd' });
  });

  it('offers Select Kubernetes Context on an error notification when another context may help', async () => {
    recorded.errorAnswers.push('Select Kubernetes Context');
    await showError(refused);
    expect(recorded.errors).toEqual([`CrewForge: ${refused.message}`]);
    expect(recorded.executed.map((e) => e.id)).toEqual(['crewforge.selectContext']);
    recorded.errorAnswers.push(undefined);
    await showError(new KubeError('who', 401));
    await showError(new Error('plain'));
    expect(recorded.executed).toHaveLength(1);
    expect(recorded.errors.at(-1)).toBe('CrewForge: plain');
  });
});
