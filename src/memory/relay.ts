import * as http from 'node:http';
import { KubeConfig, PortForward } from '@kubernetes/client-node';
import { listenForward, type LocalForward, type PodTunnel } from '../discussion/forward';
import { TokenSource, type CallerSettings } from '../discussion/gateway';
import { checkName } from '../k8s/paths';
import { ConnectionError, KubeError, type KubeTransport } from '../k8s/request';
import { resolveReportTarget } from './operatorTarget';
import { parseExport, parseReport, type ParsedExport, type SelectionReport } from './ompi';

/** How long one request to the operator may wait, and the most a response may hold. */
export const MEMORY_REQUEST_MS = 30_000;
export const MEMORY_MAX_BYTES = 128 * 1024 * 1024;

/** A refusal by the operator's report service, said in plain words, with its status kept. */
export class MemoryError extends KubeError {
  constructor(message: string, status?: number, detail?: string, readonly needsToken = false) {
    super(message, status, detail);
    this.name = 'MemoryError';
  }
}

/** What a message names. */
export interface MemoryContext {
  namespace: string;
  crew: string;
  context: string;
  sentToken: boolean;
  /** NAMESPACE/NAME of the ServiceAccount a token was minted for, when the settings ask for one. */
  serviceAccount?: string;
}

/** The server's words, one short line. */
function serverWords(body: string): string {
  return body.trim().replaceAll(/\s+/g, ' ').slice(0, 200);
}

function inParens(text: string): string {
  return text ? ` (${text})` : '';
}

function unauthorized(where: MemoryContext): string {
  if (where.serviceAccount) {
    return `The Kubemoot operator did not accept the token minted for service account ${where.serviceAccount}. The account needs get on the Crew ${where.crew} in ${where.namespace}.`;
  }
  if (where.sentToken) {
    return `The Kubemoot operator did not accept your Kubernetes token (context ${where.context}). It may have expired; get a fresh kubeconfig.`;
  }
  return `The Kubemoot operator needs a Kubernetes bearer token to read memory, and the kubeconfig for context ${where.context} has none (it signs in with a client certificate or a password). Choose a ServiceAccount you may create tokens for, or use a kubeconfig that signs in with a token.`;
}

function notFound(body: string, where: MemoryContext): string {
  // An operator without the endpoint answers the standard "404 page not found" of its router.
  if (/^404 page not found$/i.test(serverWords(body))) {
    return 'This Kubemoot operator is too old to export crew memory: it has no memory-export endpoint. Upgrade Kubemoot to a release that has it.';
  }
  return `The operator found no memory export for crew ${where.crew} in namespace ${where.namespace}. Check the crew name and namespace.`;
}

function unavailable(status: number, body: string): string {
  const words = serverWords(body);
  if (status === 502) return `The operator could not reach the crew memory store${inParens(words)}. Check that NATS is running, then refresh.`;
  return `The operator cannot serve the memory export right now (${status}${words ? ': ' : ''}${words}). Check that the Kubemoot operator is Ready, then refresh.`;
}

/** What a response with a failing status means, in plain words naming what is missing. */
export function explainStatus(status: number, body: string, where: MemoryContext): MemoryError {
  const detail = `GET memory-export returned ${status}: ${serverWords(body)}`;
  let message: string;
  switch (status) {
    case 401:
      message = unauthorized(where);
      break;
    case 403:
      message = `Reading the memory of crew ${where.crew} needs get on the Crew ${where.crew} (kubemoot.ai crews) in namespace ${where.namespace}. Your account does not have it.`;
      break;
    case 404:
      message = notFound(body, where);
      break;
    case 502:
    case 503:
      message = unavailable(status, body);
      break;
    default:
      message = `The operator refused the memory export (${status}${serverWords(body) ? ': ' : ''}${serverWords(body)}).`;
  }
  return new MemoryError(message, status, detail, status === 401 && !where.sentToken && !where.serviceAccount);
}

/** What opens a tunnel; a test replaces it. */
export interface RelayParts {
  tunnel: (config: KubeConfig) => PodTunnel;
}

