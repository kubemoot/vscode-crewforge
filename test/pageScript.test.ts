// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { PageMessage } from '../src/webview/pageProtocol';

let sent: PageMessage[];

async function load(): Promise<void> {
  document.body.innerHTML = '<p id="status" hidden></p><main id="root"><p id="stuck">did not start</p></main>';
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
    expect(document.getElementById('stuck')).toBeNull();
    deliver({ type: 'render', html: '<p id="p">hi</p>' });
    expect(document.getElementById('p')?.textContent).toBe('hi');
    expect(sent.at(-1)).toEqual({ type: 'shown', text: 'hi' });
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
    expect(sent.filter((m) => m.type === 'action')).toEqual([
      { type: 'action', action: 'go', arg: 'a/b' },
      { type: 'action', action: 'refresh', arg: undefined },
    ]);
  });

  it('shows the read under way, and hides the line once the read is done', () => {
    const status = document.getElementById('status')!;
    deliver({ type: 'status', text: 'Still reading from kind-dev...' });
    expect(status.textContent).toBe('Still reading from kind-dev...');
    expect(status.hidden).toBe(false);
    deliver({ type: 'status', text: '' });
    expect(status.hidden).toBe(true);
    deliver({ type: 'status', text: 5 });
    expect(status.hidden).toBe(true);
  });

  it('reports its own errors to the extension', () => {
    window.dispatchEvent(new ErrorEvent('error', { message: 'bad thing' }));
    window.dispatchEvent(new ErrorEvent('error', { error: 'thrown' }));
    const rejection = new Event('unhandledrejection') as Event & { reason: unknown };
    rejection.reason = 'nope';
    window.dispatchEvent(rejection);
    expect(sent.filter((m) => m.type === 'error')).toEqual([
      { type: 'error', message: 'bad thing' },
      { type: 'error', message: 'thrown' },
      { type: 'error', message: 'nope' },
    ]);
  });
});
