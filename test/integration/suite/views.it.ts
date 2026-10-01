import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CrewForgeApi } from '../../../src/extension';
import type { SourceNode } from '../../../src/views/sourceTree';
import { closeAll, crewforge, liveCrew, pageShows, sourceNode, until } from './helpers';

const workspace = process.env.CREWFORGE_IT_WORKSPACE ?? '';

/** The text of the active editor, once one shows a document whose URI matches. */
async function editorShowing(scheme: string, words: string[]): Promise<string> {
  return until(
    `an editor of ${scheme} showing ${words.join(', ')}`,
    () => {
      const doc = vscode.window.activeTextEditor?.document;
      return doc?.uri.scheme === scheme && words.every((w) => doc.getText().includes(w)) ? doc.getText() : undefined;
    },
    () => vscode.window.activeTextEditor?.document.uri.toString(),
  );
}

describe('CrewForge views and commands in a real VS Code', () => {
  let api: CrewForgeApi;

  before(async () => {
    api = await crewforge();
    await vscode.commands.executeCommand('workbench.view.extension.kubemoot');
  });
  afterEach(closeAll);

  it('Deployed Crews lists the namespaces and crews, and a crew expands to what it is made of', async () => {
    const crew = await liveCrew(api, 'team-a', 'lab-ops');
    assert.equal(api.crews.getTreeItem(crew).label, 'lab-ops');
    await until('lab-ops to say it has no local source', () => /no local source$/.test(String(api.crews.getTreeItem(crew).description)) || undefined, () => api.crews.getTreeItem(crew).description);
    const sections = (await api.crews.getChildren(crew)).map((n) => String(api.crews.getTreeItem(n).label));
    assert.ok(sections.some((l) => l.startsWith('Agents')), sections.join(', '));
    const demo = api.crews.getTreeItem(await liveCrew(api, 'somewhere', 'demo'));
    assert.match(String(demo.description), /source open$/);
  });

  it('a live crew shows every group in order, a shared Model marked so, and where a tool comes from', async () => {
    const crew = await liveCrew(api, 'team-a', 'lab-ops');
    const sections = await api.crews.getChildren(crew);
    const labels = sections.map((n) => String(api.crews.getTreeItem(n).label));
    assert.deepEqual(labels, ['Agents', 'Prompts', 'Skills', 'Models', 'RAG Sources', 'MCP Servers', 'Tools', 'Policies', 'Notifications', 'Fitness', 'Deployment']);
    const models = await api.crews.getChildren(sections[3]);
    const shared = models.map((n) => api.crews.getTreeItem(n)).find((i) => i.label === 'big');
    assert.match(String(shared?.description), /^Model · shared · qwen3:32b/);
    assert.equal(shared?.contextValue, 'liveObject-shared');
    const tools = await api.crews.getChildren(sections[6]);
    const pods = tools.find((n) => api.crews.getTreeItem(n).label === 'pods_list');
    assert.ok(pods, 'pods_list is listed');
    assert.equal(api.crews.getTreeItem(pods).description, 'from kubernetes · k8s');
    await vscode.commands.executeCommand('crewforge.showToolDetails', pods);
    await editorShowing('crewforge-live', ['# Tool pods_list', 'List pods', '"namespace"']);
  });

  it('Add Skill writes a new object into a bundle source, opens it, and shows it in Crew Sources', async () => {
    const source = await sourceNode(api, 'demo/crew');
    const skills = (await api.sources.getChildren(source)).find((n) => n.kind === 'declSection' && n.section === 'skills');
    assert.ok(skills, 'the source has a Skills group');
    await vscode.commands.executeCommand('crewforge.addSkill', skills, { name: 'restart', description: 'Restart a crashing pod', order: '10' });
    await editorShowing('file', ['kind: Skill', 'name: restart', 'namespace: somewhere']);
    await until(
      'the new Skill in Crew Sources',
      async () => {
        const fresh = await sourceNode(api, 'demo/crew');
        const group = (await api.sources.getChildren(fresh)).find((n) => n.kind === 'declSection' && n.section === 'skills');
        const items = group ? await api.sources.getChildren(group) : [];
        return items.find((n) => n.kind === 'declared' && n.item.label === 'restart');
      },
      () => api.sources.known.map((e) => e.source.root),
    );
  });

  it('Crew Sources lists the source by its crew name, where it stands, and its deployment', async () => {
    const source = await sourceNode(api, 'demo/crew');
    const item = api.sources.getTreeItem(source);
    assert.equal(item.label, 'demo');
    await until('the source to say where it stands', () => /deployed in somewhere|not deployed/.test(String(api.sources.getTreeItem(source).description)) || undefined, () => api.sources.getTreeItem(source).description);
    const children = await api.sources.getChildren(source);
    assert.ok(children.some((n) => n.kind === 'deployment' && n.deployment.namespace === 'somewhere'), children.map((n) => n.kind).join(', '));
  });

  it('Show Live YAML opens the live Crew', async () => {
    await vscode.commands.executeCommand('crewforge.showLiveYaml', await liveCrew(api, 'team-a', 'lab-ops'));
    await editorShowing('crewforge-live', ['kind: Crew', 'lab-ops']);
  });

  it('Compare with Live opens the diff editor for a changed object', async () => {
    const source = await sourceNode(api, 'demo/crew');
    const deployment = (await api.sources.getChildren(source)).find((n): n is Extract<SourceNode, { kind: 'deployment' }> => n.kind === 'deployment');
    assert.ok(deployment, 'the demo source has a deployment');
    const resource = (await api.sources.getChildren(deployment)).find((n) => n.kind === 'resource' && n.drift.kind === 'Crew');
    assert.ok(resource && resource.kind === 'resource' && resource.drift.state === 'changed', JSON.stringify(resource && resource.kind === 'resource' && resource.drift.state));
    await vscode.commands.executeCommand('crewforge.showDrift', resource);
    await until('a diff editor', () => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff || undefined, () => vscode.window.tabGroups.activeTabGroup.activeTab?.label);
  });

  it('Lint runs on a bundle source without helm and reports no errors in its files', async () => {
    const source = await sourceNode(api, 'demo/crew');
    await vscode.commands.executeCommand('crewforge.lintCrew', source);
    const errors = vscode.languages.getDiagnostics().flatMap(([uri, list]) => (uri.fsPath.startsWith(source.entry.source.root) ? list.filter((d) => d.severity === vscode.DiagnosticSeverity.Error) : []));
    assert.deepEqual(errors.map((d) => d.message), []);
  });

  it('View in CrewForge selects the Crew of a manifest in Crew Sources and opens its dashboard', async () => {
    const file = vscode.Uri.file(path.join(workspace, 'demo', 'crew', '02-crew.yaml'));
    await vscode.commands.executeCommand('crewforge.viewInCrewForge', file);
    await until('the Crew selected in Crew Sources', () => api.sourcesView.selection.find((n) => n.kind === 'declared' && n.item.label === 'demo'), () => api.sourcesView.selection);
    const source = await sourceNode(api, 'demo/crew');
    await pageShows(api, `crew:${source.entry.source.root}`, ['demo']);
  });

  it('an unreachable context is said plainly in the tree and the Crews Overview, with Select Kubernetes Context', async () => {
    const settings = vscode.workspace.getConfiguration('crewforge');
    await settings.update('context', 'down', vscode.ConfigurationTarget.Global);
    try {
      const labels = await until(
        'the tree to name the unreachable context',
        async () => {
          const items = (await api.crews.getChildren()).map((n) => String(api.crews.getTreeItem(n).label));
          return items.some((l) => l.startsWith('No response from context down')) ? items : undefined;
        },
        () => api.crews.known,
      );
      assert.deepEqual(labels, ['No response from context down at http://127.0.0.1:1.', 'Select Kubernetes Context...']);
      await vscode.commands.executeCommand('crewforge.openCrewsOverview');
      await pageShows(api, 'overview', ['No response from context down at http://127.0.0.1:1. Is the cluster running?', 'Select Kubernetes Context', 'Details: connect ECONNREFUSED']);
    } finally {
      await settings.update('context', undefined, vscode.ConfigurationTarget.Global);
    }
  });
});
