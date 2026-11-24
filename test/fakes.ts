import * as fs from 'node:fs';
import * as path from 'node:path';
import { KubeError, type KubeTransport } from '../src/k8s/request';

export function fixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

export interface Call {
  method: string;
  path: string;
  body?: unknown;
  /** The extra headers the request carried, when it carried any. */
  headers?: Record<string, string>;
}

/**
 * A transport that answers POSTs with queued bodies and streams queued SSE text in
 * small chunks, recording every call.
 */
export class FakeTransport implements KubeTransport {
  calls: Call[] = [];
  responses: Array<string | Error> = [];
  streams: Array<string | Error> = [];
  /** When set, the stream stays open after its text until aborted. */
  holdOpen = false;
  chunkSize = 7;

  /** When set, request() waits until aborted, like a POST stuck behind a slow server. */
  hangRequests = false;

  /** What the gateway says a conversation's state is, by conversation id; a conversation with none is unknown to the gateway (404). */
  states: Record<string, unknown> = {};
  /** The paths of the state reads, kept apart from `calls` so a test of the POSTs and streams does not count them. */
  stateReads: string[] = [];

  async request(method: string, path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>): Promise<string> {
    const read = method === 'GET' ? /\/([^/]+)\/state$/.exec(path) : null;
    if (read) {
      this.stateReads.push(path);
      const state = this.states[decodeURIComponent(read[1])];
      if (state === undefined) throw new KubeError('not found', 404, `GET ${path} returned 404`);
      return JSON.stringify(state);
    }
    this.calls.push(headers ? { method, path, body, headers } : { method, path, body });
    if (this.hangRequests) {
      await new Promise<void>((_, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { name: 'AbortError' }))));
    }
    const next = this.responses.shift();
    if (next === undefined) throw new Error(`no response queued for ${method} ${path}`);
    if (next instanceof Error) throw next;
    return next;
  }

  async stream(path: string, onChunk: (text: string) => void, signal: AbortSignal): Promise<void> {
    this.calls.push({ method: 'GET', path });
    const next = this.streams.shift();
    if (next === undefined) throw new Error(`no stream queued for ${path}`);
    if (next instanceof Error) throw next;
    for (let i = 0; i < next.length && !signal.aborted; i += this.chunkSize) onChunk(next.slice(i, i + this.chunkSize));
    if (!this.holdOpen || signal.aborted) return;
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
  }
}
