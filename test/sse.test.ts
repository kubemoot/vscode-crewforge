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

  it('tracks the last event id, as a reconnecting client sends it back', () => {
    const p = new SseParser();
    expect(p.lastEventId).toBe('');
    p.push('data: {"type":"connected"}\n\nid: A:7\ndata: {"type":"thread_found","threadId":"A"}\n\n');
    expect(p.lastEventId).toBe('A:7');
    p.push('data: {"type":"heartbeat"}\n\n');
    expect(p.lastEventId).toBe('A:7');
    p.push('id:A:9\ndata: {"type":"synthesis"}\n');
    expect(p.lastEventId).toBe('A:7');
    p.push('\n');
    expect(p.lastEventId).toBe('A:9');
    p.push('id: bad\0id\ndata: {"type":"done"}\n\n');
    expect(p.lastEventId).toBe('A:9');
  });

  it('tags each event with the id it arrived under, across chunks and id-only blocks', () => {
    const p = new SseParser();
    expect(p.push('id: A:3\n')).toEqual([]);
    const [found] = p.push('data: {"type":"thread_found","threadId":"A"}\n\n');
    expect(found.id).toBe('A:3');
    expect(p.push('id: A:5\n\n')).toEqual([]);
    expect(p.lastEventId).toBe('A:5');
    const [beat] = p.push('data: {"type":"heartbeat"}\n\n');
    expect(beat.id).toBe('A:5');
    expect(new SseParser().push('data: {"type":"connected"}\n\n')[0].id).toBeUndefined();
  });

  it('returns nothing for empty input', () => {
    expect(parseAll('', 1)).toEqual([]);
    expect(parseAll('\n\n\n', 1)).toEqual([]);
  });
});
