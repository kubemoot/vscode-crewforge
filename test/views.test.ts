import { describe, expect, it } from 'vitest';
import { cardText } from '../src/discussion/cardText';
import type { CrewSummary } from '../src/k8s/crews';
import { crewAbout, crewDescription, crewTooltip, groupByNamespace } from '../src/views/treeModel';
import { escapeHtml, formatAgo, isWebLink } from '../src/webview/render';

const crew = (name: string, namespace: string, extra: Partial<CrewSummary> = {}): CrewSummary => ({ name, namespace, ready: true, phase: 'Ready', ...extra });

describe('tree model', () => {
  it('groups crews by namespace in name order', () => {
    const groups = groupByNamespace([crew('b', 'team-2'), crew('z', 'team-1'), crew('a', 'team-1')]);
    expect(groups.map((g) => `${g.namespace}:${g.crews.map((c) => c.name).join(',')}`)).toEqual(['team-1:a,z', 'team-2:b']);
    expect(groupByNamespace([])).toEqual([]);
  });

  it('describes a crew in one line, a tooltip, and the chat empty state', () => {
    const c = crew('lab-ops', 'team-1', { agents: 2, coordinator: 'coord', message: 'Crew operational' });
    expect(crewDescription(c)).toBe('Ready, 2 agents');
    expect(crewDescription(crew('x', 'n', { agents: 1 }))).toBe('Ready, 1 agent');
    expect(crewDescription(crew('x', 'n'))).toBe('Ready');
    expect(crewTooltip(c)).toBe('team-1/lab-ops\nPhase: Ready (ready)\nCoordinator: coord\nCrew operational');
    expect(crewAbout(c)).toBe('2 agents, coordinator coord');
    expect(crewAbout(crew('x', 'n', { ready: false, phase: 'Pending' }))).toBe('phase Pending: it may not answer yet');
  });
});

describe('cardText', () => {
  const base = { agent: 'a', status: '', stoodAside: false };

  it('shows queued and analyzing with the GPU while an agent works', () => {
    expect(cardText({ ...base, status: 'triaging', gpu: 'rig0' })).toEqual({ text: 'queued on rig0...', working: true });
    expect(cardText({ ...base, status: 'evaluating' })).toEqual({ text: 'analyzing...', working: true });
  });

  it('shows stood aside, the finding, or the last status when done', () => {
    expect(cardText({ ...base, status: 'done', stoodAside: true, signal: 'stand_aside' }).text).toBe('stood aside');
    expect(cardText({ ...base, status: 'finding', signal: 'concern', summary: 'key B is wrong' }).text).toBe('concern: key B is wrong');
    expect(cardText({ ...base, status: 'done', signal: 'agree' }).text).toBe('agree');
    expect(cardText(base).text).toBe('waiting');
  });

  it('reads an artifact reference as what it is', () => {
    const summary = '[ARTIFACT key=lab-ops/t/node-watcher/agree-1 bytes=50032 - the FULL data is in the file ...';
    expect(cardText({ ...base, status: 'finding', signal: 'agree', summary }).text).toBe("agree: wrote a 50032-byte result to the crew's artifact store");
  });
});

describe('render helpers', () => {
  it('escapes every HTML-significant character', () => {
    expect(escapeHtml(`<img src=x onerror="a('b')">&`)).toBe('&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
  });

  it('renders only web and mail links as anchors', () => {
    expect(isWebLink('https://kubemoot.org')).toBe(true);
    expect(isWebLink('HTTP://x')).toBe(true);
    expect(isWebLink('mailto:a@b.c')).toBe(true);
    expect(isWebLink('javascript:alert(1)')).toBe(false);
    expect(isWebLink(' JavaScript:alert(1)')).toBe(false);
    expect(isWebLink('data:text/html,x')).toBe(false);
    expect(isWebLink('vscode:extension/x')).toBe(false);
    expect(isWebLink('/relative')).toBe(false);
  });

  it('formats elapsed time', () => {
    const now = Date.parse('2026-09-27T12:00:00Z');
    expect(formatAgo('2026-09-27T11:59:40Z', now)).toBe('Just now');
    expect(formatAgo('2026-09-27T11:55:00Z', now)).toBe('5m ago');
    expect(formatAgo('2026-09-27T09:00:00Z', now)).toBe('3h ago');
    expect(formatAgo('2026-09-25T12:00:00Z', now)).toBe('2d ago');
    expect(formatAgo('not a date', now)).toBe('');
  });
});
