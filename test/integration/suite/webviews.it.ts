import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { CrewForgeApi } from '../../../src/extension';
import { REQUESTS_ROUTE } from '../../fakeRoutes';
import { closeAll, crewforge, liveCrew, pageShows, sourceNode, until } from './helpers';

const API = process.env.CREWFORGE_IT_API ?? '';

describe('CrewForge webviews in a real VS Code', () => {
  let api: CrewForgeApi;

  before(async () => {
    api = await crewforge();
  });
  afterEach(closeAll);

  it('the Crews Overview shows the crews, not "Reading..."', async () => {
    await vscode.commands.executeCommand('crewforge.openCrewsOverview');
    const shown = await pageShows(api, 'overview', ['Crews Overview', 'lab-ops', 'Demo Crew', 'demo', 'kind-fake']);
    assert.ok(!shown.includes('Reading...'), shown);
    const page = api.pages().find((p) => p.key === 'overview');
    assert.equal(page?.title, 'Crews Overview');
    assert.deepEqual(page?.errors, []);
  });

  it('the dashboard of a live crew shows its agents, titled with its name', async () => {
    const node = await liveCrew(api, 'team-a', 'lab-ops');
    await vscode.commands.executeCommand('crewforge.openCrewDashboard', node);
    await pageShows(api, 'crew:team-a/lab-ops', ['lab-ops', 'Agents', 'coordinator', 'Ready']);
    assert.equal(api.pages().find((p) => p.key === 'crew:team-a/lab-ops')?.title, 'lab-ops');
  });

  it('the dashboard of a live crew counts every group, and a group opens in Deployed Crews', async () => {
    const node = await liveCrew(api, 'team-a', 'lab-ops');
    await vscode.commands.executeCommand('crewforge.openCrewDashboard', node);
    await pageShows(api, 'crew:team-a/lab-ops', ['Contents', 'RAG Sources', 'Notifications']);
    assert.ok(await api.press('crew:team-a/lab-ops', 'group', 'models'));
    await until('the Models group selected in Deployed Crews', () => api.crewsView.selection.find((n) => n.kind === 'section' && n.section === 'models'), () => api.crewsView.selection);
  });

  it('the dashboard of a crew source shows its source and its deployment', async () => {
    const node = await sourceNode(api, 'demo/crew');
    await vscode.commands.executeCommand('crewforge.openCrewDashboard', node);
    const key = `crew:${node.entry.source.root}`;
    await pageShows(api, key, ['demo', 'Source', 'somewhere']);
    assert.equal(api.pages().find((p) => p.key === key)?.title, 'Demo Crew');
  });

  it('the crew dashboard of a source shows its Source, Live, and Diff tabs', async () => {
    const node = await sourceNode(api, 'demo/crew');
    await vscode.commands.executeCommand('crewforge.openCrewDashboard', node);
    const key = `crew:${node.entry.source.root}`;
    await pageShows(api, key, ['Overview', 'Source', 'Live', 'Diff']);
    assert.ok(await api.press(key, 'tab', 'source'));
    await pageShows(api, key, ['Crew (1)', '02-crew.yaml']);
    await api.press(key, 'tab', 'live');
    await pageShows(api, key, ['Normalized:', 'demo']);
    await api.press(key, 'raw');
    await pageShows(api, key, ['Raw:']);
    await api.press(key, 'tab', 'diff');
    await pageShows(api, key, ['objects differ', 'Crew/demo', 'changed', 'A demo crew, changed in the cluster']);
  });

  it('the Live tab of a crew with no local source reads it by its label, and Source says how to open one', async () => {
    const node = await liveCrew(api, 'team-a', 'lab-ops');
    await vscode.commands.executeCommand('crewforge.openCrewDashboard', node);
    const key = 'crew:team-a/lab-ops';
    await pageShows(api, key, ['lab-ops']);
    await api.press(key, 'tab', 'live');
    await pageShows(api, key, ['Agent (2)', 'coordinator', 'k8s']);
    await api.press(key, 'tab', 'source');
    await pageShows(api, key, ['No local source is open', "Open the Crew's Source Folder..."]);
  });

  it('the fitness dashboard lists the runs, titled "<display name> fitness"', async () => {
    const node = await liveCrew(api, 'somewhere', 'demo');
    await vscode.commands.executeCommand('crewforge.openFitnessDashboard', node);
    await pageShows(api, 'fitness:somewhere/demo', ['Runs', 'demo-smoke']);
    assert.equal(api.pages().find((p) => p.key === 'fitness:somewhere/demo')?.title, 'Demo Crew fitness');
  });

  it('the fitness dashboard shows a finished suite from its status, reading only the Kubernetes API', async () => {
    const node = await liveCrew(api, 'team-a', 'lab-ops');
    await vscode.commands.executeCommand('crewforge.openFitnessDashboard', node);
    const key = 'fitness:team-a/lab-ops';
    await pageShows(api, key, ['Runs', 'lab-ops-baseline']);
    assert.ok(await api.press(key, 'select', 'lab-ops-baseline'));
    await pageShows(api, key, [
      'Run lab-ops-baseline',
      'Judge: done, 2 scenarios scored, mean 72',
      'Lists every pod with its phase.',
      'Names the warning events but misses their reasons.',
      'transcripts stay in',
      'Open in Kubemoot dashboard',
    ]);
    const requests = (await (await fetch(`${API}${REQUESTS_ROUTE}`)).json()) as string[];
    const dashboardReads = requests.filter((r) => /\/api\/v1\/services\?|\/proxy(\/dashboard)?\/api\/(kubemoot|nats)\//.test(r));
    assert.deepEqual(dashboardReads, [], 'CrewForge reads no Kubemoot dashboard API');
  });

  it('the chat opens and shows the crew', async () => {
    const node = await liveCrew(api, 'team-a', 'lab-ops');
    await vscode.commands.executeCommand('crewforge.askCrew', node);
    const chat = await until(
      'the chat to show lab-ops',
      () => api.chats().find((c) => c.ready && c.shown?.includes('lab-ops')),
      () => api.chats(),
    );
    assert.ok(chat.shown);
  });
});
