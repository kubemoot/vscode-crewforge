import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { badge, banner, between, button, buttons, duration, escape, facts, note, section, table } from '../src/dashboard/html';
import { PagePanel, type PageModel } from '../src/dashboard/pagePanel';
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
