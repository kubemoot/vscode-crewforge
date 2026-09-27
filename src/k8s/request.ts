import * as http from 'node:http';
import * as https from 'node:https';
import type { KubeConfig } from '@kubernetes/client-node';

/** A failed call to the API server, with a message a person can act on. */
export class KubeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'KubeError';
  }
}

/** The two things CrewForge asks of the API server. */
export interface KubeTransport {
  /**
   * A request whose whole response body is wanted. Resolves to the body on 2xx; rejects
   * with an AbortError when `signal` aborts. A PATCH body is a JSON merge patch.
   */
  request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<string>;
  /** A long GET whose body arrives in chunks; resolves when the server ends it or `signal` aborts. */
  stream(path: string, onChunk: (text: string) => void, signal: AbortSignal): Promise<void>;
}

/**
 * Talks to the API server with Node's http(s) module, so responses stream and every
 * kubeconfig credential form (CA, client certificate, token, exec plugin, proxy) is
 * applied by the Kubernetes client library itself.
 */
export class KubeClient implements KubeTransport {
  constructor(private readonly config: KubeConfig) {}

  async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      const res = await this.once(method, path, body, signal);
      if (res.status >= 200 && res.status < 300) return res.text;
      const wait = retryDelayMs(res.status, res.retryAfter, attempt);
      if (wait === undefined) throw describeFailure(res.status, method, path, res.text);
      await sleep(wait, signal);
    }
  }

  private async once(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<{ status: number; retryAfter?: string; text: string }> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = payload ? { 'Content-Type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json' } : {};
    const { send, options } = await this.prepare(method, path, headers);
    if (signal?.aborted) throw abortError();
    return new Promise((resolve, reject) => {
      const req = send(options, (res) => {
        const header = res.headers['retry-after'];
        const retryAfter = Array.isArray(header) ? header[0] : header;
        collect(res).then(
          (text) => done(() => resolve({ status: res.statusCode ?? 0, retryAfter, text })),
          (err: Error) => done(() => reject(err)),
        );
      });
      const onAbort = () => {
        req.destroy();
        reject(abortError());
      };
      const done = (settle: () => void) => {
        signal?.removeEventListener('abort', onAbort);
        settle();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      req.on('error', (err) => done(() => reject(signal?.aborted ? abortError() : connectionError(err))));
      if (payload) req.write(payload);
      req.end();
    });
  }

  async stream(path: string, onChunk: (text: string) => void, signal: AbortSignal): Promise<void> {
    const { send, options } = await this.prepare('GET', path, { Accept: 'text/event-stream' });
    return new Promise((resolve, reject) => {
      if (signal.aborted) return resolve();
      const req = send(options, (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          collect(res).then((text) => reject(describeFailure(status, 'GET', path, text)), reject);
          return;
        }
        res.setEncoding('utf8');
        res.on('data', onChunk);
        res.on('end', resolve);
        res.on('error', (err) => (signal.aborted ? resolve() : reject(connectionError(err))));
      });
      signal.addEventListener('abort', () => {
        req.destroy();
        resolve();
      });
      req.on('error', (err) => (signal.aborted ? resolve() : reject(connectionError(err))));
      req.end();
    });
  }

  private async prepare(method: string, path: string, headers: Record<string, string>) {
    const cluster = this.config.getCurrentCluster();
    if (!cluster) throw new KubeError('The kubeconfig has no current cluster');
    const server = new URL(cluster.server);
    const options: https.RequestOptions = {
      method,
      protocol: server.protocol,
      hostname: server.hostname.replace(/^\[|\]$/g, ''),
      port: server.port || undefined,
      path: server.pathname.replace(/\/$/, '') + path,
      headers: { Accept: 'application/json', ...headers },
    };
    await this.config.applyToHTTPSOptions(options);
    const send = server.protocol === 'http:' ? http.request : https.request;
    return { send, options };
  }
}

/** The error a request rejects with when its signal aborts. */
export function abortError(): Error {
  const err = new Error('The request was stopped');
  err.name = 'AbortError';
  return err;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function collect(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    res.on('data', (b: Buffer) => parts.push(b));
    res.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    res.on('error', reject);
  });
}

const MAX_ATTEMPTS = 5;

/**
 * How long to wait before retrying, or undefined to give up. As client-go does, a
 * response is retried only when the server asks for it with Retry-After (a 429 while
 * the API server's storage initializes, or a 5xx during a restart).
 */
export function retryDelayMs(status: number, retryAfter: string | undefined, attempt: number): number | undefined {
  if (attempt >= MAX_ATTEMPTS || retryAfter === undefined) return undefined;
  if (status !== 429 && status < 500) return undefined;
  const seconds = Number(retryAfter);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 10) * 1000 : 1000;
}

/** The `message` of a Kubernetes Status body, or the raw text when it is not one. */
export function statusMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === 'string' && parsed.message) return parsed.message;
  } catch {
    // Not a Status object.
  }
  return body.trim().slice(0, 300);
}

const hints: Record<number, string> = {
  401: 'The cluster did not accept your credentials. The token may have expired; get a fresh kubeconfig.',
  403: 'Your account is not allowed to do this.',
  404: 'Not found. Check the namespace and crew name.',
  503: 'The service has no ready pod behind it yet. Check that the crew is Ready.',
};

export function describeFailure(status: number, method: string, path: string, body: string): KubeError {
  const detail = statusMessage(body);
  const hint = hints[status] ?? 'The API server refused the request.';
  const suffix = detail ? ` (${detail})` : '';
  return new KubeError(`${hint} ${method} ${path} returned ${status}${suffix}`, status);
}

function connectionError(err: Error): KubeError {
  return new KubeError(`Could not reach the API server: ${err.message}`);
}
