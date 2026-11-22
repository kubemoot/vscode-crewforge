import { describe, expect, it } from 'vitest';
import { renderCrewPage } from '../src/dashboard/crewPage';
import { renderOverview } from '../src/dashboard/overview';
import { canAnswer, capacityLine, notReconciled, retentionLines } from '../src/k8s/crewState';
import { parseCrewList, type CrewSummary } from '../src/k8s/crews';
import { crewTooltip } from '../src/views/treeModel';

const cap = (status: string, message?: string) => ({ type: 'CapacityAvailable', status, reason: 'NoModelAvailable', message });
const crew = (over: Partial<CrewSummary> = {}): CrewSummary => ({ name: 'demo', namespace: 'ns', ready: true, phase: 'Ready', ...over });

describe('canAnswer', () => {
  it('answers when reconciled, Ready, and CapacityAvailable is True', () => {
    expect(canAnswer(crew({ conditions: [cap('True')], generation: 2, observedGeneration: 2 }))).toEqual({ ok: true });
  });

  it('waits for an accelerator with the catalog message when CapacityAvailable is False', () => {
    expect(canAnswer(crew({ phase: 'WaitingForCapacity', conditions: [cap('False', 'no model fits')] }))).toEqual({ ok: false, kind: 'capacity', reason: 'waiting for an accelerator: no model fits' });
    expect(canAnswer(crew({ conditions: [cap('False')] }))).toEqual({ ok: false, kind: 'capacity', reason: 'waiting for an accelerator' });
  });

  it('waits for the coordinator when CapacityAvailable is Unknown', () => {
    expect(canAnswer(crew({ conditions: [cap('Unknown', 'no coordinator yet')] }))).toEqual({ ok: false, kind: 'capacity', reason: 'waiting for the coordinator to run: no coordinator yet' });
  });

  it('falls back to reconciled and phase Ready against a 0.95 operator with no condition', () => {
    expect(canAnswer(crew())).toEqual({ ok: true });
    expect(canAnswer(crew({ phase: 'Unknown' }))).toEqual({ ok: true });
    expect(canAnswer(crew({ phase: 'WaitingForCapacity', message: 'no models' }))).toMatchObject({ ok: false, reason: 'waiting for an accelerator: no models' });
    expect(canAnswer(crew({ phase: 'Pending' }))).toMatchObject({ ok: false, reason: 'waiting for the crew to become Ready (phase Pending)' });
  });

  it('is not answering on a stale generation, an Error phase, or a crew that is not ready', () => {
    expect(canAnswer(crew({ generation: 5, observedGeneration: 4 }))).toMatchObject({ ok: false, reason: 'waiting for the operator to reconcile the latest change' });
    expect(canAnswer(crew({ phase: 'Error', message: 'bad ref' }))).toMatchObject({ ok: false, reason: 'the crew failed to reconcile: bad ref' });
    expect(canAnswer(crew({ ready: false, phase: 'Pending' }))).toMatchObject({ ok: false, reason: 'waiting for the crew to reconcile' });
  });

  it('never calls a status without observedGeneration stale', () => {
    expect(notReconciled(crew({ generation: 7 }))).toBeUndefined();
    expect(notReconciled(crew({ generation: 7, observedGeneration: 0 }))).toBeUndefined();
  });
});

describe('reading and showing capacity and retention', () => {
  const body = JSON.stringify({
    items: [{
      metadata: { name: 'demo', namespace: 'ns', generation: 3 },
      status: {
        ready: true,
        phase: 'WaitingForCapacity',
        observedGeneration: 3,
        conditions: [cap('False', 'no model fits'), { type: 'RetentionValid', status: 'False', reason: 'TooFine', message: 'window shorter than schedule' }],
        retention: { lastRunTime: '2026-11-20T04:00:00Z', removed: { conversations: 2, memory: 1, other: 0 }, error: 'nats down' },
      },
    }],
  });
  const [parsed] = parseCrewList(body);

  it('copies the generations and the retention status into the crew', () => {
    expect(parsed).toMatchObject({ generation: 3, observedGeneration: 3, retention: { lastRunTime: '2026-11-20T04:00:00Z', error: 'nats down' } });
  });

  it('says capacity and retention in lines', () => {
    expect(capacityLine(parsed)).toBe('Capacity: waiting for an accelerator: no model fits');
    expect(capacityLine(crew({ conditions: [cap('True')] }))).toBe('Capacity: available');
    expect(capacityLine(crew())).toBeUndefined();
    expect(retentionLines(parsed)).toEqual([
      'Retention: TooFine: window shorter than schedule',
      'Last retention cleanup: 2026-11-20T04:00:00Z',
      'Removed: 2 conversations, 1 memory, 0 other',
      'Retention cleanup error: nats down',
    ]);
    expect(retentionLines(crew({ retention: {} }))).toEqual(['Last retention cleanup: not run yet']);
    expect(retentionLines(crew())).toEqual([]);
  });

  it('puts them in the tooltip', () => {
    const tip = crewTooltip(parsed);
    expect(tip).toContain('Capacity: waiting for an accelerator: no model fits');
    expect(tip).toContain('Removed: 2 conversations, 1 memory, 0 other');
  });

  it('badges a waiting crew as a warning in the overview and the crew page, and shows its status', () => {
    const row = { crew: parsed, channel: 'bundle', problems: 0, sourceOpen: false };
    expect(renderOverview({ connection: { lines: [] } as never, rows: [row] })).toMatch(/<span class="badge warn"[^>]*>WaitingForCapacity<\/span>/);
    const page = renderCrewPage({ title: 'demo', name: 'demo', context: 'lab', deployment: { namespace: 'ns', crew: parsed, channel: 'bundle', linked: true }, contents: [], agents: [], models: [], conversations: { total: 0, turns: 0, active: 0, errors: [] } } as never);
    expect(page).toMatch(/<span class="badge warn"[^>]*>WaitingForCapacity<\/span>/);
    expect(page).toContain('no, waiting for an accelerator: no model fits');
    expect(page).toContain('Generation observed');
  });
});
