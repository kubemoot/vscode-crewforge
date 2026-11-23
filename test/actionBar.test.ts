import { afterEach, describe, expect, it } from 'vitest';
import { actionBar, moment, type ButtonSpec } from '../src/dashboard/html';
import { formatTime } from '../src/webview/render';
import { renderFitnessPage, type FitnessView } from '../src/dashboard/fitnessPage';
import { renderMemoryPage } from '../src/dashboard/memoryPage';
import type { FitnessRun } from '../src/fitness/fitness';

const spec = (action: string, over: Partial<ButtonSpec> = {}): ButtonSpec => ({ action, label: action, title: `${action} title`, ...over });

describe('times', () => {
  const NOW = Date.parse('2026-11-22T20:00:00Z');
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it('writes a time in the time zone and locale of the person, with the exact value in the tooltip', () => {
    process.env.TZ = 'America/New_York';
    expect(formatTime('2026-11-20T15:00:00Z', NOW, 'en-US')).toBe('Nov 20, 10:00 AM');
    expect(formatTime('2026-11-22T15:00:00Z', NOW, 'en-US')).toBe('10:00 AM');
    expect(formatTime('2025-03-02T15:00:00Z', NOW, 'en-US')).toBe('Mar 2, 2025, 10:00 AM');
    expect(moment('2026-11-20T15:00:00.123Z', NOW, 'en-US')?.html).toBe('<time datetime="2026-11-20T15:00:00.123Z" title="2026-11-20T15:00:00.123Z">Nov 20, 10:00 AM</time>');
  });

  it('follows the zone: the same instant reads differently in Tokyo, and today follows it', () => {
    process.env.TZ = 'Asia/Tokyo';
    expect(formatTime('2026-11-20T15:00:00Z', NOW, 'en-US')).toBe('Nov 21, 12:00 AM');
    expect(formatTime('2026-11-22T15:00:00Z', NOW, 'en-US')).toBe('12:00 AM');
  });

  it('follows the locale', () => {
    process.env.TZ = 'America/New_York';
    expect(formatTime('2026-11-20T15:00:00Z', NOW, 'de-DE')).toContain('10:00');
    expect(formatTime('2026-11-20T15:00:00Z', NOW, 'de-DE')).not.toContain('AM');
  });

  it('shows text that is not a time as it is, escaped, and nothing for nothing', () => {
    expect(moment('last <b>Tuesday</b>')?.html).toBe('last &lt;b&gt;Tuesday&lt;/b&gt;');
    expect(formatTime('not a date')).toBe('');
    expect(moment('')).toBeUndefined();
    expect(moment(undefined)).toBeUndefined();
  });
});

describe('actionBar', () => {
  it('shows the primary buttons and puts every other action in one More menu', () => {
    const html = actionBar([spec('ask', { primary: true }), spec('redeploy'), spec('undeploy', { disabled: 'Not deployed.' })]);
    expect(html).toContain('<button type="button" class="btn primary" data-action="ask"');
    expect(html).toContain('<details class="menu"><summary class="btn" title="Show the other actions for this page">More</summary>');
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
    expect(html).toMatch(/<h2[^>]*>s1<\/h2><p class="summary"><span class="badge warn"[^>]*>Completed<\/span> 3 gates passed, 1 failed, 0 errored · 10 min 0 s<\/p>/);
    expect(html).not.toContain('a1b2');
    expect(html).not.toContain('b/k');
    expect(html).toMatch(/<dt[^>]*>Started<\/dt><dd><time datetime="2026-11-22T04:15:35.076Z"/);
  });

  it('shows progress while running, and the bar only then', () => {
    const running = { ...run, phase: 'Running', completedAt: undefined, iterationsTotal: 4, iterationsCompleted: 1 };
    const html = renderFitnessPage({ ...view, runs: [running], selected: running });
    expect(html).toContain('1 of 4 iterations');
    expect(html).toContain('<progress max="4" value="1"');
    expect(renderFitnessPage({ ...view, runs: [{ ...run, iterationsTotal: 4, iterationsCompleted: 4 }], selected: { ...run, iterationsTotal: 4, iterationsCompleted: 4 } })).not.toContain('<progress');
  });
});
