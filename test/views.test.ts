import { describe, expect, it } from 'vitest';
import { agentProblems, cardText } from '../src/discussion/cardText';
import type { CrewSummary } from '../src/k8s/crews';
import { agentCount, crewAbout, crewDescription, crewTooltip, groupByNamespace } from '../src/views/treeModel';
import { formatDuration } from '../src/text';
import { escapeHtml, formatAgo, htmlAttribute, isWebLink, META_SEPARATOR, metaLine } from '../src/webview/render';

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
    expect(crewAbout(crew('x', 'n', { agents: 1 }))).toBe('1 agent');
  });

  it('counts agents, singular only for one', () => {
    expect(agentCount(0)).toBe('0 agents');
    expect(agentCount(1)).toBe('1 agent');
    expect(agentCount(12)).toBe('12 agents');
  });
});

describe('cardText', () => {
  const base = { agent: 'a', status: '', stoodAside: false };

  it('shows every working status the gateway sends, with the GPU when known', () => {
    expect(cardText({ ...base, status: 'waking' })).toEqual({ text: 'starting up', working: false, problem: false });
    expect(cardText({ ...base, status: 'ready' })).toEqual({ text: 'ready', working: false, problem: false });
    expect(cardText({ ...base, status: 'triaging', gpu: 'rig0' })).toEqual({ text: 'queued on rig0...', working: true, problem: false });
    expect(cardText({ ...base, status: 'evaluating' })).toEqual({ text: 'analyzing...', working: true, problem: false });
  });

  it('says each verdict in plain words, marking a failure as a problem', () => {
    expect(cardText({ ...base, status: 'finding', signal: 'agree', summary: 'rig0 has one' })).toEqual({ text: 'agrees: rig0 has one', working: false, problem: false });
    expect(cardText({ ...base, status: 'finding', signal: 'concern', summary: 'key B is wrong' }).text).toBe('has a concern: key B is wrong');
    expect(cardText({ ...base, status: 'finding', signal: 'block', summary: 'unsafe' }).text).toBe('objects: unsafe');
    expect(cardText({ ...base, status: 'finding', signal: 'failure', summary: 'the MCP server did not answer' })).toEqual({ text: 'failed: the MCP server did not answer', working: false, problem: true });
    expect(cardText({ ...base, status: 'finding', signal: 'failure' })).toEqual({ text: 'failed', working: false, problem: true });
    expect(cardText({ ...base, status: 'done', signal: 'agree' }).text).toBe('agrees');
    expect(cardText({ ...base, status: 'finding', signal: 'novel', summary: 'x' }).text).toBe('novel: x');
    expect(cardText({ ...base, status: 'finding', summary: 'no verdict' }).text).toBe('no verdict');
  });

  it('shows stood aside, marking it a problem only when the agent could not run', () => {
    expect(cardText({ ...base, status: 'done', stoodAside: true, signal: 'stand_aside' })).toEqual({ text: 'stood aside', working: false, problem: false });
    expect(cardText({ ...base, status: 'done', stoodAside: true, reason: 'gpu-busy' }).problem).toBe(true);
    expect(cardText({ ...base, status: 'done', stoodAside: true, reason: 'not-relevant' })).toEqual({ text: 'stood aside', working: false, problem: false });
    expect(cardText(base).text).toBe('waiting');
  });

  it('finds nothing on the prototype for a status, verdict or reason named like one of its keys', () => {
    expect(cardText({ ...base, status: 'constructor' })).toEqual({ text: 'constructor', working: false, problem: false });
    expect(cardText({ ...base, status: 'done', signal: 'toString' }).text).toBe('toString');
    expect(cardText({ ...base, status: 'done', stoodAside: true, reason: 'constructor' })).toEqual({ text: 'stood aside', working: false, problem: false });
  });

  it('reads an artifact reference as what it is', () => {
    const summary = '[ARTIFACT key=lab-ops/t/node-watcher/agree-1 bytes=50032 - the FULL data is in the file ...';
    expect(cardText({ ...base, status: 'finding', signal: 'agree', summary }).text).toBe("agrees: wrote a 50032-byte result to the crew's artifact store");
  });
});

describe('agentProblems', () => {
  it('lists agents that failed, could not run, or were still working, and nothing else', () => {
    const cards = [
      { agent: 'ok', status: 'finding', signal: 'agree', summary: 'fine', stoodAside: false },
      { agent: 'quiet', status: 'done', signal: 'stand_aside', stoodAside: true },
      { agent: 'broken', status: 'finding', signal: 'failure', summary: 'tool error', stoodAside: false },
      { agent: 'crowded', status: 'done', stoodAside: true, reason: 'gpu-busy' },
      { agent: 'slow', status: 'evaluating', gpu: 'rig0', stoodAside: false },
      { agent: 'parked', status: 'waiting', stoodAside: false },
      { agent: 'idle', status: 'ready', stoodAside: false },
      { agent: 'booting', status: 'waking', stoodAside: false },
    ];
    expect(agentProblems(cards)).toEqual([
      'broken failed: tool error',
      'crowded stood aside: every GPU was busy, so it could not run',
      'slow did not finish before the turn ended',
      'parked did not finish before the turn ended',
    ]);
    expect(agentProblems([])).toEqual([]);
  });
});

describe('render helpers', () => {
  it('escapes every HTML-significant character', () => {
    expect(escapeHtml(`<img src=x onerror="a('b')">&`)).toBe('&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
    expect(escapeHtml('a && b && c')).toBe('a &amp;&amp; b &amp;&amp; c');
  });

  it('writes an attribute with its value escaped, leading space included', () => {
    expect(htmlAttribute('title', 'plain')).toBe(' title="plain"');
    expect(htmlAttribute('title', '" onmouseover="x')).toBe(' title="&quot; onmouseover=&quot;x"');
    expect(htmlAttribute('href', '')).toBe(' href=""');
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

  it('formats how long a turn took, and nothing for a missing or invalid duration', () => {
    expect(formatDuration(42_000)).toBe('42 s');
    expect(formatDuration(41_600)).toBe('42 s');
    expect(formatDuration(185_000)).toBe('3 min 05 s');
    expect(formatDuration(60_000)).toBe('1 min 00 s');
    expect(formatDuration(300)).toBe('under 1 s');
    expect(formatDuration(0)).toBe('under 1 s');
    for (const bad of [undefined, null, -5, Number.NaN, Number.POSITIVE_INFINITY, '42000', {}]) expect(formatDuration(bad)).toBe('');
  });

  it('writes the meta line as time then duration, leaving out what is unknown', () => {
    const at = '2026-09-27T15:36:00Z';
    const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    expect(metaLine(at, 42_000)).toBe(`${time}${META_SEPARATOR}42 s`);
    expect(META_SEPARATOR).toBe(' \u00b7 ');
    expect(metaLine(at)).toBe(time);
    expect(metaLine('not a date', 42_000)).toBe('42 s');
    expect(metaLine('not a date')).toBe('');
  });
});
