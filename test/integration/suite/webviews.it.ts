import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { CrewForgeApi } from '../../../src/extension';
import { closeAll, crewforge, liveCrew, pageShows, sourceNode, until } from './helpers';

describe('CrewForge webviews in a real VS Code', () => {
  let api: CrewForgeApi;

  before(async () => {
    api = await crewforge();
  });
  afterEach(closeAll);

  it('the Crews Overview shows the crews, not "Reading..."', async () => {
    await vscode.commands.executeCommand('crewforge.openCrewsOverview');
    const shown = await pageShows(api, 'overview', ['Crews Overview', 'lab-ops', 'demo', 'kind-fake']);
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

  it('the dashboard of a crew source shows its source and its deployment', async () => {
    const node = await sourceNode(api, 'demo/crew');
    await vscode.commands.executeCommand('crewforge.openCrewDashboard', node);
    const key = `crew:${node.entry.source.root}`;
    await pageShows(api, key, ['demo', 'Source', 'somewhere']);
    assert.equal(api.pages().find((p) => p.key === key)?.title, 'demo');
  });

  it('the fitness dashboard lists the runs, titled "<name> fitness"', async () => {
    const node = await liveCrew(api, 'somewhere', 'demo');
    await vscode.commands.executeCommand('crewforge.openFitnessDashboard', node);
    await pageShows(api, 'fitness:somewhere/demo', ['Runs', 'demo-smoke']);
    assert.equal(api.pages().find((p) => p.key === 'fitness:somewhere/demo')?.title, 'demo fitness');
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
