import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import * as net from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { listenForward, type PodTunnel } from '../src/discussion/forward';

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

/** A pod's port: an HTTP server that answers with the request line. */
async function startPod(): Promise<number> {
  const server = http.createServer((req, res) => res.end(`pod saw ${req.method} ${req.url}`));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return (server.address() as net.AddressInfo).port;
}

/** A tunnel that connects straight to a local port, as a stand-in for the pod's port. */
class DirectTunnel extends EventEmitter implements PodTunnel {
  calls: { namespace: string; pod: string; ports: number[] }[] = [];
  closed = 0;
  constructor(private readonly podPort: number) {
    super();
  }
  async portForward(namespace: string, pod: string, ports: number[], output: Writable, _err: Writable | null, input: Readable): Promise<unknown> {
    this.calls.push({ namespace, pod, ports });
    const upstream = net.connect(this.podPort, '127.0.0.1');
    input.pipe(upstream);
    upstream.pipe(output);
    const ws = new EventEmitter() as EventEmitter & { close(): void };
    ws.close = () => {
      this.closed++;
      upstream.destroy();
    };
    upstream.on('close', () => ws.emit('close'));
    return ws;
  }
}

describe('listenForward', () => {
  it('carries a request from a local port through the tunnel to the pod', async () => {
    const tunnel = new DirectTunnel(await startPod());
    const forward = await listenForward(tunnel, 'team-a', 'gw-0', 8080);
    closers.push(() => forward.close());
    const body = await new Promise<string>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: forward.port, path: '/ping', agent: false }, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve(text));
      }).on('error', reject);
    });
    expect(body).toBe('pod saw GET /ping');
    expect(tunnel.calls).toEqual([{ namespace: 'team-a', pod: 'gw-0', ports: [8080] }]);
  });

  it('listens on loopback only, and closes the tunnel when the local connection ends', async () => {
    const tunnel = new DirectTunnel(await startPod());
    const forward = await listenForward(tunnel, 'ns', 'p', 80);
    closers.push(() => forward.close());
    const socket = net.connect(forward.port, '127.0.0.1');
    await new Promise<void>((r) => socket.once('connect', () => r()));
    await new Promise<void>((r) => setTimeout(r, 30));
    socket.destroy();
    await new Promise<void>((r) => setTimeout(r, 60));
    expect(tunnel.closed).toBe(1);
  });

  it('drops the local connection when the tunnel cannot open', async () => {
    const failing: PodTunnel = { portForward: () => Promise.reject(new Error('pods/portforward is forbidden')) };
    const forward = await listenForward(failing, 'ns', 'p', 80);
    closers.push(() => forward.close());
    const socket = net.connect(forward.port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));
    expect(socket.destroyed).toBe(true);
  });

  it('stops listening on close', async () => {
    const forward = await listenForward(new DirectTunnel(await startPod()), 'ns', 'p', 80);
    await forward.close();
    await expect(new Promise((resolve, reject) => net.connect(forward.port, '127.0.0.1').once('connect', resolve).once('error', reject))).rejects.toThrow();
  });
});
