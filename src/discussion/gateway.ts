import type * as https from 'node:https';
import { KubeConfig, PortForward } from '@kubernetes/client-node';
import { checkName } from '../k8s/paths';
import { ConnectionError, KubeClient, KubeError, type KubeTransport } from '../k8s/request';
import { listenForward, type LocalForward, type PodTunnel } from './forward';
import { resolveTarget } from './target';

/** A transport to one crew's gateway that can be closed when the chat is. */
export interface GatewayTransport extends KubeTransport {
  close(): Promise<void>;
}

/** Who CrewForge is at the gateway when the kubeconfig has no bearer token of its own. */
export interface CallerSettings {
  /** "NAMESPACE/NAME" of a ServiceAccount to mint a short-lived token for; empty to use the kubeconfig's token. */
  tokenServiceAccount: string;
  /** The audiences a minted token is bound to, for a crew that declares `tokenAudiences`. */
  tokenAudiences: string[];
}

/** How long a minted token lives, and how soon before its end a new one is minted. */
const TOKEN_SECONDS = 600;
const RENEW_BEFORE_MS = 120_000;

/** A failure to be the caller the settings ask for, such as a ServiceAccount CrewForge may not mint a token for. */
export class CallerError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = 'CallerError';
  }
}

/** Splits "NAMESPACE/NAME", or throws a message that says what the setting should look like. */
export function parseServiceAccount(value: string): { namespace: string; name: string } {
  const [namespace, name, ...rest] = value.trim().split('/');
  if (!namespace || !name || rest.length > 0) throw new CallerError(`The crewforge.tokenServiceAccount setting "${value}" should be NAMESPACE/NAME.`);
  return { namespace: checkName('namespace', namespace), name: checkName('service account', name) };
}

/**
 * Where the caller's bearer token comes from: the kubeconfig's own (a token, a token file,
 * or a login plugin, asked for again on every request so a refreshed token is used), or a
 * short-lived token minted for a ServiceAccount when the kubeconfig signs in with a
 * certificate. It is handed to the HTTP request as a header and never returned to a caller,
 * shown, or logged.
 */
export class TokenSource {
  private minted?: { token: string; expiresAt: number };
  /** Whether the last request carried a token, to say what a refusal means. */
  sent = false;

  constructor(
    private readonly api: KubeTransport,
    private readonly config: Pick<KubeConfig, 'applyToHTTPSOptions'>,
    private readonly settings: CallerSettings,
    private readonly now: () => number = Date.now,
  ) {}

  get usesServiceAccount(): boolean {
    return this.settings.tokenServiceAccount.trim() !== '';
  }

  /** The `Authorization` header value, or undefined when the kubeconfig has no bearer token. */
  async authorization(): Promise<string | undefined> {
    const header = this.usesServiceAccount ? `Bearer ${await this.mint()}` : await this.fromKubeconfig();
    this.sent = header !== undefined;
    return header;
  }

  /** A kubeconfig's bearer token only: basic-auth credentials are never forwarded to a gateway. */
  private async fromKubeconfig(): Promise<string | undefined> {
    const options: https.RequestOptions = { headers: {} };
    await this.config.applyToHTTPSOptions(options);
    const header = (options.headers as Record<string, unknown> | undefined)?.Authorization;
    return typeof header === 'string' && /^Bearer\s+\S/.test(header) ? header : undefined;
  }

  private async mint(): Promise<string> {
    if (this.minted && this.minted.expiresAt - this.now() > RENEW_BEFORE_MS) return this.minted.token;
    const { namespace, name } = parseServiceAccount(this.settings.tokenServiceAccount);
    const body = { apiVersion: 'authentication.k8s.io/v1', kind: 'TokenRequest', spec: { audiences: this.settings.tokenAudiences, expirationSeconds: TOKEN_SECONDS } };
    let text: string;
    try {
      text = await this.api.request('POST', `/api/v1/namespaces/${namespace}/serviceaccounts/${name}/token`, body);
    } catch (err) {
      throw mintFailure(err, namespace, name);
    }
    const status = (JSON.parse(text) as { status?: { token?: string } }).status;
    if (!status?.token) throw new CallerError(`The cluster returned no token for service account ${namespace}/${name}.`);
    this.minted = { token: status.token, expiresAt: this.now() + TOKEN_SECONDS * 1000 };
    return status.token;
  }
}

function mintFailure(err: unknown, namespace: string, name: string): unknown {
  if (!(err instanceof KubeError) || err.status === undefined) return err;
  const who = `service account ${namespace}/${name}`;
  const message =
    err.status === 403
      ? `Your account may not mint a token for ${who}. It needs create on serviceaccounts/token in ${namespace}.`
      : `Could not mint a token for ${who}: the cluster answered ${err.status}.`;
  return new CallerError(message, err.detail);
}

/** A KubeConfig for the forwarded gateway: its own address, and the caller's token as the only credential. */
class GatewayConfig extends KubeConfig {
  constructor(context: string, port: number, private readonly tokens: TokenSource) {
    super();
    this.loadFromOptions({
      clusters: [{ name: 'gateway', server: `http://127.0.0.1:${port}`, skipTLSVerify: false }],
      users: [{ name: 'caller' }],
      contexts: [{ name: context, cluster: 'gateway', user: 'caller' }],
      currentContext: context,
    });
  }

  override async applyToHTTPSOptions(options: https.RequestOptions): Promise<void> {
    const authorization = await this.tokens.authorization();
    if (authorization) options.headers = { ...(options.headers as Record<string, string> | undefined), Authorization: authorization };
  }
}

