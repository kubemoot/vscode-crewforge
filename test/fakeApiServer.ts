import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { KubeError } from '../src/k8s/request';
import type { FakeCluster } from './fakeCluster';
import { fixture } from './fakes';
import { REQUESTS_ROUTE } from './fakeRoutes';

export interface FakeApi {
  url: string;
  kubeconfig: string;
  posts: { path: string; body: string }[];
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

/** The fixed routes: the version, the operator, and a crew's discussion gateway through the service proxy. */
function fixedRoute(method: string, url: string, body: string, posts: FakeApi['posts'], cluster?: FakeCluster): Reply | undefined {
  const route = url.split('?')[0];
  if (route === '/version') return json({ gitVersion: 'v1.31.0-fake' });
  if (route === '/apis/apps/v1/deployments' && url.includes('kubemoot-operator')) return json(OPERATOR);
  if (!cluster && route.endsWith('/apis/kubemoot.ai/v1alpha1/crews')) return json(CREWS);
  if (method === 'POST' && url.includes('/proxy/api/v1/discussions/')) {
    posts.push({ path: url, body });
    return { status: 200, body: '{"conversationId":"conv-fake"}' };
  }
  if (route.endsWith('/stream')) return { status: 200, body: fixture('turn1.sse'), type: 'text/event-stream' };
  return undefined;
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
 * FakeCluster's objects) and serves a crew's discussion gateway through the service-proxy
 * paths, answering every question with a recorded stream. Writes a kubeconfig pointing at
 * it (context "fake" unless named).
 */
export async function startFakeApi(options: FakeApiOptions = {}): Promise<FakeApi> {
  const posts: FakeApi['posts'] = [];
  const requests: string[] = [];
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
      const reply = fixedRoute(method, url, body, posts, options.cluster) ?? (options.cluster ? await clusterRoute(options.cluster, method, url, body) : { status: 404, body: 'not found' });
      res.writeHead(reply.status, { 'Content-Type': reply.type ?? 'application/json' });
      res.end(reply.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const kubeconfig = writeKubeconfig(url, options.context ?? 'fake', options.otherContexts);
  return {
    url,
    kubeconfig,
    posts,
    requests,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
