import { describe, expect, it } from 'vitest';
import { selectionPrompt } from '../src/panels/selectionPrompt';

describe('selectionPrompt', () => {
  it('fences the selection with its file name and language, leaving room for the question', () => {
    expect(selectionPrompt('src/app.ts', 'typescript', 'const a = 1;')).toBe('From src/app.ts:\n\n```typescript\nconst a = 1;\n```\n\n');
  });

  it('keeps a trailing newline without doubling it, and leaves plain text untagged', () => {
    expect(selectionPrompt('notes.txt', 'plaintext', 'line one\n')).toBe('From notes.txt:\n\n```\nline one\n```\n\n');
  });

  it('uses a fence longer than any run of backticks in the text', () => {
    const text = 'Use ```yaml fences``` or ````four````, and `inline`.';
    const prompt = selectionPrompt('README.md', 'markdown', text);
    expect(prompt.startsWith('From README.md:\n\n`````markdown\n')).toBe(true);
    expect(prompt.endsWith('\n`````\n\n')).toBe(true);
  });

  it('handles an empty selection and one that is all backticks', () => {
    expect(selectionPrompt('a', 'go', '')).toBe('From a:\n\n```go\n\n```\n\n');
    expect(selectionPrompt('a', 'go', '``````')).toContain('```````go\n``````\n```````');
  });
});
