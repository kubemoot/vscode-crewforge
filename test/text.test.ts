import { describe, expect, it } from 'vitest';
import { byCodeUnits, escapeRegExp, trimBoth, trimEnd } from '../src/text';

describe('trimEnd', () => {
  it('removes a run of trailing characters', () => {
    expect(trimEnd('crew-suite---', '-')).toBe('crew-suite');
    expect(trimEnd('github.com/org/repo//', '/')).toBe('github.com/org/repo');
  });

  it('keeps leading and inner characters', () => {
    expect(trimEnd('-a-b', '-')).toBe('-a-b');
  });

  it('handles empty input and input made only of the character', () => {
    expect(trimEnd('', '-')).toBe('');
    expect(trimEnd('----', '-')).toBe('');
  });

  it('stays linear on a long run that is not at the end', () => {
    const s = `${'-'.repeat(200_000)}x`;
    expect(trimEnd(s, '-')).toBe(s);
  });
});

describe('trimBoth', () => {
  it('removes runs at both ends', () => {
    expect(trimBoth('--my-title--', '-')).toBe('my-title');
  });

  it('leaves a string without the character unchanged', () => {
    expect(trimBoth('title', '-')).toBe('title');
  });

  it('handles empty input and input made only of the character', () => {
    expect(trimBoth('', '-')).toBe('');
    expect(trimBoth('---', '-')).toBe('');
  });
});

describe('byCodeUnits', () => {
  it('orders by code units: negative, positive, or zero', () => {
    expect(byCodeUnits('B', 'a')).toBe(-1);
    expect(byCodeUnits('a', 'B')).toBe(1);
    expect(byCodeUnits('a', 'a')).toBe(0);
    expect(['10', '9', '1'].sort(byCodeUnits)).toEqual(['1', '10', '9']);
  });

  it('gives the order sort() gives without a compare function', () => {
    const names = ['b', 'B', 'a-1', 'a.1', 'a', '_x', '10', '9', 'é', 'z'];
    expect([...names].sort(byCodeUnits)).toEqual([...names].sort());
  });
});

describe('escapeRegExp', () => {
  it('makes a pattern that matches the text literally', () => {
    const text = 'a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o';
    expect(new RegExp(`^${escapeRegExp(text)}$`).test(text)).toBe(true);
    expect(new RegExp(escapeRegExp('a.b')).test('axb')).toBe(false);
    expect(escapeRegExp('plain-name')).toBe('plain-name');
    expect(escapeRegExp('')).toBe('');
  });
});
