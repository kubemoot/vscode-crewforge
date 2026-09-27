import { describe, expect, it } from 'vitest';
import { listCrews, parseCrewList } from '../src/k8s/crews';
import { FakeTransport } from './fakes';

const list = JSON.stringify({
  items: [
    { metadata: { name: 'pedagogy', namespace: 'team-b' }, status: { ready: false, phase: 'Pending' } },
    { metadata: { name: 'lab-ops', namespace: 'team-1' }, status: { ready: true, phase: 'Ready', agentCount: 2, coordinatorRef: 'lab-ops-coordinator', message: 'Crew operational' } },
    { metadata: { name: 'bare', namespace: 'team-1' } },
    { metadata: { name: 'no-namespace' } },
  ],
});

describe('parseCrewList', () => {
  it('summarises crews sorted by namespace then name, skipping malformed items', () => {
    const crews = parseCrewList(list);
    expect(crews.map((c) => `${c.namespace}/${c.name}`)).toEqual(['team-1/bare', 'team-1/lab-ops', 'team-b/pedagogy']);
    expect(crews[1]).toEqual({ name: 'lab-ops', namespace: 'team-1', ready: true, phase: 'Ready', message: 'Crew operational', agents: 2, coordinator: 'lab-ops-coordinator' });
    expect(crews[0]).toMatchObject({ ready: false, phase: 'Unknown' });
  });

  it('handles an empty list and a list without items', () => {
    expect(parseCrewList('{"items":[]}')).toEqual([]);
    expect(parseCrewList('{}')).toEqual([]);
    const withHistory = parseCrewList(JSON.stringify({ items: [{ metadata: { name: 'a', namespace: 'n' }, status: { revisions: [{ revision: 'abc' }] } }] }));
    expect(withHistory[0].revisions).toEqual([{ revision: 'abc' }]);
  });

  it('throws on a body that is not JSON', () => {
    expect(() => parseCrewList('nope')).toThrow();
  });
});

describe('listCrews', () => {
  it('lists across the cluster without a filter', async () => {
    const t = new FakeTransport();
    t.responses.push(list);
    expect(await listCrews(t, [])).toHaveLength(3);
    expect(t.calls[0].path).toBe('/apis/kubemoot.ai/v1alpha1/crews');
  });

  it('asks each namespace in the filter', async () => {
    const t = new FakeTransport();
    t.responses.push('{"items":[{"metadata":{"name":"a","namespace":"n1"}}]}', '{"items":[{"metadata":{"name":"b","namespace":"n2"}}]}');
    const crews = await listCrews(t, ['n1', 'n2']);
    expect(crews.map((c) => c.name)).toEqual(['a', 'b']);
    expect(t.calls.map((c) => c.path)).toEqual(['/apis/kubemoot.ai/v1alpha1/namespaces/n1/crews', '/apis/kubemoot.ai/v1alpha1/namespaces/n2/crews']);
  });
});
