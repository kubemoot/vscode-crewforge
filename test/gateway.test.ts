import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import * as net from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { KubeConfig } from '@kubernetes/client-node';
import { afterEach, describe, expect, it } from 'vitest';
import { ask, streamTurn } from '../src/discussion/client';
import type { PodTunnel } from '../src/discussion/forward';
import { CallerError, explainGateway, GatewayClient, parseServiceAccount, TokenSource, type CallerSettings, type GatewayContext } from '../src/discussion/gateway';
import { ConnectionError, KubeError } from '../src/k8s/request';
import { FakeTransport } from './fakes';

const NONE: CallerSettings = { tokenServiceAccount: '', tokenAudiences: [] };

/** A kubeconfig whose one user is `user` (a token, basic-auth credentials, or only a client certificate). */
function kubeconfig(user: Record<string, string>): KubeConfig {
  const config = new KubeConfig();
  config.loadFromOptions({
    clusters: [{ name: 'c', server: 'https://127.0.0.1:6443', skipTLSVerify: true }],
    users: [{ name: 'u', ...user }],
    contexts: [{ name: 'ctx', cluster: 'c', user: 'u' }],
    currentContext: 'ctx',
  });
  return config;
}

const withToken = () => kubeconfig({ token: 'kube-token' });
const withCertificate = () => kubeconfig({ certData: Buffer.from('cert').toString('base64'), keyData: Buffer.from('key').toString('base64') });
const withBasicAuth = () => kubeconfig({ username: 'nobody', password: 'secret' });

describe('parseServiceAccount', () => {
  it('splits NAMESPACE/NAME', () => {
    expect(parseServiceAccount(' ops/crew-operator ')).toEqual({ namespace: 'ops', name: 'crew-operator' });
  });
  it.each(['', 'ops', '/name', 'ops/', 'a/b/c', 'Bad NS/x'])('rejects %j', (value) => {
    expect(() => parseServiceAccount(value)).toThrow();
  });
});

describe('TokenSource', () => {
  it("sends the kubeconfig's bearer token", async () => {
    const tokens = new TokenSource(new FakeTransport(), withToken(), NONE);
    expect(await tokens.authorization()).toBe('Bearer kube-token');
    expect(tokens.sent).toBe(true);
  });

  it('sends nothing for a client-certificate kubeconfig, and never basic-auth credentials', async () => {
    for (const config of [withCertificate(), withBasicAuth()]) {
      const tokens = new TokenSource(new FakeTransport(), config, NONE);
      expect(await tokens.authorization()).toBeUndefined();
      expect(tokens.sent).toBe(false);
    }
  });

  it('mints a ten-minute token for the ServiceAccount, bound to the audiences, and reuses it until it nears its end', async () => {
    const api = new FakeTransport();
    api.responses.push(JSON.stringify({ status: { token: 'minted-1' } }), JSON.stringify({ status: { token: 'minted-2' } }));
    let now = 1_000_000;
    const tokens = new TokenSource(api, withCertificate(), { tokenServiceAccount: 'ops/crew-operator', tokenAudiences: ['gw'] }, () => now);
    expect(await tokens.authorization()).toBe('Bearer minted-1');
    expect(api.calls[0]).toEqual({
      method: 'POST',
      path: '/api/v1/namespaces/ops/serviceaccounts/crew-operator/token',
      body: { apiVersion: 'authentication.k8s.io/v1', kind: 'TokenRequest', spec: { audiences: ['gw'], expirationSeconds: 600 } },
    });
    now += 400_000;
    expect(await tokens.authorization()).toBe('Bearer minted-1');
    expect(api.calls).toHaveLength(1);
    now += 100_000;
    expect(await tokens.authorization()).toBe('Bearer minted-2');
    expect(api.calls).toHaveLength(2);
  });

  it('prefers the ServiceAccount to the kubeconfig token', async () => {
    const api = new FakeTransport();
    api.responses.push(JSON.stringify({ status: { token: 'minted' } }));
    const tokens = new TokenSource(api, withToken(), { tokenServiceAccount: 'ops/op', tokenAudiences: [] });
    expect(await tokens.authorization()).toBe('Bearer minted');
  });

  it('says what is missing when minting is refused, or returns no token', async () => {
    const api = new FakeTransport();
    const settings = { tokenServiceAccount: 'ops/op', tokenAudiences: [] };
    api.responses.push(new KubeError('forbidden', 403, 'raw'));
    await expect(new TokenSource(api, withCertificate(), settings).authorization()).rejects.toThrow(/may not mint a token for service account ops\/op.*create on serviceaccounts\/token in ops/);
    api.responses.push(new KubeError('gone', 404));
    await expect(new TokenSource(api, withCertificate(), settings).authorization()).rejects.toThrow(/answered 404/);
    api.responses.push(JSON.stringify({ status: {} }));
    await expect(new TokenSource(api, withCertificate(), settings).authorization()).rejects.toBeInstanceOf(CallerError);
  });
});

