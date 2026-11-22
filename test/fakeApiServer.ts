import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocketServer } from 'ws';
import { KubeError } from '../src/k8s/request';
import type { FakeCluster } from './fakeCluster';
import { fixture } from './fakes';
import { REQUESTS_ROUTE } from './fakeRoutes';

export interface FakeApi {
  url: string;
  kubeconfig: string;
  posts: { path: string; body: string }[];
  /** What the crew's gateway received, with the Authorization header each request carried. */
  gatewayRequests: { method: string; path: string; authorization?: string }[];
  /** Every request, as `METHOD path`. */
  requests: string[];
  close(): Promise<void>;
}

export interface FakeApiOptions {
  /** Answers the Kubemoot group (discovery, lists, gets, writes) from this cluster instead of the two fixed crews. */
  cluster?: FakeCluster;
  /** The kubeconfig's context name; "fake" by default. */
  context?: string;
  /** More contexts in the kubeconfig, each pointing at its own server, such as one nobody answers. */
  otherContexts?: { name: string; server: string }[];
}

const CREWS = {
  items: [
    { metadata: { name: 'lab-ops', namespace: 'team-a' }, status: { ready: true, phase: 'Ready', agentCount: 2, coordinatorRef: 'lab-ops-coordinator' } },
    { metadata: { name: 'quiz', namespace: 'team-b' }, status: { ready: false, phase: 'Deploying' } },
  ],
};

const OPERATOR = {
  items: [
    {
      metadata: { name: 'kubemoot-operator', namespace: 'kubemoot', labels: { 'helm.sh/chart': 'kubemoot-0.300.0' } },
      spec: { template: { spec: { containers: [{ name: 'manager', image: 'harbor.example/kubemoot/operator:0.300.0' }] } } },
    },
  ],
};

type Reply = { status: number; body: string; type?: string };

const json = (value: unknown, status = 200): Reply => ({ status, body: JSON.stringify(value) });

/** The fixed routes: the version, the operator, and the Service and pod a port-forward to a crew's gateway resolves. */
function fixedRoute(method: string, url: string, cluster?: FakeCluster): Reply | undefined {
  const route = url.split('?')[0];
  if (route === '/version') return json({ gitVersion: 'v1.31.0-fake' });
  if (route === '/apis/apps/v1/deployments' && url.includes('kubemoot-operator')) return json(OPERATOR);
  if (!cluster && route.endsWith('/apis/kubemoot.ai/v1alpha1/crews')) return json(CREWS);
  const gateway = /^\/api\/v1\/namespaces\/[^/]+\/(services\/[^/]+-discussion|pods)$/.exec(route);
  if (method === 'GET' && gateway) return json(gateway[1] === 'pods' ? GATEWAY_PODS : GATEWAY_SERVICE);
  return undefined;
}

const GATEWAY_SERVICE = { spec: { selector: { app: 'gw' }, ports: [{ port: 80, targetPort: 8080 }] } };
const GATEWAY_PODS = { items: [{ metadata: { name: 'gw-0' }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } }] };

/** A crew's gateway: answers every question with a recorded stream, and records what it received. */
function gatewayServer(posts: FakeApi['posts'], received: FakeApi['gatewayRequests']): http.Server {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = req.url ?? '';
      received.push({ method: req.method ?? '', path: url, authorization: req.headers.authorization });
      if (req.method === 'POST') {
        posts.push({ path: url, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"conversationId":"conv-fake"}');
      } else if (url.split('?')[0].endsWith('/events')) {
        // The crew's conversation events carry no turn data; like the real gateway, hold the stream open until the client leaves.
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': connected\n\n');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(fixture('turn1.sse'));
      }
    });
  });
}

/**
 * Answers a pod's port-forward (WebSocket, protocol v4.channel.k8s.io) by carrying its data
 * channel to a local port, as the kubelet does.
 */
function portForwardServer(gatewayPort: () => number): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has('v4.channel.k8s.io') ? 'v4.channel.k8s.io' : false) });
  wss.on('connection', (ws) => {
    const upstream = net.connect(gatewayPort(), '127.0.0.1');
    const port = Buffer.from([80, 0]);
    ws.send(Buffer.concat([Buffer.from([0]), port]));
    ws.send(Buffer.concat([Buffer.from([1]), port]));
    ws.on('message', (data: Buffer) => data[0] === 0 && upstream.write(data.subarray(1)));
    upstream.on('data', (chunk) => ws.send(Buffer.concat([Buffer.from([0]), chunk])));
    upstream.on('close', () => ws.close());
    ws.on('close', () => upstream.destroy());
    upstream.on('error', () => ws.close());
  });
  return wss;
}

