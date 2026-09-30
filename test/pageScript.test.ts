// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { PageMessage } from '../src/webview/pageProtocol';

let sent: PageMessage[];

async function load(): Promise<void> {
  document.body.innerHTML = '<main id="root"></main>';
  sent = [];
  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: (m: PageMessage) => sent.push(m) });
  vi.resetModules();
  await import('../src/webview/page');
}

const deliver = (data: unknown, origin = window.origin) => window.dispatchEvent(new MessageEvent('message', { data, origin }));

// The script listens on the document, which outlives a test, so it loads once.
beforeAll(load);

describe('the dashboard page script', () => {
  it('says it is ready, and shows only rendered bodies from its own origin', () => {
    expect(sent).toEqual([{ type: 'ready' }]);
    deliver({ type: 'render', html: '<p id="p">hi</p>' });
    expect(document.getElementById('p')?.textContent).toBe('hi');
    deliver({ type: 'render', html: '<p>evil</p>' }, 'https://attacker.example');
    deliver({ type: 'render', html: 42 });
    deliver({ type: 'other', html: '<p>x</p>' });
    deliver(null);
    expect(document.getElementById('root')?.innerHTML).toBe('<p id="p">hi</p>');
  });

  it('reports the action and argument of a clicked button, but not of a disabled one', () => {
    deliver({ type: 'render', html: '<button data-action="go" data-arg="a/b"><span id="inner">Go</span></button><button id="off" data-action="stop" disabled><span id="offInner">Stop</span></button><p id="plain">x</p><button id="bare" data-action="refresh">R</button>' });
    document.getElementById('inner')!.click();
    document.getElementById('off')!.click();
    document.getElementById('offInner')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.getElementById('plain')!.click();
    document.getElementById('bare')!.click();
    expect(sent.slice(1).filter((m) => m.type === 'action')).toEqual([
      { type: 'action', action: 'go', arg: 'a/b' },
      { type: 'action', action: 'refresh', arg: undefined },
    ]);
  });
});
