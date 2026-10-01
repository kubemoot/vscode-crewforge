import * as http from 'node:http';
import * as https from 'node:https';
import type { KubeConfig } from '@kubernetes/client-node';
import { errorCode, plainCredentialsMessage, plainNetworkMessage, plainStatusMessage, unknownNetworkMessage, type Where } from './plainErrors';

/** A failed call to the API server, with a message a person can act on, and the raw error behind it. */
export class KubeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** The raw error, such as "connect ECONNREFUSED 127.0.0.1:6443" or "GET /api returned 401", for a tooltip or a bug report. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'KubeError';
  }
}

/** How long one request may wait for the API server before it fails as timed out. Streams have no such limit. */
export const REQUEST_TIMEOUT_MS = 20_000;

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
  constructor(
    private readonly config: KubeConfig,
    private readonly timeoutMs = REQUEST_TIMEOUT_MS,
  ) {}

  async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      const res = await this.once(method, path, body, signal);
      if (res.status >= 200 && res.status < 300) return res.text;
      const wait = retryDelayMs(res.status, res.retryAfter, attempt);
      if (wait === undefined) throw describeFailure(res.status, method, path, res.text, this.where());
      await sleep(wait, signal);
    }
  }

  private async once(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<RawResponse> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = payload ? { 'Content-Type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json' } : {};
    const { send, options } = await this.prepare(method, path, headers);
    if (signal?.aborted) throw abortError();
    return new Promise((resolve, reject) => {
      const succeed = (response: RawResponse) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(response);
      };
      const fail = (err: Error) => {
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      };
      const req = send(options, (res) => {
        readResponse(res).then(succeed, fail);
      });
      const onAbort = () => {
        req.destroy();
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      req.setTimeout(this.timeoutMs, () => req.destroy(timeoutError(this.timeoutMs)));
      req.on('error', (err) => fail(signal?.aborted ? abortError() : connectionError(err, this.where())));
      if (payload) req.write(payload);
      req.end();
    });
  }

  async stream(path: string, onChunk: (text: string) => void, signal: AbortSignal): Promise<void> {
    const { send, options } = await this.prepare('GET', path, { Accept: 'text/event-stream' });
    return new Promise((resolve, reject) => {
      if (signal.aborted) return resolve();
      // One signal can serve many streams in turn (a reconnecting turn), so each call
      // removes its own abort listener when it settles.
      const settle = (err?: Error) => {
        signal.removeEventListener('abort', onAbort);
        if (err && !signal.aborted) reject(err);
        else resolve();
      };
      const req = send(options, (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          collect(res).then((text) => settle(describeFailure(status, 'GET', path, text, this.where())), settle);
          return;
        }
        res.setEncoding('utf8');
        res.on('data', onChunk);
        res.on('end', () => settle());
        res.on('error', (err) => settle(connectionError(err, this.where())));
      });
      const onAbort = () => {
        req.destroy();
        settle();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('error', (err) => settle(connectionError(err, this.where())));
      req.end();
    });
  }

  /** The context and server this client talks to, for messages that name them. */
  private where(): Where {
    return { context: this.config.getCurrentContext(), server: this.config.getCurrentCluster()?.server };
  }

  private async prepare(method: string, path: string, headers: Record<string, string>) {
    const cluster = this.config.getCurrentCluster();
    if (!cluster) throw new KubeError('The kubeconfig has no current cluster');
    const server = new URL(cluster.server);
    const options: https.RequestOptions = {
      method,
      protocol: server.protocol,
      hostname: server.hostname.replaceAll(/^\[|\]$/g, ''),
      port: server.port || undefined,
      path: server.pathname.replace(/\/$/, '') + path,
      headers: { Accept: 'application/json', ...headers },
    };
    try {
      await this.config.applyToHTTPSOptions(options);
    } catch (err) {
      throw new CredentialsError(plainCredentialsMessage(this.where()), err instanceof Error ? err.message : String(err));
    }
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

/** One response as read off the wire, before it is judged a success or a failure. */
interface RawResponse {
  status: number;
  retryAfter?: string;
  text: string;
}

/** The status, Retry-After header, and whole body of a response. */
async function readResponse(res: http.IncomingMessage): Promise<RawResponse> {
  const header = res.headers['retry-after'];
  const retryAfter = Array.isArray(header) ? header[0] : header;
  const text = await collect(res);
  return { status: res.statusCode ?? 0, retryAfter, text };
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

/**
 * A refusal by status. With the context known, a refusal of the credentials or the account
 * is said plainly with the context, and the request and the server's words become the detail.
 */
export function describeFailure(status: number, method: string, path: string, body: string, where?: Where): KubeError {
  const detail = statusMessage(body);
  const suffix = detail ? ` (${detail})` : '';
  const raw = `${method} ${path} returned ${status}${suffix}`;
  const plain = where && plainStatusMessage(status, where, detail);
  if (plain) return new KubeError(plain, status, raw);
  const hint = hints[status] ?? 'The API server refused the request.';
  return new KubeError(`${hint} ${raw}`, status, raw);
}

/** A request that failed on the wire (reset, refused, timed out) rather than with a status. */
export class ConnectionError extends KubeError {
  constructor(message: string, detail?: string) {
    super(message, undefined, detail);
    this.name = 'ConnectionError';
  }
}

/** Credentials the kubeconfig could not produce, such as a login plugin that failed. */
export class CredentialsError extends KubeError {
  constructor(message: string, detail?: string) {
    super(message, undefined, detail);
    this.name = 'CredentialsError';
  }
}

function timeoutError(ms: number): Error {
  return Object.assign(new Error(`no response in ${ms / 1000} s`), { code: 'ETIMEDOUT' });
}

/** A failure on the wire in plain words, naming the context and server; the raw error is the detail. */
export function connectionError(err: Error, where: Where): ConnectionError {
  const code = errorCode(err);
  const raw = code && !err.message.includes(code) ? `${code}: ${err.message}` : err.message;
  const plain = plainNetworkMessage(code, where) ?? unknownNetworkMessage(where, err.message);
  return new ConnectionError(plain, raw);
}

/**
 * Whether the error means the cluster could not be reached, or would not take these
 * credentials, so another context may help. A 403 is left out: it denies one request to
 * an account the cluster knows, which another context rarely fixes.
 */
export function isConnectionProblem(err: unknown): boolean {
  return err instanceof ConnectionError || err instanceof CredentialsError || (err instanceof KubeError && err.status === 401);
}