/** The path the cluster answers for a request: a Kubemoot group path, or a ConfigMap list with its label selector; undefined for anything else. */
function clusterPath(route: string, url: string): string | undefined {
  if (route.startsWith('/apis/kubemoot.ai/')) return route;
  return /^\/api\/v1\/namespaces\/[^/]+\/configmaps$/.test(route) ? url : undefined;
}

/** A Kubemoot group request answered by the cluster, or a GET of a path the cluster has a body for (a service proxy path), with a Kubernetes Status body on failure. */
async function clusterRoute(cluster: FakeCluster, method: string, url: string, body: string): Promise<Reply> {
  const route = url.split('?')[0];
  const proxied = method === 'GET' ? cluster.bodies.get(route) : undefined;
  if (proxied !== undefined) return { status: 200, body: proxied };
  const asked = clusterPath(route, url);
  if (!asked) return json({ kind: 'Status', message: `the fake API server has no ${route}` }, 404);
  try {
    return { status: 200, body: await cluster.request(method, asked, body ? JSON.parse(body) : undefined) };
  } catch (err) {
    const status = err instanceof KubeError && err.status ? err.status : 404;
    return json({ kind: 'Status', message: err instanceof Error ? err.message : String(err) }, status);
  }
}

function writeKubeconfig(url: string, context: string, others: { name: string; server: string }[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-api-'));
  const kubeconfig = path.join(dir, 'config');
  const all = [{ name: context, server: url }, ...others];
  fs.writeFileSync(
    kubeconfig,
    [
      'apiVersion: v1',
      'kind: Config',
      'clusters:',
      ...all.map((c) => `- name: ${c.name}\n  cluster:\n    server: ${c.server}\n    insecure-skip-tls-verify: true`),
      'users:',
      ...all.map((c) => `- name: ${c.name}\n  user:\n    token: t`),
      'contexts:',
      ...all.map((c) => `- name: ${c.name}\n  context:\n    cluster: ${c.name}\n    user: ${c.name}`),
      `current-context: ${context}`,
    ].join('\n'),
  );
  return kubeconfig;
}

/**
 * A local stand-in for the Kubernetes API server: lists Crews (two fixed ones, or a whole
 * FakeCluster's objects) and serves a crew's gateway over a port-forward,
 * answering every question with a recorded stream. Writes a kubeconfig pointing at
 * it (context "fake" unless named).
 */
export async function startFakeApi(options: FakeApiOptions = {}): Promise<FakeApi> {
  const posts: FakeApi['posts'] = [];
  const gatewayRequests: FakeApi['gatewayRequests'] = [];
  const requests: string[] = [];
  const gateway = gatewayServer(posts, gatewayRequests);
  await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r));
  const forwards = portForwardServer(() => (gateway.address() as AddressInfo).port);
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const url = req.url ?? '';
      const method = req.method ?? 'GET';
      if (url === REQUESTS_ROUTE) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(requests));
        return;
      }
      requests.push(`${method} ${url}`);
      const reply = fixedRoute(method, url, options.cluster) ?? (options.cluster ? await clusterRoute(options.cluster, method, url, body) : { status: 404, body: 'not found' });
      res.writeHead(reply.status, { 'Content-Type': reply.type ?? 'application/json' });
      res.end(reply.body);
    });
  });
  server.on('upgrade', (req, socket, head) => {
    requests.push(`${req.method} ${req.url}`);
    if (!/\/pods\/[^/]+\/portforward\?/.test(req.url ?? '')) {
      socket.destroy();
      return;
    }
    forwards.handleUpgrade(req, socket, head, (ws) => forwards.emit('connection', ws, req));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const kubeconfig = writeKubeconfig(url, options.context ?? 'fake', options.otherContexts);
  return {
    url,
    kubeconfig,
    posts,
    gatewayRequests,
    requests,
    close: () =>
      new Promise((r) => {
        for (const ws of forwards.clients) ws.terminate();
        gateway.closeAllConnections();
        gateway.close();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
