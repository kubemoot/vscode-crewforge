import { describe, expect, it } from 'vitest';
import { actionBar, moment, type ButtonSpec } from '../src/dashboard/html';
import { renderFitnessPage, type FitnessView } from '../src/dashboard/fitnessPage';
import { renderMemoryPage } from '../src/dashboard/memoryPage';
import type { FitnessRun } from '../src/fitness/fitness';

const spec = (action: string, over: Partial<ButtonSpec> = {}): ButtonSpec => ({ action, label: action, title: `${action} title`, ...over });

describe('moment', () => {
  it('shows an ISO time without seconds or fractions, and leaves anything else as it is', () => {
    expect(moment('2026-11-22T04:15:35.076Z')).toBe('2026-11-22 04:15Z');
    expect(moment('2026-11-20T10:00:00Z')).toBe('2026-11-20 10:00Z');
    expect(moment('last Tuesday')).toBe('last Tuesday');
    expect(moment('')).toBeUndefined();
    expect(moment(undefined)).toBeUndefined();
  });
});

describe('actionBar', () => {
  it('shows the primary buttons and puts every other action in one More menu', () => {
    const html = actionBar([spec('ask', { primary: true }), spec('redeploy'), spec('undeploy', { disabled: 'Not deployed.' })]);
    expect(html).toContain('<button type="button" class="btn primary" data-action="ask"');
    expect(html).toContain('<details class="menu"><summary class="btn" title="More actions">More</summary>');
    expect(html).toContain('<button type="button" class="menu-item" role="menuitem" data-action="redeploy" title="redeploy title">redeploy</button>');
    expect(html).toMatch(/class="menu-item" role="menuitem" data-action="undeploy" title="Not deployed\." disabled/);
    expect(html.match(/<details/g)).toHaveLength(1);
  });

  it('shows no menu when every action is primary, and nothing when there are none', () => {
    expect(actionBar([spec('a', { primary: true })])).not.toContain('<details');
    expect(actionBar([])).toBe('');
  });
});

describe('the memory page actions', () => {
  it('keeps Export and Refresh in view, and Select Kubernetes Context when the failure calls for it', () => {
    const html = renderMemoryPage({ crew: 'c', title: 'C', namespace: 'n', context: 'x', error: 'down', contextProblem: true });
    expect(html).not.toContain('<details');
    for (const action of ['exportZip', 'refresh', 'selectContext']) expect(html).toContain(`data-action="${action}"`);
  });
});

describe('the fitness run section', () => {
  const run: FitnessRun = { kind: 'CrewFitnessSuite', name: 's1', namespace: 'ns', crew: 'demo', phase: 'Completed', createdAt: 'T', startedAt: '2026-11-22T04:15:35.076Z', completedAt: '2026-11-22T04:25:35.076Z', passed: 3, failed: 1, errored: 0, assertions: [], runId: 'a1b2', artifact: { bucket: 'b', objectKey: 'k' } };
  const view: FitnessView = { crew: 'demo', title: 'demo', namespace: 'ns', runs: [run], selected: run, iterations: [], controls: { suspend: true, cancel: true } };

  it('leads with the result on one line, and keeps the run id and the storage path out of sight', () => {
    const html = renderFitnessPage(view);
    expect(html).toContain('<h2>s1</h2><p class="summary"><span class="badge good">Completed</span> 3 passed, 1 failed, 0 errored · 10 min 0 s</p>');
    expect(html).not.toContain('a1b2');
    expect(html).not.toContain('b/k');
    expect(html).toContain('<dt>Started</dt><dd>2026-11-22 04:15Z</dd>');
  });

  it('shows progress while running, and the bar only then', () => {
    const running = { ...run, phase: 'Running', completedAt: undefined, iterationsTotal: 4, iterationsCompleted: 1 };
    const html = renderFitnessPage({ ...view, runs: [running], selected: running });
    expect(html).toContain('1 of 4 iterations');
    expect(html).toContain('<progress max="4" value="1">');
    expect(renderFitnessPage({ ...view, runs: [{ ...run, iterationsTotal: 4, iterationsCompleted: 4 }], selected: { ...run, iterationsTotal: 4, iterationsCompleted: 4 } })).not.toContain('<progress');
  });
});