describe('explainGateway', () => {
  const where = (extra: Partial<GatewayContext> = {}): GatewayContext => ({ namespace: 'team-a', crew: 'demo', context: 'lab', sentToken: true, ...extra });
  const refused = (status: number, detail = 'no') => new KubeError('raw', status, detail);

  it('explains a 401 by what was sent', () => {
    expect((explainGateway(refused(401), where()) as KubeError).message).toMatch(/did not accept your Kubernetes token.*crewforge\.tokenServiceAccount/);
    expect((explainGateway(refused(401), where({ sentToken: false })) as KubeError).message).toMatch(/requires a Kubernetes token.*has none.*NAMESPACE\/NAME/);
    expect((explainGateway(refused(401), where({ serviceAccount: 'ops/op' })) as KubeError).message).toMatch(/minted for service account ops\/op.*crewforge\.tokenAudiences/);
  });

  it('explains a 403 and a conversation that is not the caller', () => {
    expect((explainGateway(refused(403), where()) as KubeError).message).toMatch(/refused your identity.*get on the Crew demo in team-a/);
    expect((explainGateway(refused(404, 'conversation not found'), where()) as KubeError).message).toMatch(/Conversation not found on crew demo.*belongs to another caller/);
  });

  it('keeps the status and the raw detail, so a retry still tells a refusal from a restart', () => {
    const out = explainGateway(refused(401, 'raw detail'), where()) as KubeError;
    expect(out.status).toBe(401);
    expect(out.detail).toBe('raw detail');
  });

  it('returns any other failure as it came, and says a cut connection is about the port-forward', () => {
    const other = refused(500);
    expect(explainGateway(other, where())).toBe(other);
    const notFound = refused(404, 'page not found');
    expect(explainGateway(notFound, where())).toBe(notFound);
    const plain = new Error('boom');
    expect(explainGateway(plain, where())).toBe(plain);
    const cut = explainGateway(new ConnectionError('cut', 'ECONNRESET'), where());
    expect(cut).toBeInstanceOf(ConnectionError);
    expect((cut as Error).message).toMatch(/port-forward in context lab/);
  });
});

/** A gateway that records each request's headers and answers like the discussion gateway. */
interface Seen {
  method: string;
  url: string;
  authorization?: string;
  reason?: string;
}
let gateway: http.Server;
let seen: Seen[];
let gatewayStatus: number;
const open: (() => Promise<void>)[] = [];

async function startGateway(): Promise<number> {
  seen = [];
  gatewayStatus = 200;
  gateway = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, reason: req.headers['kubemoot-access-reason'] as string | undefined });
    if (gatewayStatus !== 200) {
      res.writeHead(gatewayStatus, { 'Content-Type': 'text/plain' });
      res.end(gatewayStatus === 404 ? 'conversation not found' : 'no');
    } else if (req.method === 'POST') {
      res.end('{"conversationId":"conv-1"}');
    } else {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"type":"synthesis","content":"All good."}\n\ndata: {"type":"done"}\n\n');
    }
  });
  await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r));
  open.push(() => new Promise<void>((r) => { gateway.closeAllConnections(); gateway.close(() => r()); }));
  return (gateway.address() as net.AddressInfo).port;
}

afterEach(async () => {
  for (const c of open.splice(0)) await c();
});

class DirectTunnel extends EventEmitter implements PodTunnel {
  calls: { namespace: string; pod: string; ports: number[] }[] = [];
  constructor(private readonly port: number) {
    super();
  }
  async portForward(namespace: string, pod: string, ports: number[], output: Writable, _err: Writable | null, input: Readable): Promise<unknown> {
    this.calls.push({ namespace, pod, ports });
    const upstream = net.connect(this.port, '127.0.0.1');
    input.pipe(upstream);
    upstream.pipe(output);
    const ws = new EventEmitter() as EventEmitter & { close(): void };
    ws.close = () => upstream.destroy();
    upstream.on('close', () => ws.emit('close'));
    return ws;
  }
}

/** The API server's answers for finding the gateway: its Service and one ready pod. */
function clusterFor(api: FakeTransport): void {
  api.responses.push(
    JSON.stringify({ spec: { selector: { app: 'gw' }, ports: [{ port: 80, targetPort: 8080 }] } }),
    JSON.stringify({ items: [{ metadata: { name: 'gw-0' }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } }] }),
  );
}

async function client(config: KubeConfig, settings = NONE) {
  const api = new FakeTransport();
  const tunnel = new DirectTunnel(await startGateway());
  clusterFor(api);
  const gw = new GatewayClient(api, config, 'team-a', 'demo', settings, { tunnel: () => tunnel });
  open.push(() => gw.close());
  return { api, tunnel, gw };
}

