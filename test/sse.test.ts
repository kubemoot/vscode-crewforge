import { describe, expect, it } from 'vitest';
import { SseParser } from '../src/discussion/sse';
import { fixture } from './fakes';

function parseAll(text: string, chunk: number): string[] {
  const p = new SseParser();
  const types: string[] = [];
  for (let i = 0; i < text.length; i += chunk) types.push(...p.push(text.slice(i, i + chunk)).map((e) => e.type));
  types.push(...p.end().map((e) => e.type));
  return types;
}

describe('SseParser', () => {
  const recorded = fixture('turn1.sse');
  const expected = ['connected', 'thread_found', 'heartbeat', 'heartbeat', 'phase', 'phase', 'phase', 'heartbeat', 'synthesis', 'done'];

  it('reads a recorded gateway stream', () => {
    expect(parseAll(recorded, recorded.length)).toEqual(expected);
  });

  it('gives the same events however the stream is split', () => {
    for (const size of [1, 2, 3, 5, 13, 64]) expect(parseAll(recorded, size)).toEqual(expected);
  });

  it('keeps event fields', () => {
    const [phase] = new SseParser().push('data: {"type":"phase","agent":"node-watcher","status":"done","stood_aside":true}\n\n');
    expect(phase).toEqual({ type: 'phase', agent: 'node-watcher', status: 'done', stood_aside: true });
  });

  it('handles CRLF and CR line endings, including a CRLF split across chunks', () => {
    expect(parseAll('data: {"type":"done"}\r\n\r\n', 1)).toEqual(['done']);
    expect(parseAll('data: {"type":"done"}\r\r', 100)).toEqual(['done']);
    const p = new SseParser();
    expect(p.push('data: {"type":"connected"}\r')).toEqual([]);
    expect(p.push('\n\r\n').map((e) => e.type)).toEqual(['connected']);
  });

  it('joins multi-line data with newlines', () => {
    const [e] = new SseParser().push('data: {"type":"synthesis",\ndata: "content":"a"}\n\n');
    expect(e).toEqual({ type: 'synthesis', content: 'a' });
  });

  it('skips comments, other fields, non-JSON data, and JSON without a type', () => {
    const text = ': keep-alive\n\nevent: message\nid: 4\ndata: {"type":"connected"}\n\ndata: ping\n\ndata: [1,2]\n\ndata: {"x":1}\n\n';
    expect(parseAll(text, 4)).toEqual(['connected']);
  });

  it('flushes an unterminated final event at end of stream', () => {
    expect(parseAll('data: {"type":"done"}', 3)).toEqual(['done']);
  });

  it('returns nothing for empty input', () => {
    expect(parseAll('', 1)).toEqual([]);
    expect(parseAll('\n\n\n', 1)).toEqual([]);
  });
});
