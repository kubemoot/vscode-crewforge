import * as fs from 'node:fs';
import * as path from 'node:path';
import type { KubeTransport } from '../src/k8s/request';

export function fixture(name: string): string {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

export interface Call {
  method: string;
  path: string;
  body?: unknown;
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

  async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<string> {
    this.calls.push({ method, path, body });
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
