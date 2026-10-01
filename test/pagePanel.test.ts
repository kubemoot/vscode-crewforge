import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { badge, banner, between, button, buttons, duration, escape, facts, note, section, table } from '../src/dashboard/html';
import { PAGE_WAIT, PagePanel, type PageModel } from '../src/dashboard/pagePanel';
import { recorded, resetFake, Uri } from './vscodeFake';

describe('html helpers', () => {
  it('escapes every value and drops empty ones', () => {
    expect(escape('<b a="1">&\'</b>')).toBe('&lt;b a=&quot;1&quot;&gt;&amp;&#39;&lt;/b&gt;');
    expect(escape(undefined)).toBe('');
    expect(escape(null)).toBe('');
    expect(escape(3)).toBe('3');
    expect(facts([['A', 'x<y'], ['B', undefined], ['C', ''], ['D', 0]])).toBe('<dl class="facts"><dt>A</dt><dd>x&lt;y</dd><dt>D</dt><dd>0</dd></dl>');
    expect(facts([['A', undefined]])).toBe('');
  });

  it('builds buttons with an action, an argument, and a reason when disabled', () => {
    expect(button({ action: 'go', label: 'Go <now>', title: 'Do it', arg: 'a"b', primary: true })).toBe('<button type="button" class="btn primary" data-action="go" data-arg="a&quot;b" title="Do it">Go &lt;now&gt;</button>');
    expect(button({ action: 'go', label: 'Go', title: 'Do it', disabled: 'Not now' })).toBe('<button type="button" class="btn" data-action="go" title="Not now" disabled>Go</button>');
    expect(buttons([])).toBe('');
    expect(buttons([{ action: 'a', label: 'A', title: 't' }])).toMatch(/^<div class="actions">/);
  });

  it('builds sections, tables, badges, notes, and banners', () => {
    expect(section('T<', '<p>x</p>')).toBe('<section><h2>T&lt;</h2><p>x</p></section>');
    expect(table(['H'], [], 'Nothing <here>')).toBe('<p class="muted">Nothing &lt;here&gt;</p>');
    expect(table(['H<'], [['<i>x</i>']])).toBe('<table><thead><tr><th>H&lt;</th></tr></thead><tbody><tr><td><i>x</i></td></tr></tbody></table>');
    expect(badge('ok', 'good')).toBe('<span class="badge good">ok</span>');
    expect(badge('x')).toBe('<span class="badge plain">x</span>');
    expect(note('a&b')).toBe('<p class="muted">a&amp;b</p>');
    expect(banner('!')).toBe('<p class="banner">!</p>');
  });

  it('says durations in words and measures between times', () => {
    expect(duration(42_400)).toBe('42 s');
    expect(duration(185_000)).toBe('3 min 5 s');
    expect(duration(undefined)).toBeUndefined();
    expect(duration(-1)).toBeUndefined();
    expect(duration(Number.NaN)).toBeUndefined();
    expect(between('2026-09-30T10:00:00Z', '2026-09-30T10:01:00Z')).toBe('1 min 0 s');
    expect(between('2026-09-30T10:00:00Z', undefined, Date.parse('2026-09-30T10:00:05Z'))).toBe('5 s');
    expect(between(undefined, 'x')).toBeUndefined();
    expect(between('bad')).toBeUndefined();
  });
});