describe('GatewayClient', () => {
  it("runs a turn through the forward and sends the kubeconfig's token with every request", async () => {
    const { tunnel, gw } = await client(withToken());
    const queued = await ask(gw, 'team-a', 'demo', 'hi');
    const events: string[] = [];
    const end = await streamTurn(gw, 'team-a', 'demo', queued, (e) => events.push(e.type), new AbortController().signal);
    expect(end).toEqual({ kind: 'done' });
    expect(events).toContain('synthesis');
    expect(seen.map((s) => `${s.method} ${s.url.split('?')[0]}`)).toEqual(['POST /api/v1/discussions/demo', 'GET /api/v1/discussions/demo/conv-1/stream']);
    expect(seen.every((s) => s.authorization === 'Bearer kube-token')).toBe(true);
    expect(tunnel.calls[0]).toEqual({ namespace: 'team-a', pod: 'gw-0', ports: [8080] });
  });

  it('sends the extra headers of a request, such as an operator\'s reason, along with the token', async () => {
    const { gw } = await client(withToken());
    await gw.request('DELETE', '/api/v1/discussions/demo/conv-1', undefined, undefined, { 'Kubemoot-Access-Reason': 'retention request' });
    await gw.request('DELETE', '/api/v1/discussions/demo/conv-2');
    expect(seen.map((s) => [s.method, s.reason, s.authorization])).toEqual([
      ['DELETE', 'retention request', 'Bearer kube-token'],
      ['DELETE', undefined, 'Bearer kube-token'],
    ]);
  });

  it('opens the forward once for many requests', async () => {
    const { api, gw } = await client(withToken());
    await ask(gw, 'team-a', 'demo', 'one');
    await ask(gw, 'team-a', 'demo', 'two');
    expect(api.calls.filter((c) => c.path.includes('/pods')).length).toBe(1);
  });

  it('sends no Authorization for a client-certificate kubeconfig, and no basic-auth password', async () => {
    for (const config of [withCertificate(), withBasicAuth()]) {
      const { gw } = await client(config);
      await ask(gw, 'team-a', 'demo', 'hi');
      expect(seen[0].authorization).toBeUndefined();
    }
  });

  it('mints a token for the ServiceAccount when the kubeconfig has none, and sends that', async () => {
    const { api, gw } = await client(withCertificate(), { tokenServiceAccount: 'ops/crew-operator', tokenAudiences: ['demo-gateway'] });
    api.responses.push(JSON.stringify({ status: { token: 'minted' } }));
    await ask(gw, 'team-a', 'demo', 'hi');
    expect(seen[0].authorization).toBe('Bearer minted');
    expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/namespaces/ops/serviceaccounts/crew-operator/token')).toBe(true);
  });

  it.each([
    [401, withCertificate, /requires a Kubernetes token.*has none/],
    [401, withToken, /did not accept your Kubernetes token/],
    [403, withToken, /refused your identity/],
    [404, withToken, /Conversation not found on crew demo/],
  ])('says what a %i means', async (status, config, message) => {
    const { gw } = await client(config());
    gatewayStatus = status;
    const err = await ask(gw, 'team-a', 'demo', 'hi').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KubeError);
    expect((err as KubeError).message).toMatch(message);
    expect((err as KubeError).status).toBe(status);
    expect(JSON.stringify(err)).not.toContain('kube-token');
  });

  it('tries again after a failed open, and says what a refused port-forward needs', async () => {
    const api = new FakeTransport();
    api.responses.push(new KubeError('forbidden', 403));
    const gw = new GatewayClient(api, withToken(), 'team-a', 'demo', NONE, { tunnel: () => new DirectTunnel(0) });
    await expect(gw.request('GET', '/x')).rejects.toThrow(/port-forward needs get on services, list on pods, and create on pods\/portforward in team-a/);
    api.responses.push(new KubeError('missing', 404));
    await expect(gw.request('GET', '/x')).rejects.toThrow(/no discussion service demo-discussion/);
  });

  it('rejects a malformed service account setting before opening anything', async () => {
    const api = new FakeTransport();
    const gw = new GatewayClient(api, withCertificate(), 'team-a', 'demo', { tokenServiceAccount: 'no-slash', tokenAudiences: [] }, { tunnel: () => new DirectTunnel(0) });
    await expect(gw.request('GET', '/x')).rejects.toThrow(/NAMESPACE\/NAME/);
    expect(api.calls).toHaveLength(0);
  });

  it('closes the forward, and closing twice is harmless', async () => {
    const { gw } = await client(withToken());
    await ask(gw, 'team-a', 'demo', 'hi');
    await gw.close();
    await gw.close();
  });
});
