// The slice of the `ws` package the fake API server uses to answer a port-forward. `ws`
// arrives with the Kubernetes client, which speaks WebSocket to the API server.
declare module 'ws' {
  import type { IncomingMessage } from 'node:http';
  import type { Duplex } from 'node:stream';

  export class WebSocket {
    send(data: Buffer): void;
    close(): void;
    terminate(): void;
    on(event: 'message', listener: (data: Buffer) => void): this;
    on(event: 'close', listener: () => void): this;
  }

  export class WebSocketServer {
    constructor(options: { noServer: true; handleProtocols?: (protocols: Set<string>) => string | false });
    readonly clients: Set<WebSocket>;
    on(event: 'connection', listener: (socket: WebSocket, request: IncomingMessage) => void): this;
    emit(event: 'connection', socket: WebSocket, request: IncomingMessage): boolean;
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, callback: (socket: WebSocket) => void): void;
  }
}