/** What an explanation names. */
export interface GatewayContext {
  namespace: string;
  crew: string;
  context: string;
  sentToken: boolean;
  serviceAccount?: string;
}

/**
 * A refusal by the gateway said in plain words and by what was sent: the 401 of a crew that
 * verifies who is asking, the 403 of an identity that may not use the crew, and the 404 of a
 * conversation that is not the caller's. The status is kept so a retry still tells a refusal
 * from a restart. Any other failure is returned as it came.
 */
export function explainGateway(err: unknown, where: GatewayContext): unknown {
  if (err instanceof ConnectionError) {
    return new ConnectionError(`The connection to the gateway of crew ${where.crew} (through a port-forward in context ${where.context}) failed or was cut. ${err.detail ?? ''}`.trim(), err.detail);
  }
  if (!(err instanceof KubeError) || err.status === undefined) return err;
  const message = refusalMessage(err, where);
  return message ? new KubeError(message, err.status, err.detail) : err;
}

function refusalMessage(err: KubeError, where: GatewayContext): string | undefined {
  if (err.status === 401) return unauthorizedMessage(where);
  if (err.status === 403) return `The crew ${where.crew} refused your identity. Using a crew needs get on the Crew ${where.crew} in ${where.namespace}.`;
  if (err.status === 404 && /conversation not found/i.test(err.detail ?? '')) {
    return `Conversation not found on crew ${where.crew}. It does not exist, has expired, or belongs to another caller.`;
  }
  return undefined;
}

function unauthorizedMessage(where: GatewayContext): string {
  if (where.serviceAccount) {
    return `The crew ${where.crew} did not accept the token minted for service account ${where.serviceAccount}. If the crew sets tokenAudiences, list them in the crewforge.tokenAudiences setting, and the account needs get on the Crew.`;
  }
  if (where.sentToken) {
    return `The crew ${where.crew} did not accept your Kubernetes token. It may have expired; get a fresh kubeconfig. A kubeconfig token cannot carry an audience, so for a crew that sets tokenAudiences use the crewforge.tokenServiceAccount setting.`;
  }
  return `The crew ${where.crew} requires a Kubernetes token, and your kubeconfig has none (it signs in with a client certificate). Set the crewforge.tokenServiceAccount setting to NAMESPACE/NAME of a ServiceAccount you may create tokens for.`;
}

/** What opens the pieces of a gateway connection; a test replaces them. */
export interface GatewayParts {
  tunnel: (config: KubeConfig) => PodTunnel;
}

const realParts: GatewayParts = { tunnel: (config) => new PortForward(config) };

/**
 * A client for one crew's gateway, reached over a port-forward to its pod (the
 * API server's service proxy strips the `Authorization` header). The forward opens on first
 * use and closes with `close()`. Every request carries the caller's Kubernetes token, which a
 * crew that sets `spec.discussion.access` uses to know who is asking and a crew that sets
 * nothing ignores.
 */
export class GatewayClient implements GatewayTransport {
  private opened?: Promise<{ forward: LocalForward; client: KubeClient }>;
  private readonly tokens: TokenSource;

  constructor(
    private readonly api: KubeTransport,
    private readonly config: KubeConfig,
    private readonly namespace: string,
    private readonly crew: string,
    settings: CallerSettings,
    private readonly parts: GatewayParts = realParts,
  ) {
    this.tokens = new TokenSource(api, config, settings);
    this.serviceAccount = settings.tokenServiceAccount.trim() || undefined;
  }

  private readonly serviceAccount?: string;

  async request(method: string, path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>): Promise<string> {
    const { client } = await this.open();
    return this.explained(() => client.request(method, path, body, signal, headers));
  }

  async stream(path: string, onChunk: (text: string) => void, signal: AbortSignal): Promise<void> {
    const { client } = await this.open();
    return this.explained(() => client.stream(path, onChunk, signal));
  }

  async close(): Promise<void> {
    const opened = this.opened;
    this.opened = undefined;
    if (opened) await (await opened.catch(() => undefined))?.forward.close();
  }

  private async explained<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      throw explainGateway(err, {
        namespace: this.namespace,
        crew: this.crew,
        context: this.config.getCurrentContext(),
        sentToken: this.tokens.sent,
        serviceAccount: this.serviceAccount,
      });
    }
  }

  /** Opens the forward once; a failed open is forgotten so the next call tries again. */
  private open(): Promise<{ forward: LocalForward; client: KubeClient }> {
    this.opened ??= this.openNow().catch((err: unknown) => {
      this.opened = undefined;
      throw err;
    });
    return this.opened;
  }

  private async openNow(): Promise<{ forward: LocalForward; client: KubeClient }> {
    if (this.serviceAccount) parseServiceAccount(this.serviceAccount);
    const target = await resolveTarget(this.api, this.namespace, this.crew).catch((err: unknown) => {
      throw explainForward(err, this.namespace);
    });
    const forward = await listenForward(this.parts.tunnel(this.config), this.namespace, target.pod, target.port);
    const config = new GatewayConfig(this.config.getCurrentContext(), forward.port, this.tokens);
    return { forward, client: new KubeClient(config) };
  }
}

/** A refusal to read the Service or its pods, said as what the port-forward needs. */
function explainForward(err: unknown, namespace: string): unknown {
  if (err instanceof KubeError && err.status === 403) {
    return new KubeError(`Your account may not reach the crew's gateway. The port-forward needs get on services, list on pods, and create on pods/portforward in ${namespace}.`, 403, err.detail);
  }
  return err;
}
