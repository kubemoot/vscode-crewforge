/** One line of a line diff: kept (' '), only in the first text ('-'), or only in the second ('+'). */
export interface DiffLine {
  op: ' ' | '-' | '+';
  text: string;
}

/** The most lines a side may have for a line diff; longer texts are compared as one block each. */
export const DIFF_LINE_LIMIT = 3000;

/**
 * The lines of `before` and `after` as a diff: the longest common subsequence is kept,
 * and the rest is removed from `before` or added in `after`, removals first.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > DIFF_LINE_LIMIT || b.length > DIFF_LINE_LIMIT) return [...a.map((text) => line('-', text)), ...b.map((text) => line('+', text))];
  return walk(a, b, lcsTable(a, b));
}

function splitLines(text: string): string[] {
  return text === '' ? [] : text.replace(/\n$/, '').split('\n');
}

function line(op: DiffLine['op'], text: string): DiffLine {
  return { op, text };
}

/** For each pair of suffixes, the length of their longest common subsequence. */
function lcsTable(a: string[], b: string[]): Uint32Array[] {
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  return table;
}

function walk(a: string[], b: string[], table: Uint32Array[]): DiffLine[] {
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(line(' ', a[i++]));
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) out.push(line('-', a[i++]));
    else out.push(line('+', b[j++]));
  }
  return [...out, ...a.slice(i).map((text) => line('-', text)), ...b.slice(j).map((text) => line('+', text))];
}
