// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageMessage } from '../src/webview/pageProtocol';

let sent: PageMessage[];
let kept: unknown;
let scrolledTo: number[];
let writes: number;
/** The listeners the page script put on the window and document, removed after each test so one build does not hear another's messages. */
const added: Array<[EventTarget, string, EventListenerOrEventListenerObject]> = [];

function track(target: EventTarget): void {
  const add = target.addEventListener.bind(target);
  target.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
    added.push([target, type, listener]);
    add(type, listener, options as boolean);
  }) as typeof target.addEventListener;
}

/** Builds the page as VS Code does when a hidden tab comes back: a new script, with the state the old one kept. */
async function build(state: unknown): Promise<void> {
  removeListeners();
  document.body.innerHTML = '<p id="status" hidden></p><main id="root"><p id="stuck">did not start</p></main>';
  sent = [];
  kept = state;
  scrolledTo = [];
  writes = 0;
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (m: PageMessage) => sent.push(m),
    getState: () => kept,
    setState: (s: unknown) => {
      writes++;
      kept = s;
    },
  });
  globalThis.scrollTo = ((_x: number, y: number) => void scrolledTo.push(y)) as unknown as typeof globalThis.scrollTo;
  vi.resetModules();
  track(window);
  track(document);
  await import('../src/webview/page');
}

function removeListeners(): void {
  for (const [target, type, listener] of added.splice(0)) target.removeEventListener(type, listener);
}

afterEach(removeListeners);

const deliver = (html: string) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'render', html }, origin: window.origin }));
const PAGE = '<details id="a" data-key="first"><summary>A</summary>x</details><details id="b"><summary>B</summary>y</details><details class="menu" id="m"><summary>More</summary></details>';

describe('the dashboard page keeps its place while its tab is hidden', () => {
  beforeEach(() => build(undefined));

  it('puts back the scroll position and the open sections on the first render after it is built again', async () => {
    await build({ scrollTop: 420, pinned: false, open: ['B'] });
    deliver(PAGE);
    expect((document.getElementById('b') as HTMLDetailsElement).open).toBe(true);
    expect((document.getElementById('a') as HTMLDetailsElement).open).toBe(false);
    expect(scrolledTo).toEqual([420]);
  });

  it('records the sections the person opens and where the page is scrolled, never counting a menu', () => {
    deliver(PAGE);
    const a = document.getElementById('a') as HTMLDetailsElement;
    a.open = true;
    (document.getElementById('m') as HTMLDetailsElement).open = true;
    a.dispatchEvent(new Event('toggle'));
    expect(kept).toBeUndefined();
    window.dispatchEvent(new Event('pagehide'));
    expect(kept).toMatchObject({ open: ['first'] });
    Object.defineProperty(globalThis, 'innerHeight', { configurable: true, value: 800 });
    Object.defineProperty(globalThis, 'scrollY', { configurable: true, value: 90 });
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('pagehide'));
    expect(kept).toMatchObject({ scrollTop: 90, pinned: false, open: ['first'] });
  });

  it('leaves the page alone when a read brings the same page, and keeps the open sections when it changes', () => {
    deliver(PAGE);
    const root = document.getElementById('root')!;
    const first = root.firstElementChild;
    deliver(PAGE);
    expect(root.firstElementChild).toBe(first);
    (document.getElementById('a') as HTMLDetailsElement).open = true;
    deliver(`${PAGE}<p>more</p>`);
    expect((document.getElementById('a') as HTMLDetailsElement).open).toBe(true);
    expect(root.querySelector('p')?.textContent).toBe('more');
    expect(sent.filter((m) => m.type === 'shown')).toHaveLength(3);
  });

  it('writes a burst of changes once, in the next frame', async () => {
    // Writes still waiting from earlier tests land first.
    await new Promise((r) => setTimeout(r, 50));
    writes = 0;
    deliver(PAGE);
    const a = document.getElementById('a') as HTMLDetailsElement;
    for (let i = 0; i < 5; i++) {
      a.open = !a.open;
      a.dispatchEvent(new Event('toggle'));
    }
    expect(writes).toBe(0);
    await vi.waitFor(() => expect(writes).toBe(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(writes).toBe(1);
  });

  it('works when the host gives no state API', async () => {
    removeListeners();
    document.body.innerHTML = '<main id="root"></main>';
    (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: () => undefined });
    vi.resetModules();
    track(window);
    await import('../src/webview/page');
    deliver('<p id="x">ok</p>');
    expect(document.getElementById('x')?.textContent).toBe('ok');
  });
});
