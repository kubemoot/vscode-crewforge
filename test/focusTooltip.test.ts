// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enableFocusTooltips } from '../src/webview/tooltip';

const tip = () => document.querySelector('.focus-tip');

beforeAll(() => enableFocusTooltips(document));
beforeEach(() => {
  document.body.innerHTML = '<button id="a" title="Does a thing">A</button><button id="b">B</button><h2 id="h" tabindex="0" title="A heading">H</h2><p id="after">text</p><div role="menu" id="m"><button id="e" role="menuitem" title="Menu item">E</button></div><span id="c" title="Inside"><button id="d">D</button></span>';
});

describe('the keyboard focus tooltip', () => {
  it('shows an element\'s title when it gets focus, and removes it when focus leaves', () => {
    document.getElementById('a')!.focus();
    expect(tip()?.textContent).toBe('Does a thing');
    expect(tip()?.getAttribute('role')).toBe('tooltip');
    document.getElementById('b')!.focus();
    expect(tip()).toBeNull();
  });

  it('shows the title of the nearest element that has one', () => {
    document.getElementById('d')!.focus();
    expect(tip()?.textContent).toBe('Inside');
  });

  it('shows one tooltip at a time, and none for an element without a title', () => {
    document.getElementById('a')!.focus();
    document.getElementById('d')!.focus();
    expect(document.querySelectorAll('.focus-tip')).toHaveLength(1);
    document.getElementById('b')!.focus();
    expect(tip()).toBeNull();
  });

  it('goes away on Escape and on scroll', () => {
    document.getElementById('a')!.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(tip()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(tip()).toBeNull();
    document.getElementById('b')!.focus();
    document.getElementById('a')!.focus();
    document.dispatchEvent(new Event('scroll'));
    expect(tip()).toBeNull();
  });

  it('keeps the bubble inside the page, under the element', () => {
    document.getElementById('a')!.focus();
    const style = (tip() as HTMLElement).style;
    expect(style.left).toMatch(/px$/);
    expect(style.top).toMatch(/px$/);
  });

  it('puts a menu item\'s bubble beside the menu, so the items below stay readable', () => {
    document.getElementById('e')!.focus();
    const style = (tip() as HTMLElement).style;
    expect(tip()?.textContent).toBe('Menu item');
    expect(style.left).toMatch(/px$/);
  });

  const rect = (left: number, right: number, top: number, bottom: number): DOMRect => ({ left, right, top, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) });

  it('puts a heading\'s bubble beside the heading when it fits on the heading\'s line', () => {
    document.getElementById('h')!.focus();
    expect(tip()?.textContent).toBe('A heading');
    expect((tip() as HTMLElement).style.left).toBe('8px');
  });

  it('puts a heading\'s bubble under the paragraphs that follow it when it would be taller than the heading', () => {
    const heading = document.getElementById('h')!;
    heading.getBoundingClientRect = () => rect(0, 100, 10, 30);
    document.getElementById('after')!.getBoundingClientRect = () => rect(0, 100, 30, 70);
    const real = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return this.classList.contains('focus-tip') ? rect(0, 200, 0, 60) : real.call(this);
    };
    try {
      heading.focus();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = real;
    }
    expect((tip() as HTMLElement).style.top).toBe('74px');
  });
});
