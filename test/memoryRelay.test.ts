import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KubeConfig } from '@kubernetes/client-node';
import { ConnectionError, KubeError } from '../src/k8s/request';
import type { PodTunnel } from '../src/memory/forward';
import { resolveReportTarget } from '../src/memory/operatorTarget';
import { bearerOf, explainStatus, MemoryError, MemoryRelay } from '../src/memory/relay';
import { FakeCluster } from './fakeCluster';

const where = { namespace: 'crew-demo', crew: 'demo', context: 'lab', sentToken: true };
const fixture = (name: string): Buffer => fs.readFileSync(path.join(__dirname, 'fixtures', name));

describe('explainStatus', () => {
  it('401 says whether a token was sent', () => {
    expect(explainStatus(401, 'a valid bearer token is required', where).message).toMatch(/did not accept your Kubernetes token/);
    expect(explainStatus(401, '', { ...where, sentToken: false }).message).toMatch(/needs a Kubernetes bearer token.*client certificate/);
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

  it('names the permissions the port-forward needs on a 403', async () => {
    const denied = new FakeCluster();
    denied.failures.set('/api/v1/namespaces/kubemoot/services/kubemoot-operator-report', new KubeError('x', 403));
    await expect(resolveReportTarget(denied, 'kubemoot')).rejects.toThrow(/get on services, list on pods, and create on pods\/portforward/);
  });

  it('refuses an operator namespace that is not a name', async () => {
    await expect(resolveReportTarget(new FakeCluster(), '../x')).rejects.toThrow(/not a valid Kubernetes name/);
  });
});

describe('bearerOf', () => {
  const config = (header?: string): Pick<KubeConfig, 'applyToHTTPSOptions'> => ({
    applyToHTTPSOptions: async (o) => {
      if (header) o.headers = { ...(o.headers as Record<string, string>), Authorization: header };
    },
  });

  it('gives a bearer token, and never a basic-auth password', async () => {
    expect(await bearerOf(config('Bearer abc'))).toBe('Bearer abc');
    expect(await bearerOf(config('Basic dXNlcjpwYXNz'))).toBeUndefined();
    expect(await bearerOf(config())).toBeUndefined();
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

  const relay = (timeoutMs?: number): MemoryRelay => {
    const config = { applyToHTTPSOptions: async (o: { headers?: unknown }) => { if (token) o.headers = { Authorization: token }; }, getCurrentContext: () => 'lab' } as unknown as KubeConfig;
    return new MemoryRelay(cluster(), config, 'kubemoot', { tunnel: () => tunnel }, timeoutMs);
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

  it('refuses a crew name that is not a name before opening anything', async () => {
    await expect(relay().read('crew-demo', '../x')).rejects.toThrow(/not a valid Kubernetes name/);
    expect(opened).toEqual([]);
  });
});