const realParts: RelayParts = { tunnel: (config) => new PortForward(config) };

interface Reply {
  status: number;
  body: Buffer;
}

function get(port: number, path: string, authorization: string | undefined, timeoutMs: number, maxBytes: number): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = authorization ? { Authorization: authorization } : {};
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const parts: Buffer[] = [];
      let size = 0;
      res.on('data', (b: Buffer) => {
        size += b.length;
        if (size <= maxBytes) parts.push(b);
      });
      res.on('end', () => (size > maxBytes ? reject(new Error('The memory export is too large.')) : resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts) })));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no response in ${timeoutMs / 1000} s`)));
    req.on('error', reject);
    req.end();
  });
}

/** What a read of a crew's memory brings back. */
export interface MemoryRead {
  zip: Buffer;
  parsed: ParsedExport;
  /** The selection report; absent when the operator did not give one. */
  report?: SelectionReport;
}

/**
 * Reads a crew's memory export from the Kubemoot operator's report service over a
 * port-forward to its pod, with the caller's Kubernetes token, so RBAC decides who may read.
 * The forward lives for one read.
 */
export class MemoryRelay {
  constructor(
    private readonly api: KubeTransport,
    private readonly config: KubeConfig,
    private readonly operatorNamespace: string,
    private readonly parts: RelayParts = realParts,
    private readonly timeoutMs = MEMORY_REQUEST_MS,
    settings: CallerSettings = { tokenServiceAccount: '', tokenAudiences: [] },
    private readonly maxBytes = MEMORY_MAX_BYTES,
  ) {
    this.tokens = new TokenSource(api, config, settings);
    this.serviceAccount = settings.tokenServiceAccount.trim() || undefined;
  }

  private readonly tokens: TokenSource;
  private readonly serviceAccount?: string;

  /** The export as a zip and its selection report. */
  async read(namespace: string, crew: string): Promise<MemoryRead> {
    const ns = checkName('namespace', namespace);
    const name = checkName('crew', crew);
    const target = await resolveReportTarget(this.api, this.operatorNamespace).catch((err: unknown) => {
      throw explainForward(err, this.operatorNamespace);
    });
    const forward = await listenForward(this.parts.tunnel(this.config), this.operatorNamespace, target.pod, target.port);
    try {
      return await this.fetchBoth(forward, ns, name);
    } finally {
      await forward.close();
    }
  }

  private async fetchBoth(forward: LocalForward, namespace: string, crew: string): Promise<MemoryRead> {
    const base = `/memory-export/${namespace}/${encodeURIComponent(crew)}`;
    const zip = await this.fetch(forward, base, namespace, crew);
    const report = parseReport((await this.fetch(forward, `${base}?report=true`, namespace, crew)).toString('utf8')) ?? undefined;
    return { zip, parsed: parseExport(zip), report };
  }

  private async fetch(forward: LocalForward, path: string, namespace: string, crew: string): Promise<Buffer> {
    const authorization = await this.tokens.authorization();
    let reply: Reply;
    try {
      reply = await get(forward.port, path, authorization, this.timeoutMs, this.maxBytes);
    } catch (err) {
      throw new ConnectionError(`The connection to the Kubemoot operator (through a port-forward in context ${this.config.getCurrentContext()}) failed or was cut. ${(err as Error).message}`.trim(), (err as Error).message);
    }
    if (reply.status >= 200 && reply.status < 300) return reply.body;
    throw explainStatus(reply.status, reply.body.toString('utf8'), { namespace, crew, context: this.config.getCurrentContext(), sentToken: authorization !== undefined, serviceAccount: this.serviceAccount });
  }
}

/** A refusal to read the Service or its pods, said as what the port-forward needs. */
function explainForward(err: unknown, namespace: string): unknown {
  if (err instanceof KubeError && err.status === 403) {
    return new KubeError(`Your account may not reach the Kubemoot operator's report service. The port-forward needs get on services, list on pods, and create on pods/portforward in ${namespace}.`, 403, err.detail);
  }
  return err;
}
