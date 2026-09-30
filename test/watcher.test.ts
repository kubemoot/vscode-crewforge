import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { affectsSources, SourceWatcher } from '../src/source/watcher';
import { recorded, resetFake, Uri } from './vscodeFake';

describe('affectsSources', () => {
  const roots = ['/w/crews/demo'];

  it('counts YAML, folders, and anything in or above a source', () => {
    expect(affectsSources('/w/other/Chart.yaml', roots)).toBe(true);
    expect(affectsSources('/w/other/x.yml', roots)).toBe(true);
    expect(affectsSources('/w/new-folder', roots)).toBe(true);
    expect(affectsSources('/w/crews/demo/fitness/smoke.adl', roots)).toBe(true);
    expect(affectsSources('/w/crews/demo', roots)).toBe(true);
    expect(affectsSources('/w/crews.bak', roots)).toBe(false);
    expect(affectsSources('/w/notes.md', roots)).toBe(false);
  });

  it('ignores dependencies, git internals, and build output', () => {
    expect(affectsSources('/w/node_modules/x/Chart.yaml', roots)).toBe(false);
    expect(affectsSources('/w/.git/index', roots)).toBe(false);
    expect(affectsSources('/w/dist', roots)).toBe(false);
  });
});

describe('SourceWatcher', () => {
  beforeEach(() => {
    resetFake();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('watches YAML and folders, and reloads once per burst of events', async () => {
    const reload = vi.fn(async () => undefined);
    const watcher = new SourceWatcher(() => ['/w/demo'], reload, 100);
    const [yaml, anything] = recorded.watchers;
    expect(yaml.glob).toBe('**/*.{yaml,yml}');
    expect([anything.glob, anything.ignoreChange]).toEqual(['**/*', true]);
    anything.deleted.fire(Uri.file('/w/demo'));
    yaml.changed.fire(Uri.file('/w/demo/templates/crew.yaml'));
    yaml.created.fire(Uri.file('/w/b/Chart.yaml'));
    anything.created.fire(Uri.file('/w/readme.txt'));
    anything.created.fire(Uri.file('/w/not-mine.yaml'));
    await vi.advanceTimersByTimeAsync(99);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reload).toHaveBeenCalledTimes(1);
    recorded.folderListeners.forEach((l) => l({}));
    await vi.advanceTimersByTimeAsync(100);
    expect(reload).toHaveBeenCalledTimes(2);
    anything.created.fire(Uri.file('/w/readme.txt'));
    await vi.advanceTimersByTimeAsync(500);
    expect(reload).toHaveBeenCalledTimes(2);
    watcher.dispose();
    expect(recorded.watchers.every((w) => w.disposed)).toBe(true);
  });

  it('runs one more reload for events during a reload, and survives a failed one', async () => {
    let finish: () => void = () => undefined;
    const reload = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(() => new Promise<void>((r) => (finish = r)))
      .mockRejectedValueOnce(new Error('helm missing'))
      .mockResolvedValue(undefined);
    const watcher = new SourceWatcher(() => [], reload, 10);
    watcher.changed('/w/a.yaml');
    await vi.advanceTimersByTimeAsync(10);
    watcher.changed('/w/b.yaml');
    await vi.advanceTimersByTimeAsync(10);
    expect(reload).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(10);
    expect(reload).toHaveBeenCalledTimes(2);
    watcher.changed('/w/c.yaml');
    await vi.advanceTimersByTimeAsync(10);
    expect(reload).toHaveBeenCalledTimes(3);
    watcher.changed('/w/d.yaml');
    watcher.dispose();
    await vi.advanceTimersByTimeAsync(50);
    expect(reload).toHaveBeenCalledTimes(3);
  });

  it('reloads no more once disposed during a reload with changes pending', async () => {
    let finish: () => void = () => undefined;
    const reload = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const watcher = new SourceWatcher(() => [], reload, 10);
    watcher.changed('/w/a.yaml');
    await vi.advanceTimersByTimeAsync(10);
    watcher.changed('/w/b.yaml');
    await vi.advanceTimersByTimeAsync(10);
    watcher.dispose();
    finish();
    await vi.advanceTimersByTimeAsync(50);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('still counts YAML and folders when the known sources cannot be read', async () => {
    const reload = vi.fn(async () => undefined);
    const watcher = new SourceWatcher(() => {
      throw new Error('not loaded');
    }, reload, 10);
    watcher.changed('/w/crews/demo/fitness/smoke.adl');
    await vi.advanceTimersByTimeAsync(10);
    expect(reload).not.toHaveBeenCalled();
    watcher.changed('/w/crews/demo/Chart.yaml');
    await vi.advanceTimersByTimeAsync(10);
    expect(reload).toHaveBeenCalledTimes(1);
    watcher.dispose();
  });
});
