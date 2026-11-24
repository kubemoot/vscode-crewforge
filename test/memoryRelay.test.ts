import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KubeConfig } from '@kubernetes/client-node';
import { ConnectionError, KubeError, ResponseTooLargeError, type BinaryResponse } from '../src/k8s/request';
import type { PodTunnel } from '../src/discussion/forward';
import { resolveReportTarget } from '../src/memory/operatorTarget';
import { explainStatus, MemoryError, MemoryRelay } from '../src/memory/relay';
import { FakeCluster } from './fakeCluster';

const where = { namespace: 'crew-demo', crew: 'demo', context: 'lab', sentToken: true };
const fixture = (name: string): Buffer => fs.readFileSync(path.join(__dirname, 'fixtures', name));

describe('explainStatus', () => {
  it('401 says whether a token was sent', () => {
    expect(explainStatus(401, 'a valid bearer token is required', where).message).toMatch(/did not accept your Kubernetes token/);
    expect(explainStatus(401, '', { ...where, sentToken: false }).message).toMatch(/needs a Kubernetes bearer token.*client certificate/);
  });

  it('401 for a minted token names the service account', () => {
    expect(explainStatus(401, '', { ...where, serviceAccount: 'ops/crewforge' }).message).toMatch(/token minted for service account ops\/crewforge.*get on the Crew demo/);
  });

  it('403 names the permission', () => {
    const err = explainStatus(403, 'the caller may not read this resource', where);
    expect(err.message).toBe('Reading the memory of crew demo needs get on the Crew demo (kubemoot.ai crews) in namespace crew-demo. Your account does not have it.');
    expect(err.status).toBe(403);
  });

  it('404 from an operator without the endpoint says it is too old', () => {
    expect(explainStatus(404, '404 page not found\n', where).message).toMatch(/too old to export crew memory/);
  });

  it('any other 404 says nothing was found for the crew', () => {
    expect(explainStatus(404, 'no such crew', where).message).toMatch(/found no memory export for crew demo in namespace crew-demo/);
  });

  it('503 and 502 say what to check', () => {
    expect(explainStatus(503, 'could not check the caller\'s access', where).message).toMatch(/cannot serve the memory export right now \(503: could not check/);
    expect(explainStatus(502, 'crew memory is not reachable', where).message).toMatch(/could not reach the crew memory store \(crew memory is not reachable\).*NATS/);
  });

  it('other statuses carry the status and the server words', () => {
    expect(explainStatus(400, 'bad name', where).message).toBe('The operator refused the memory export (400: bad name).');
  });
});

describe('resolveReportTarget', () => {
  const service = { spec: { selector: { app: 'op' }, ports: [{ port: 8082, targetPort: 'report' }] } };
  const pod = (name: string, ready: boolean) => ({ metadata: { name }, spec: { containers: [{ ports: [{ name: 'report', containerPort: 9082 }] }] }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }] } });

  function cluster(items: unknown[], svc: unknown = service): FakeCluster {
    const c = new FakeCluster();
    c.bodies.set('/api/v1/namespaces/kubemoot/services/kubemoot-operator-report', JSON.stringify(svc));
    c.bodies.set('/api/v1/namespaces/kubemoot/pods?labelSelector=app%3Dop', JSON.stringify({ items }));
    return c;
  }

  it('picks a ready pod and resolves a named target port', async () => {
    expect(await resolveReportTarget(cluster([pod('a', false), pod('b', true)]), 'kubemoot')).toEqual({ pod: 'b', port: 9082 });
  });

  it('uses a numeric target port', async () => {
    const c = cluster([pod('a', true)], { spec: { selector: { app: 'op' }, ports: [{ port: 8082, targetPort: 8083 }] } });
    expect((await resolveReportTarget(c, 'kubemoot')).port).toBe(8083);
  });

  it('says so when the Service is missing, has no selector, or has no ready pod', async () => {
    const missing = new FakeCluster();
    missing.failures.set('/api/v1/namespaces/kubemoot/services/kubemoot-operator-report', new KubeError('x', 404));
    await expect(resolveReportTarget(missing, 'kubemoot')).rejects.toThrow(/report service kubemoot\/kubemoot-operator-report was not found.*crewforge.operatorNamespace/);
    await expect(resolveReportTarget(cluster([], { spec: {} }), 'kubemoot')).rejects.toThrow(/selects no pods/);
    await expect(resolveReportTarget(cluster([pod('a', false)]), 'kubemoot')).rejects.toThrow(/no ready pod/);
  });

  it('says so when the pods cannot be listed', async () => {
    const c = cluster([]);
    c.failures.set('/api/v1/namespaces/kubemoot/pods?labelSelector=app%3Dop', new KubeError('x', 404));
    await expect(resolveReportTarget(c, 'kubemoot')).rejects.toThrow(/Could not list the pods behind kubemoot\/kubemoot-operator-report/);
  });

  it('refuses an operator namespace that is not a name', async () => {
    await expect(resolveReportTarget(new FakeCluster(), '../x')).rejects.toThrow(/not a valid Kubernetes name/);
  });
});

