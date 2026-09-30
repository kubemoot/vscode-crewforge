import { describe, expect, it } from 'vitest';
import { startPath, streamPath } from '../src/discussion/proxyPath';
import { CREWS_PATH, namespacedCrewsPath } from '../src/k8s/paths';

describe('proxy paths', () => {
  it('builds the start path through the service proxy', () => {
    expect(startPath('team-1', 'lab-ops')).toBe('/api/v1/namespaces/team-1/services/lab-ops-discussion:80/proxy/api/v1/discussions/lab-ops');
  });

  it('builds the stream path and encodes the conversation id', () => {
    expect(streamPath('team-1', 'lab-ops', '3f19-6418')).toBe('/api/v1/namespaces/team-1/services/lab-ops-discussion:80/proxy/api/v1/discussions/lab-ops/3f19-6418/stream');
    expect(streamPath('ns', 'c', 'a/b?c')).toContain('/a%2Fb%3Fc/stream');
  });

  it('adds where the stream starts: the queue time and the last event id', () => {
    const base = '/api/v1/namespaces/ns/services/c-discussion:80/proxy/api/v1/discussions/c/conv/stream';
    expect(streamPath('ns', 'c', 'conv', {})).toBe(base);
    expect(streamPath('ns', 'c', 'conv', { since: '2026-09-30T19:36:36.05Z' })).toBe(`${base}?since=2026-09-30T19%3A36%3A36.05Z`);
    expect(streamPath('ns', 'c', 'conv', { lastEventId: 'da5be99e:42' })).toBe(`${base}?lastEventId=da5be99e%3A42`);
    expect(streamPath('ns', 'c', 'conv', { since: 'T', lastEventId: 'A:1' })).toBe(`${base}?since=T&lastEventId=A%3A1`);
  });

  it('rejects names that are not Kubernetes names', () => {
    expect(() => startPath('Team 1', 'lab-ops')).toThrow(/namespace "Team 1"/);
    expect(() => startPath('team-1', '../etc')).toThrow(/crew/);
    expect(() => startPath('', 'x')).toThrow();
    expect(() => startPath('a'.repeat(64), 'x')).toThrow();
    expect(() => namespacedCrewsPath('-bad')).toThrow();
  });

  it('requires a conversation id to stream', () => {
    expect(() => streamPath('ns', 'crew', '')).toThrow(/conversationId/);
  });

  it('lists crews across and within namespaces', () => {
    expect(CREWS_PATH).toBe('/apis/kubemoot.ai/v1alpha1/crews');
    expect(namespacedCrewsPath('team-2')).toBe('/apis/kubemoot.ai/v1alpha1/namespaces/team-2/crews');
  });
});
