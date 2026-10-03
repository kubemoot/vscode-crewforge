import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { KubeConfig } from '@kubernetes/client-node';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { ConnectionError, CredentialsError, describeFailure, KubeClient, KubeError, retryDelayMs, statusMessage } from '../src/k8s/request';

let server: http.Server;
let base: string;
const seen: Array<{ method?: string; url?: string; auth?: string; accept?: string; body: string }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, accept: req.headers.accept, body });
      route(req.url ?? '', res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

let busyLeft = 0;

/** Waits until the test server has received a request for `url` since the `before`th one. */
const received = (url: string, before: number) => vi.waitFor(() => expect(seen.slice(before).map((s) => s.url)).toContain(url));

function route(url: string, res: http.ServerResponse): void {
  if (url.endsWith('/busy')) {
    if (busyLeft-- > 0) {
      res.writeHead(429, { 'Retry-After': '0' });
      return void res.end('{"kind":"Status","message":"storage is (re)initializing"}');
    }
    return void res.end('{"items":[]}');
  }
  if (url.endsWith('/always-busy')) {
    res.writeHead(429, { 'Retry-After': '0' });
    return void res.end('{"kind":"Status","message":"storage is (re)initializing"}');
  }
  if (url.endsWith('/ok')) return void res.end('{"conversationId":"x"}');
  if (url.endsWith('/forbidden')) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return void res.end('{"kind":"Status","message":"services \\"x\\" is forbidden: User \\"workshop\\" cannot create resource"}');
  }
  if (url.endsWith('/stream')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"type":"connected"}\n\n');
    setTimeout(() => res.end('data: {"type":"done"}\n\n'), 20);
    return;
  }
  if (url.endsWith('/slow')) return void setTimeout(() => res.end('late'), 2_000);
  if (url.endsWith('/wait-long')) {
    res.writeHead(429, { 'Retry-After': '10' });
    return void res.end('{"message":"storage is (re)initializing"}');
  }
  if (url.endsWith('/forever')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"type":"connected"}\n\n');
    return;
  }
  res.writeHead(404);
  res.end('404 page not found');
}

function client(server = base, timeoutMs?: number): KubeClient {
  const kc = new KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: 'c', server, skipTLSVerify: true }],
    users: [{ name: 'u', token: 'secret-token' }],
    contexts: [{ name: 'ctx', cluster: 'c', user: 'u' }],
    currentContext: 'ctx',
  });
  return new KubeClient(kc, timeoutMs);
}