describe('MemoryRelay', () => {
  let server: http.Server;
  let seen: { url?: string; authorization?: string }[];
  let respond: (url: string) => { status: number; body: Buffer | string };
  let opened: { pod: string; port: number }[];
  let token: string | undefined;

  const tunnel: PodTunnel = {
    async portForward(_ns: string, pod: string, ports: number[], output: Writable, _err: Writable | null, input: Readable) {
      opened.push({ pod, port: ports[0] });
      const upstream = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1');
      input.pipe(upstream);
      upstream.pipe(output);
      return { on: (_e: string, l: () => void) => upstream.on('close', l), close: () => upstream.destroy() };
    },
  };

  const cluster = (): FakeCluster => {
    const c = new FakeCluster();
    c.bodies.set('/api/v1/namespaces/kubemoot/services/kubemoot-operator-report', JSON.stringify({ spec: { selector: { app: 'op' }, ports: [{ port: 8082, targetPort: 8082 }] } }));
    c.bodies.set('/api/v1/namespaces/kubemoot/pods?labelSelector=app%3Dop', JSON.stringify({ items: [{ metadata: { name: 'op-1' }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } }] }));
    return c;
  };

  const relay = (timeoutMs?: number, settings?: { tokenServiceAccount: string; tokenAudiences: string[] }, api: FakeCluster = cluster(), maxBytes?: number): MemoryRelay => {
    const config = { applyToHTTPSOptions: async (o: { headers?: unknown }) => { if (token) o.headers = { Authorization: token }; }, getCurrentContext: () => 'lab' } as unknown as KubeConfig;
    return new MemoryRelay(api, config, 'kubemoot', { tunnel: () => tunnel }, timeoutMs, settings, maxBytes);
  };

  beforeEach(async () => {
    seen = [];
    opened = [];
    token = 'Bearer secret-token';
    respond = (url) => (url.endsWith('report=true') ? { status: 200, body: fixture('memory-report.json') } : { status: 200, body: fixture('memory-export.zip') });
    server = http.createServer((req, res) => {
      seen.push({ url: req.url, authorization: req.headers.authorization });
      const r = respond(req.url ?? '');
      res.writeHead(r.status);
      res.end(r.body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(() => {
    server.closeAllConnections();
    server.close();
  });

  it('reads the export and the report through the forward with the caller token', async () => {
    const read = await relay().read('crew-demo', 'demo');
    expect(read.parsed.facts).toHaveLength(3);
    expect(read.report?.leftOut).toHaveLength(3);
    expect(read.zip.subarray(0, 2).toString()).toBe('PK');
    expect(opened).toEqual([{ pod: 'op-1', port: 8082 }]);
    expect(seen.map((s) => s.url)).toEqual(['/memory-export/crew-demo/demo', '/memory-export/crew-demo/demo?report=true']);
    expect(seen.every((s) => s.authorization === 'Bearer secret-token')).toBe(true);
  });

  it('sends no Authorization header when the kubeconfig has no bearer token', async () => {
    token = undefined;
    await relay().read('crew-demo', 'demo');
    expect(seen.every((s) => s.authorization === undefined)).toBe(true);
  });

  it('never puts the token in an error', async () => {
    respond = () => ({ status: 401, body: 'a valid bearer token is required' });
    const err = (await relay().read('crew-demo', 'demo').catch((e: unknown) => e)) as MemoryError;
    expect(err).toBeInstanceOf(MemoryError);
    expect(`${err.message} ${err.detail}`).not.toContain('secret-token');
    expect(err.message).toMatch(/did not accept your Kubernetes token/);
  });

  it.each([
    [403, 'denied', /needs get on the Crew demo/],
    [404, '404 page not found\n', /too old/],
    [503, 'no authorizer', /cannot serve the memory export/],
  ])('maps a %i to its message', async (status, body, message) => {
    respond = () => ({ status, body });
    await expect(relay().read('crew-demo', 'demo')).rejects.toThrow(message);
  });

  it('tolerates a report it cannot read', async () => {
    respond = (url) => (url.endsWith('report=true') ? { status: 200, body: 'nope' } : { status: 200, body: fixture('memory-export.zip') });
    expect((await relay().read('crew-demo', 'demo')).report).toBeUndefined();
  });

  it('reports a cut connection as a connection error naming the context', async () => {
    respond = () => ({ status: 200, body: 'x' });
    server.close();
    server.closeAllConnections();
    const err = await relay().read('crew-demo', 'demo').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as Error).message).toMatch(/Kubemoot operator.*context lab/);
  });

  it('names the port-forward permissions when the account may not read the report service', async () => {
    const denied = cluster();
    denied.failures.set('/api/v1/namespaces/kubemoot/services/kubemoot-operator-report', new KubeError('x', 403));
    await expect(relay(undefined, undefined, denied).read('crew-demo', 'demo')).rejects.toThrow(/get on services, list on pods, and create on pods\/portforward in kubemoot/);
    const broken = cluster();
    broken.failures.set('/api/v1/namespaces/kubemoot/services/kubemoot-operator-report', new KubeError('boom', 500));
    await expect(relay(undefined, undefined, broken).read('crew-demo', 'demo')).rejects.toThrow('boom');
  });

  it('sends a minted token for a certificate kubeconfig, as the chat does', async () => {
    token = undefined;
    const api = cluster();
    const mint = api.request.bind(api);
    api.request = async (method, p, body) => {
      if (method !== 'POST') return mint(method, p, body);
      api.calls.push({ method, path: p, body });
      return JSON.stringify({ status: { token: 'minted-token' } });
    };
    await relay(undefined, { tokenServiceAccount: 'ops/crewforge', tokenAudiences: ['kubemoot'] }, api).read('crew-demo', 'demo');
    expect(api.calls.find((c) => c.method === 'POST')?.path).toBe('/api/v1/namespaces/ops/serviceaccounts/crewforge/token');
    expect(seen.every((s) => s.authorization === 'Bearer minted-token')).toBe(true);
  });

  it('says what is missing when the token cannot be minted', async () => {
    const api = cluster();
    const mint = api.request.bind(api);
    api.request = async (method, p, body) => {
      if (method === 'POST') throw new KubeError('forbidden', 403);
      return mint(method, p, body);
    };
    await expect(relay(undefined, { tokenServiceAccount: 'ops/crewforge', tokenAudiences: [] }, api).read('crew-demo', 'demo')).rejects.toThrow(/create on serviceaccounts\/token in ops/);
  });

  it('gives up on a response larger than the limit', async () => {
    const err = await relay(undefined, undefined, cluster(), 100).read('crew-demo', 'demo').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as Error).message).toMatch(/too large/);
  });

  it('gives up when the operator does not answer in time', async () => {
    server.removeAllListeners('request');
    server.on('request', () => undefined);
    const err = await relay(100).read('crew-demo', 'demo').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as Error).message).toMatch(/no response in 0.1 s/);
  });

  it('opens the real Kubernetes port-forward by default, and reports a tunnel that fails as a cut connection', async () => {
    const config = { applyToHTTPSOptions: async () => undefined, getCurrentContext: () => 'lab', getCurrentCluster: () => ({ server: 'https://127.0.0.1:1' }) } as unknown as KubeConfig;
    const err = await new MemoryRelay(cluster(), config, 'kubemoot', undefined, 2000).read('crew-demo', 'demo').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionError);
  });

  it('refuses a crew name that is not a name before opening anything', async () => {
    await expect(relay().read('crew-demo', '../x')).rejects.toThrow(/not a valid Kubernetes name/);
    expect(opened).toEqual([]);
  });
});

