import { describe, expect, it } from 'vitest';
import { trimBoth, trimEnd } from '../src/text';

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
