import { describe, expect, it } from 'vitest';
import { blockEnd, documentsOf, editLines, findDocument, findKey, isContent, valueOf } from '../src/source/yamlLines';

describe('YAML read line by line', () => {
  const lines = ['kind: Crew', 'metadata:', '  name: a', '---', 'kind: "CrewSchedulingPolicy" # policy', 'spec:', '  rules:', '  - phase: triage', '  {{- if .Values.x }}', '  # note', '  crewRef: a', 'status: {}'];

  it('splits documents at their separators and finds one by kind', () => {
    expect(documentsOf(lines)).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 12 },
    ]);
    expect(findDocument(lines, 'CrewSchedulingPolicy')).toEqual({ start: 4, end: 12 });
    expect(findDocument(lines, 'Crew')).toEqual({ start: 0, end: 3 });
    expect(findDocument(lines, 'Agent')).toBeUndefined();
  });

  it('finds keys at an indent, quoted or not, and reads their values', () => {
    expect(findKey(lines, { start: 4, end: 12 }, 0, 'spec')).toBe(5);
    expect(findKey(lines, { start: 4, end: 12 }, 0, 'rules')).toBe(-1);
    expect(valueOf('  "rules": []', 2, 'rules')).toBe('[]');
    expect(valueOf('  rules: []', 0, 'rules')).toBeUndefined();
    expect(valueOf('  a.b: x', 2, 'a.b')).toBe('x');
    expect(valueOf('  aXb: x', 2, 'a.b')).toBeUndefined();
  });

  it('ends a block past its last deeper line, counting list items at its own indent and passing over comments and Helm lines', () => {
    expect(blockEnd(lines, 6, 2, 12)).toBe(8);
    expect(blockEnd(lines, 5, 0, 12)).toBe(11);
    expect(isContent('  {{- end }}')).toBe(false);
    expect(isContent('  # c')).toBe(false);
    expect(isContent('')).toBe(false);
    expect(isContent('a: 1')).toBe(true);
  });

  it('keeps line endings through an edit, and gives undefined when the edit declines', () => {
    expect(editLines('a\r\nb\r\n', (l) => [...l.slice(0, 1), 'x', ...l.slice(1)])).toBe('a\r\nx\r\nb\r\n');
    expect(editLines('a\nb', (l) => l.reverse())).toBe('b\na');
    expect(editLines('a', () => undefined)).toBeUndefined();
  });
});
