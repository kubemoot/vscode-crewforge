import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KubeClient } from '../src/k8s/request';
import { CrewTreeProvider } from '../src/views/crewTree';
import { ReadingNotice, STILL_READING_MS } from '../src/views/readingNotice';
import { SourceTreeProvider } from '../src/views/sourceTree';
import type { SourceEntry, SourceService } from '../src/source/service';

afterEach(() => vi.useRealTimers());

const later = <T>(value: T) => {
  let release: () => void = () => undefined;
  const promise = new Promise<T>((r) => (release = () => r(value)));
  return { promise, release };
};

describe('the "Still reading" line of a tree', () => {
  it('appears only once a read takes a while, stays while any read runs, and clears with the last', async () => {
    vi.useFakeTimers();
    const shown: (string | undefined)[] = [];
    const notice = new ReadingNotice((t) => shown.push(t), () => 'lab');
    const quick = await notice.track(async () => 1);
    expect(quick).toBe(1);
    expect(shown).toEqual([undefined]);
    const a = later('a');
    const b = later('b');
    const first = notice.track(() => a.promise);
    const second = notice.track(() => b.promise);
    await vi.advanceTimersByTimeAsync(STILL_READING_MS);
    expect(shown.at(-1)).toBe('Still reading from lab...');
    a.release();
    await first;
    expect(shown.at(-1)).toBe('Still reading from lab...');
    b.release();
    await second;
    expect(shown.at(-1)).toBeUndefined();
  });

  it('clears after a read that fails, and names the cluster plainly when the context is unknown', async () => {
    vi.useFakeTimers();
    const shown: (string | undefined)[] = [];
    const notice = new ReadingNotice(
      (t) => shown.push(t),
      () => {
        throw new Error('no kubeconfig');
      },
      10,
    );
    const failing = notice.track(async () => {
      await new Promise((r) => setTimeout(r, 20));
      throw new Error('down');
    });
    const caught = failing.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(20);
    expect(await caught).toBe('down');
    expect(shown).toEqual(['Still reading from the cluster...', undefined]);
    const empty = new ReadingNotice((t) => shown.push(t), () => '', 0);
    const slow = later(0);
    const running = empty.track(() => slow.promise);
    await vi.advanceTimersByTimeAsync(0);
    expect(shown.at(-1)).toBe('Still reading from the cluster...');
    slow.release();
    await running;
  });

  it('is said by Deployed Crews and Crew Sources while the cluster is slow', async () => {
    vi.useFakeTimers();
    const hang = later('{"items":[]}');
    const client = { request: () => hang.promise, stream: () => Promise.resolve() } as unknown as KubeClient;
    const crews = new CrewTreeProvider(() => ({ source: '/k', context: 'slow-lab', client }));
    const crewLines: (string | undefined)[] = [];
    crews.onMessage = (t) => crewLines.push(t);
    const roots = crews.getChildren();
    const sources = new SourceTreeProvider({ deployments: () => [] } as unknown as SourceService, () => ({ source: '/k', context: 'slow-lab', client }));
    const sourceLines: (string | undefined)[] = [];
    sources.onMessage = (t) => sourceLines.push(t);
    const deployments = sources.loadDeployments({ source: { root: '/w/a' } } as SourceEntry);
    await vi.advanceTimersByTimeAsync(STILL_READING_MS);
    expect(crewLines).toEqual(['Still reading from slow-lab...']);
    expect(sourceLines).toEqual(['Still reading from slow-lab...']);
    hang.release();
    await roots;
    await deployments;
    expect(crewLines.at(-1)).toBeUndefined();
    expect(sourceLines.at(-1)).toBeUndefined();
  });
});
