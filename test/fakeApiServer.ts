import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fixture } from './fakes';

export interface FakeApi {
  url: string;
  kubeconfig: string;
  posts: { path: string; body: string }[];
  close(): Promise<void>;
}

const CREWS = {
  items: [
    { metadata: { name: 'lab-ops', namespace: 'team-a' }, status: { ready: true, phase: 'Ready', agentCount: 2, coordinatorRef: 'lab-ops-coordinator' } },
    { metadata: { name: 'quiz', namespace: 'team-b' }, status: { ready: false, phase: 'Deploying' } },
  ],
};

/**
 * A local stand-in for the Kubernetes API server: lists Crews and serves a crew's
 * discussion gateway through the service-proxy paths, answering every question with a
 * recorded stream. Writes a kubeconfig pointing at it (context "fake").
 */
export async function startFakeApi(): Promise<FakeApi> {
  const posts: { path: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = req.url ?? '';
      if (url.endsWith('/apis/kubemoot.ai/v1alpha1/crews')) {
        res.setHeader('Content-Type', 'application/json');
        return void res.end(JSON.stringify(CREWS));
      }
      if (req.method === 'POST' && url.includes('/proxy/api/v1/discussions/')) {
        posts.push({ path: url, body });
        return void res.end('{"conversationId":"conv-fake"}');
      }
      if (url.endsWith('/stream')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        return void res.end(fixture('turn1.sse'));
      }
      res.writeHead(404);
      res.end('not found');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewforge-api-'));
  const kubeconfig = path.join(dir, 'config');
  fs.writeFileSync(
    kubeconfig,
    [
      'apiVersion: v1',
      'kind: Config',
      'clusters:',
      `- name: fake\n  cluster:\n    server: ${url}\n    insecure-skip-tls-verify: true`,
      'users:',
      '- name: fake\n  user:\n    token: t',
      'contexts:',
      '- name: fake\n  context:\n    cluster: fake\n    user: fake',
      'current-context: fake',
    ].join('\n'),
  );
  return { url, kubeconfig, posts, close: () => new Promise((r) => server.close(() => r())) };
}
