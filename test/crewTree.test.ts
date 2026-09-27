import * as path from 'node:path';
import * as os from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CrewTreeProvider, type CrewNode } from '../src/views/crewTree';
import { startFakeApi, type FakeApi } from './fakeApiServer';
import { recorded, resetFake, ThemeIcon, TreeItemCollapsibleState } from './vscodeFake';

let api: FakeApi;
beforeAll(async () => (api = await startFakeApi()));
afterAll(() => api.close());
beforeEach(() => {
  resetFake();
  recorded.settings.set('crewforge.kubeconfig', api.kubeconfig);
});

describe('CrewTreeProvider', () => {
  it('lists namespaces, then the crews in each, with their readiness', async () => {
    const tree = new CrewTreeProvider();
    const roots = await tree.getChildren();
    expect(roots.map((n) => n.kind === 'namespace' && n.group.namespace)).toEqual(['team-a', 'team-b']);
    const ns = tree.getTreeItem(roots[0]);
    expect(ns.label).toBe('team-a');
    expect(ns.collapsibleState).toBe(TreeItemCollapsibleState.Expanded);

    const crews = await tree.getChildren(roots[0]);
    const item = tree.getTreeItem(crews[0]);
    expect(item.label).toBe('lab-ops');
    expect(item.description).toBe('Ready, 2 agents');
    expect(item.contextValue).toBe('crew');
    expect((item.iconPath as ThemeIcon).id).toBe('pass-filled');
    expect(item.command?.command).toBe('crewforge.askCrew');

    const notReady = tree.getTreeItem((await tree.getChildren(roots[1]))[0]);
    expect((notReady.iconPath as ThemeIcon).id).toBe('circle-large-outline');
    expect(tree.known.map((c) => c.name)).toEqual(['lab-ops', 'quiz']);
    expect(tree.connection?.context).toBe('fake');
  });

  it('shows why when the cluster cannot be read', async () => {
    recorded.settings.set('crewforge.kubeconfig', path.join(os.tmpdir(), 'no-such-kubeconfig'));
    const tree = new CrewTreeProvider();
    const [node] = await tree.getChildren();
    expect(node.kind).toBe('message');
    const item = tree.getTreeItem(node);
    expect((item.iconPath as ThemeIcon).id).toBe('warning');
    expect(String(item.tooltip)).toMatch(/no-such-kubeconfig|ENOENT/);
    expect(tree.known).toEqual([]);
  });

  it('has no children below a crew, and refresh notifies the view', async () => {
    const tree = new CrewTreeProvider();
    const crewNode: CrewNode = { kind: 'crew', crew: { name: 'x', namespace: 'y', ready: true, phase: 'Ready' } };
    expect(await tree.getChildren(crewNode)).toEqual([]);
    let fired = 0;
    tree.onDidChangeTreeData(() => fired++);
    tree.refresh();
    expect(fired).toBe(1);
  });

  it('asks only the namespaces in the filter setting', async () => {
    recorded.settings.set('crewforge.namespaces', ['team-a', ' ']);
    const tree = new CrewTreeProvider();
    const [node] = await tree.getChildren();
    // the fake API only answers the cluster-wide list, so a per-namespace ask fails visibly
    expect(node.kind).toBe('message');
  });
});