/** A cluster that serves binary reads, as the real client does, with the report API answering where asked. */
class BinaryCluster extends FakeCluster {
  binaries = new Map<string, BinaryResponse>();
  binaryCalls: { path: string; headers?: Record<string, string> }[] = [];
  failBinary?: Error;
  async requestBinary(path: string, _max: number, headers?: Record<string, string>): Promise<BinaryResponse> {
    this.binaryCalls.push({ path, headers });
    if (this.failBinary && path.includes('memory-export')) throw this.failBinary;
    return this.binaries.get(path) ?? { status: 404, body: Buffer.from('404 page not found') };
  }
}

describe('MemoryRelay through the API server', () => {
  const reports = '/apis/reports.kubemoot.ai/v1alpha1';
  const discovery = JSON.stringify({ kind: 'APIResourceList', groupVersion: 'reports.kubemoot.ai/v1alpha1', resources: [] });
  const base = `${reports}/namespaces/crew-demo/crews/demo/memory-export`;
  const config = { getCurrentContext: () => 'lab' } as unknown as KubeConfig;
  const noTunnel = { tunnel: () => { throw new Error('the port-forward must not be opened'); } };
  const portForward = /services\/kubemoot-operator-report/;

  function served(): BinaryCluster {
    const c = new BinaryCluster();
    c.binaries.set(reports, { status: 200, body: Buffer.from(discovery) });
    c.binaries.set(base, { status: 200, body: fixture('memory-export.zip') });
    c.binaries.set(`${base}?report=true`, { status: 200, body: fixture('memory-report.json') });
    return c;
  }
  const read = (c: FakeCluster, settings?: { tokenServiceAccount: string; tokenAudiences: string[] }) =>
    new MemoryRelay(c, config, 'kubemoot', noTunnel, undefined, settings).read('crew-demo', 'demo');

  it('reads the export with the kubeconfig credentials, with no port-forward and no token', async () => {
    const c = served();
    const got = await read(c);
    expect(got.parsed.facts).toHaveLength(3);
    expect(got.report?.leftOut).toHaveLength(3);
    expect(c.binaryCalls.map((b) => b.path)).toEqual([reports, base, `${base}?report=true`]);
    expect(c.binaryCalls[1].headers?.Accept).toMatch(/application\/zip/);
    expect(c.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it.each([404, 503])('falls back to the port-forward, asking discovery once, when the report API answers %i', async (status) => {
    const c = served();
    c.binaries.set(reports, { status, body: Buffer.from('{"kind":"Status"}') });
    await expect(read(c)).rejects.toThrow(portForward);
    expect(c.binaryCalls.map((b) => b.path)).toEqual([reports]);
  });

  it('does not hide a refusal of the credentials behind a fallback', async () => {
    const c = served();
    c.binaries.set(reports, { status: 401, body: Buffer.from('Unauthorized') });
    const err = (await read(c).catch((e: unknown) => e)) as MemoryError;
    expect(err).toBeInstanceOf(MemoryError);
    expect(err.message).toMatch(/did not accept your credentials/);
    expect(err.needsToken).toBe(false);
  });

  it('says so when the API server refuses the discovery for lack of rights', async () => {
    const c = served();
    c.binaries.set(reports, { status: 500, body: Buffer.from('boom') });
    await expect(read(c)).rejects.toThrow(/refused the memory export \(500: boom\)/);
  });

  it('keeps the port-forward when the settings ask for a minted ServiceAccount token', async () => {
    const c = served();
    await expect(read(c, { tokenServiceAccount: 'ops/crewforge', tokenAudiences: [] })).rejects.toThrow(portForward);
    expect(c.binaryCalls).toHaveLength(0);
  });

  it('keeps the port-forward for a transport that reads no binary', async () => {
    const c = new FakeCluster();
    await expect(read(c)).rejects.toThrow(portForward);
    expect(c.calls.some((call) => call.path.startsWith('/apis/reports.kubemoot.ai'))).toBe(false);
  });

  it.each([['another group', JSON.stringify({ groupVersion: 'other/v1' })], ['no JSON', '<html>']])('uses the port-forward for %s as discovery', async (_n, body) => {
    const c = served();
    c.binaries.set(reports, { status: 200, body: Buffer.from(body) });
    await expect(read(c)).rejects.toThrow(portForward);
    expect(c.binaryCalls).toHaveLength(1);
  });

  it.each([
    [401, /cluster did not accept your credentials for the Kubemoot report API \(context lab\)/],
    [403, /get on crews\/memory-export in the reports.kubemoot.ai group.*reports-api ClusterRole/],
    [404, /found no memory export for crew demo/],
    [503, /cannot serve the memory export right now/],
  ])('explains a %i of the data path in its own words', async (status, message) => {
    const c = served();
    c.binaries.set(base, { status, body: Buffer.from('refused') });
    await expect(read(c)).rejects.toThrow(message);
  });

  it('explains a failed report fetch after the zip arrived', async () => {
    const c = served();
    c.binaries.set(`${base}?report=true`, { status: 503, body: Buffer.from('later') });
    await expect(read(c)).rejects.toThrow(/cannot serve the memory export right now/);
  });

  it('names the export when it is larger than the limit', async () => {
    const c = served();
    c.failBinary = new ResponseTooLargeError(10);
    await expect(read(c)).rejects.toThrow('The memory export is too large.');
  });
});
