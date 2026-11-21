import * as net from 'node:net';
import type { Readable, Writable } from 'node:stream';

/** What opens a tunnel to a pod's port: the Kubernetes client's PortForward, or a fake in a test. */
export interface PodTunnel {
  portForward(namespace: string, pod: string, ports: number[], output: Writable, err: Writable | null, input: Readable): Promise<unknown>;
}

/** A local port that reaches a pod's port. */
export interface LocalForward {
  port: number;
  close(): Promise<void>;
}

interface Closable {
  on(event: 'close', listener: () => void): unknown;
  close(): void;
}

function isClosable(value: unknown): value is Closable {
  return typeof value === 'object' && value !== null && typeof (value as Closable).on === 'function' && typeof (value as Closable).close === 'function';
}

/**
 * Listens on a free port of 127.0.0.1 and tunnels each connection to the pod's port, as
 * `kubectl port-forward` does, with the credentials of the kubeconfig the tunnel was made from.
 */
export async function listenForward(tunnel: PodTunnel, namespace: string, pod: string, port: number): Promise<LocalForward> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    tunnel.portForward(namespace, pod, [port], socket, null, socket).then(
      (opened) => joinLifetimes(socket, opened),
      () => socket.destroy(),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

function joinLifetimes(socket: net.Socket, tunnel: unknown): void {
  if (!isClosable(tunnel)) return;
  tunnel.on('close', () => socket.end());
  if (socket.destroyed) tunnel.close();
  else socket.on('close', () => tunnel.close());
}