describe('KubeClient', () => {
  it('sends the kubeconfig token and a JSON body, and returns the body', async () => {
    const body = await client().request('POST', '/api/ok', { message: 'hi' });
    expect(body).toBe('{"conversationId":"x"}');
    const last = seen.at(-1)!;
    expect(last).toMatchObject({ method: 'POST', url: '/api/ok', auth: 'Bearer secret-token', body: '{"message":"hi"}' });
  });

  it('keeps a path prefix in the server URL', async () => {
    await client(`${base}/k8s/clusters/c-1/`).request('GET', '/api/ok');
    expect(seen.at(-1)!.url).toBe('/k8s/clusters/c-1/api/ok');
  });

  it('turns a Kubernetes Status into a readable error with the status code', async () => {
    const err = await client().request('POST', '/api/forbidden', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KubeError);
    expect((err as KubeError).status).toBe(403);
    expect((err as KubeError).message).toMatch(/^Your account in context ctx is not allowed to do this. The cluster says: .*cannot create resource/);
    expect((err as KubeError).detail).toMatch(/^POST \/api\/forbidden returned 403 \(.*cannot create resource/);
  });

  it('retries while the API server asks it to with Retry-After, as client-go does', async () => {
    busyLeft = 2;
    const before = seen.length;
    expect(await client().request('GET', '/apis/busy')).toBe('{"items":[]}');
    expect(seen.length - before).toBe(3);
  });

  it('gives up after five attempts', async () => {
    const before = seen.length;
    await expect(client().request('GET', '/apis/always-busy')).rejects.toThrow(/429.*storage is \(re\)initializing/);
    expect(seen.length - before).toBe(5);
  });

  it('stops a request in flight when its signal aborts', async () => {
    const abort = new AbortController();
    const before = seen.length;
    const started = Date.now();
    const asking = client().request('POST', '/api/slow', {}, abort.signal);
    await received('/api/slow', before);
    abort.abort();
    await expect(asking).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('stops while waiting to retry', async () => {
    const abort = new AbortController();
    const started = Date.now();
    // The client's wait before the retry is the 10 s timer the server's Retry-After asks for.
    const timers = vi.spyOn(globalThis, 'setTimeout');
    try {
      const asking = client().request('GET', '/apis/wait-long', undefined, abort.signal);
      await vi.waitFor(() => expect(timers.mock.calls.some(([, ms]) => ms === 10_000)).toBe(true));
      abort.abort();
      await expect(asking).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      timers.mockRestore();
    }
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('does not send a request whose signal already aborted', async () => {
    const abort = new AbortController();
    abort.abort();
    const before = seen.length;
    await expect(client().request('GET', '/api/ok', undefined, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen.length).toBe(before);
  });

  it('reports 404 with its hint', async () => {
    await expect(client().request('GET', '/api/missing')).rejects.toThrow(/Not found.*404 page not found/);
  });

  it('streams chunks as they arrive and resolves when the server ends', async () => {
    const chunks: string[] = [];
    await client().stream('/api/stream', (c) => chunks.push(c), new AbortController().signal);
    expect(chunks.join('')).toBe('data: {"type":"connected"}\n\ndata: {"type":"done"}\n\n');
    expect(seen.at(-1)!.accept).toBe('text/event-stream');
  });

  it('resolves when aborted mid-stream', async () => {
    const abort = new AbortController();
    const chunks: string[] = [];
    const done = client().stream('/api/forever', (c) => {
      chunks.push(c);
      abort.abort();
    }, abort.signal);
    await expect(done).resolves.toBeUndefined();
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('leaves no abort listener behind, however many streams share one signal', async () => {
    const abort = new AbortController();
    for (let i = 0; i < 12; i++) await client().stream('/api/stream', () => {}, abort.signal);
    await expect(client().stream('/api/forbidden', () => {}, abort.signal)).rejects.toMatchObject({ status: 403 });
    await expect(client('http://127.0.0.1:1').stream('/api/stream', () => {}, abort.signal)).rejects.toBeInstanceOf(ConnectionError);
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
  });

  it('rejects a failed stream with the status', async () => {
    await expect(client().stream('/api/forbidden', () => {}, new AbortController().signal)).rejects.toMatchObject({ status: 403, detail: expect.stringMatching(/GET \/api\/forbidden returned 403/) });
  });

  it('reports an unreachable server as a connection error', async () => {
    const failure = client('http://127.0.0.1:1').request('GET', '/api/ok');
    await expect(failure).rejects.toThrow('No response from context ctx at http://127.0.0.1:1. Is the cluster running?');
    await expect(failure).rejects.toMatchObject({ detail: 'connect ECONNREFUSED 127.0.0.1:1' });
    await expect(failure).rejects.toBeInstanceOf(ConnectionError);
  });

  it('gives up on a request the server does not answer, and says so plainly', async () => {
    const failure = client(base, 50).request('GET', '/api/slow');
    await expect(failure).rejects.toThrow(`No answer in time from context ctx at ${base}. Is the cluster running, and can this computer reach it (network, VPN)?`);
    await expect(failure).rejects.toMatchObject({ detail: 'ETIMEDOUT: no response in 0.05 s' });
  });

  it('says plainly when the kubeconfig cannot produce credentials, keeping the raw error', async () => {
    const kc = new KubeConfig();
    kc.loadFromOptions({
      clusters: [{ name: 'c', server: base, skipTLSVerify: true }],
      users: [{ name: 'u', exec: { command: 'crewforge-no-such-login-plugin', apiVersion: 'client.authentication.k8s.io/v1beta1' } }],
      contexts: [{ name: 'gke', cluster: 'c', user: 'u' }],
      currentContext: 'gke',
    });
    const before = seen.length;
    const err = (await new KubeClient(kc).request('GET', '/api/ok').catch((e: unknown) => e)) as KubeError;
    expect(err).toBeInstanceOf(CredentialsError);
    expect(seen.length).toBe(before);
    expect(err.message).toMatch(/^CrewForge could not get credentials for context gke at http:\/\/127\.0\.0\.1:\d+ from the kubeconfig\./);
    expect(err.detail).toBeTruthy();
  });

  it('lets a stream stay quiet longer than a request may', async () => {
    const abort = new AbortController();
    const chunks: string[] = [];
    const quiet = client(base, 30);
    let settled = false;
    const done = quiet.stream('/api/forever', (c) => chunks.push(c), abort.signal).finally(() => (settled = true));
    await vi.waitFor(() => expect(chunks).toHaveLength(1));
    // A request to the same quiet server, started after the stream went quiet, times out;
    // the stream has been quiet longer and is still open.
    await expect(quiet.request('GET', '/api/forever')).rejects.toMatchObject({ name: 'ConnectionError', detail: expect.stringMatching(/no response in 0.03 s/) });
    expect(settled).toBe(false);
    abort.abort();
    await expect(done).resolves.toBeUndefined();
    expect(chunks).toHaveLength(1);
  });

  it('fails when the kubeconfig has no current cluster', async () => {
    await expect(new KubeClient(new KubeConfig()).request('GET', '/x')).rejects.toThrow(/no current cluster/);
  });
});

describe('retryDelayMs', () => {
  it('retries a 429 or 5xx only when Retry-After is sent', () => {
    expect(retryDelayMs(429, '2', 1)).toBe(2000);
    expect(retryDelayMs(503, '1', 1)).toBe(1000);
    expect(retryDelayMs(429, undefined, 1)).toBeUndefined();
    expect(retryDelayMs(503, undefined, 1)).toBeUndefined();
    expect(retryDelayMs(403, '1', 1)).toBeUndefined();
  });

  it('caps the wait, reads a date as one second, and stops at the fifth attempt', () => {
    expect(retryDelayMs(429, '120', 1)).toBe(10_000);
    expect(retryDelayMs(429, 'Wed, 21 Oct 2026 07:28:00 GMT', 1)).toBe(1000);
    expect(retryDelayMs(429, '1', 5)).toBeUndefined();
  });
});

describe('error text', () => {
  it('reads the message of a Status, or the raw text', () => {
    expect(statusMessage('{"message":"denied"}')).toBe('denied');
    expect(statusMessage('plain text\n')).toBe('plain text');
    expect(statusMessage('{"message":""}')).toBe('{"message":""}');
  });

  it('explains an expired token and unknown statuses', () => {
    expect(describeFailure(401, 'GET', '/p', '').message).toMatch(/expired/);
    expect(describeFailure(418, 'GET', '/p', 'teapot').message).toMatch(/refused the request. GET \/p returned 418 \(teapot\)/);
  });
});