describe('PagePanel', () => {
  let renders: number;
  let refreshMs: number | undefined;
  let body: string | Error;
  const acted: (string | undefined)[] = [];

  beforeEach(() => {
    resetFake();
    renders = 0;
    refreshMs = undefined;
    body = '<p>hello</p>';
    acted.length = 0;
  });
  afterEach(() => {
    for (const p of recorded.panels) p.dispose();
    vi.useRealTimers();
  });

  const model = (): PageModel => ({
    title: () => `Page ${renders}`,
    render: async () => {
      renders++;
      if (body instanceof Error) throw body;
      return body;
    },
    actions: {
      go: async (arg) => void acted.push(arg),
      fail: async () => {
        throw new Error('nope');
      },
    },
    refreshMs: () => refreshMs,
  });

  const posted = () => recorded.panels[0].webview.posted as { type: string; html: string }[];

  it('opens one page per key behind a strict content security policy, and renders when the page is ready', async () => {
    PagePanel.show(Uri.file('/ext') as never, 'k', model());
    const [panel] = recorded.panels;
    expect(panel.viewType).toBe('crewforge.page');
    const html = panel.webview.html;
    const nonce = /nonce-([^']+)'/.exec(html)?.[1];
    expect(html).toContain("default-src 'none'");
    expect(html).toMatch(new RegExp(`<script nonce="${nonce!.replace(/[+/=]/g, '\\$&')}" src="[^"]*/ext/dist/page.js"></script>`));
    expect(html).toContain('/ext/media/page.css');
    await panel.webview.receive({ type: 'ready' });
    expect(posted().at(-1)).toEqual({ type: 'render', html: '<p>hello</p>' });
    expect(panel.title).toBe('Page 1');
    PagePanel.show(Uri.file('/ext') as never, 'k', model());
    expect(recorded.panels).toHaveLength(1);
    expect(panel.revealed).toBe(1);
    expect(PagePanel.find('k')).toBeDefined();
    panel.dispose();
    expect(PagePanel.find('k')).toBeUndefined();
  });

  it('runs only the actions the model names, with a text argument, and renders again', async () => {
    PagePanel.show(Uri.file('/ext') as never, 'k', model());
    const { webview } = recorded.panels[0];
    await webview.receive({ type: 'action', action: 'go', arg: 'x' });
    await webview.receive({ type: 'action', action: 'go', arg: 42 });
    await webview.receive({ type: 'action', action: 'toString' });
    await webview.receive({ type: 'action', action: 'constructor' });
    await webview.receive({ type: 'action', action: 7 });
    await webview.receive({ type: 'other' });
    await webview.receive(undefined);
    expect(acted).toEqual(['x', undefined]);
    expect(renders).toBe(2);
    await webview.receive({ type: 'action', action: 'fail' });
    expect(recorded.errors).toEqual(['CrewForge: nope']);
    expect(renders).toBe(3);
  });

  it('shows a failed render as an escaped error', async () => {
    body = new Error('<boom>');
    PagePanel.show(Uri.file('/ext') as never, 'k', model());
    await recorded.panels[0].webview.receive({ type: 'ready' });
    expect(posted().at(-1)?.html).toBe('<p class="error">CrewForge could not read this page: &lt;boom&gt;</p>');
  });

  it('reads again on the model schedule while visible, and when it becomes visible', async () => {
    vi.useFakeTimers();
    refreshMs = 1000;
    PagePanel.show(Uri.file('/ext') as never, 'k', model());
    const panel = recorded.panels[0];
    await panel.webview.receive({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(renders).toBe(2);
    panel.visible = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(renders).toBe(2);
    panel.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(renders).toBe(3);
    refreshMs = undefined;
    await vi.advanceTimersByTimeAsync(1000);
    expect(renders).toBe(4);
    await vi.advanceTimersByTimeAsync(5000);
    expect(renders).toBe(4);
    panel.dispose();
    await PagePanel.show(Uri.file('/ext') as never, 'other', model()).refresh();
    expect(renders).toBe(5);
  });

  it('keeps what each page shows and the errors its script reports, and logs them', async () => {
    const logged: string[] = [];
    PagePanel.host = { log: (line) => void logged.push(line), readingFrom: () => 'kind-dev' };
    PagePanel.show(Uri.file('/ext') as never, 'k', model());
    const { webview } = recorded.panels[0];
    expect(PagePanel.states()).toEqual([{ key: 'k', title: 'Page 0', ready: false, errors: [] }]);
    await webview.receive({ type: 'ready' });
    await webview.receive({ type: 'shown', text: 'hello' });
    await webview.receive({ type: 'error', message: 'boom' });
    expect(PagePanel.states()).toEqual([{ key: 'k', title: 'Page 1', ready: true, shown: 'hello', errors: ['boom'] }]);
    await webview.receive({ type: 'shown', text: 3 });
    expect(PagePanel.states()[0].shown).toBe('');
    await webview.receive({ type: 'error', message: { not: 'text' } });
    expect(logged).toEqual(['The page "Page 1" reported: boom', 'The page "Page 1" reported: ']);
    PagePanel.host = { log: () => undefined, readingFrom: () => 'the cluster' };
  });

  it('says so on the page when its script never starts, in the page itself and in the log', async () => {
    vi.useFakeTimers();
    const logged: string[] = [];
    PagePanel.host = { log: (line) => void logged.push(line), readingFrom: () => 'kind-dev' };
    PagePanel.show(Uri.file('/ext') as never, 'k', model());
    const { webview } = recorded.panels[0];
    expect(webview.html).toContain('id="stuck"');
    expect(webview.html).toMatch(/<style nonce="[^"]+">#stuck\{visibility:hidden;animation:crewforge-stuck 0s 15s forwards\}/);
    await vi.advanceTimersByTimeAsync(PAGE_WAIT.scriptStartMs);
    expect(logged).toEqual(['The page script of "Page 0" did not start within 15 s.']);
    PagePanel.show(Uri.file('/ext') as never, 'started', model());
    await recorded.panels[1].webview.receive({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(PAGE_WAIT.scriptStartMs);
    expect(logged).toHaveLength(1);
    PagePanel.host = { log: () => undefined, readingFrom: () => 'the cluster' };
  });

  it('says it is still reading, from where, and gives up on a read that takes too long', async () => {
    vi.useFakeTimers();
    PagePanel.host = { log: () => undefined, readingFrom: () => 'kind-dev' };
    const slow: PageModel = { ...model(), render: () => new Promise(() => undefined) };
    const page = PagePanel.show(Uri.file('/ext') as never, 'k', slow);
    const refreshing = page.refresh();
    await vi.advanceTimersByTimeAsync(PAGE_WAIT.stillReadingMs);
    expect(posted().at(-1)).toEqual({ type: 'status', text: 'Still reading from kind-dev...' });
    await vi.advanceTimersByTimeAsync(PAGE_WAIT.readLimitMs);
    await refreshing;
    expect(posted().slice(-2)).toEqual([
      { type: 'status', text: '' },
      { type: 'render', html: '<p class="error">No answer from kind-dev in 45 s. Is the cluster running? Refresh reads again.</p>' },
    ]);
  });

  it('names the cluster plainly when the page cannot say where it reads from', async () => {
    vi.useFakeTimers();
    PagePanel.host = {
      log: () => undefined,
      readingFrom: () => {
        throw new Error('no kubeconfig');
      },
    };
    const broken: PageModel = { ...model(), render: () => new Promise(() => undefined) };
    void PagePanel.show(Uri.file('/ext') as never, 'k', broken).refresh();
    await vi.advanceTimersByTimeAsync(PAGE_WAIT.stillReadingMs);
    expect(posted().at(-1)).toEqual({ type: 'status', text: 'Still reading from the cluster...' });
    PagePanel.host = { log: () => undefined, readingFrom: () => '' };
    void PagePanel.show(Uri.file('/ext') as never, 'k2', broken).refresh();
    await vi.advanceTimersByTimeAsync(PAGE_WAIT.stillReadingMs);
    expect(recorded.panels[1].webview.posted.at(-1)).toEqual({ type: 'status', text: 'Still reading from the cluster...' });
  });

  it('reads once more after a read under way, instead of reading twice at once', async () => {
    let finish: (html: string) => void = () => undefined;
    const slow: PageModel = { ...model(), render: () => new Promise((r) => { renders++; finish = r; }) };
    const page = PagePanel.show(Uri.file('/ext') as never, 'k', slow);
    const first = page.refresh();
    const second = page.refresh();
    void page.refresh();
    expect(renders).toBe(1);
    finish('<p>one</p>');
    await first;
    await second;
    expect(renders).toBe(2);
    finish('<p>two</p>');
    await vi.waitFor(() => expect(posted().at(-1)).toEqual({ type: 'render', html: '<p>two</p>' }));
  });

  it('runs a button as if pressed on the page, for the integration tests', async () => {
    PagePanel.show(Uri.file('/ext') as never, 'k', model());
    expect(await PagePanel.press('k', 'go', 'y')).toBe(true);
    expect(acted).toEqual(['y']);
    expect(await PagePanel.press('nope', 'go')).toBe(false);
  });

  it('stops reading once closed, even with a render under way', async () => {
    let finish: (html: string) => void = () => undefined;
    const slow: PageModel = { ...model(), render: () => new Promise((r) => (finish = r)), refreshMs: () => 10 };
    const page = PagePanel.show(Uri.file('/ext') as never, 'k', slow);
    const refreshing = page.refresh();
    recorded.panels[0].dispose();
    finish('<p>late</p>');
    await refreshing;
    await page.refresh();
    expect(recorded.panels[0].webview.posted).toEqual([]);
  });
});
