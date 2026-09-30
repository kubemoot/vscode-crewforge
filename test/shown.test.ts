// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { SHOWN_TEXT_LIMIT, shownText } from '../src/webview/shown';
import { messageText } from '../src/panels/panelState';

describe('what a webview reports as shown', () => {
  it('is its text on one line, cut to the limit', () => {
    const el = document.createElement('div');
    el.innerHTML = '<h1>lab-ops</h1>\n  <p>Ready\t now</p>';
    expect(shownText(el)).toBe('lab-ops Ready now');
    el.textContent = 'x'.repeat(SHOWN_TEXT_LIMIT + 10);
    expect(shownText(el)).toHaveLength(SHOWN_TEXT_LIMIT);
    expect(shownText({ textContent: null } as unknown as Element)).toBe('');
  });

  it('takes only text from a page message', () => {
    expect(messageText('hi')).toBe('hi');
    expect(messageText(3)).toBe('');
    expect(messageText(undefined)).toBe('');
  });
});
