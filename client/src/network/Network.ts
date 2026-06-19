import type { ServerMessage, ClientMessage } from '@shared/types';

type Handler<T extends ServerMessage> = (data: T) => void;

/**
 * Typed WebSocket wrapper.
 *
 * net.on('player_move', ({ id, x, y, angle }) => { ... });
 * net.send({ type: 'move', x, y, angle });
 */
export class Network {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Handler<ServerMessage>>();
  connected = false;

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.connected = true;
        resolve();
      };

      this.ws.onerror = () => reject(new Error(`WebSocket error connecting to ${url}`));

      this.ws.onclose = () => {
        this.connected = false;
        this.emit('disconnect' as ServerMessage['type'], undefined as unknown as ServerMessage);
      };

      this.ws.onmessage = ({ data }: MessageEvent<string>) => {
        try {
          const msg = JSON.parse(data) as ServerMessage;
          this.emit(msg.type, msg);
        } catch {
          console.warn('[Network] Unparseable message', data);
        }
      };
    });
  }

  on<K extends ServerMessage['type']>(
    type: K,
    handler: Handler<Extract<ServerMessage, { type: K }>>,
  ): this {
    this.handlers.set(type, handler as Handler<ServerMessage>);
    return this;
  }

  onDisconnect(handler: () => void): this {
    this.handlers.set('disconnect', handler as unknown as Handler<ServerMessage>);
    return this;
  }

  send(data: ClientMessage): void {
    if (this.connected && this.ws) {
      this.ws.send(JSON.stringify(data));
    }
  }

  disconnect(): void {
    this.ws?.close();
  }

  private emit(type: ServerMessage['type'], data: ServerMessage): void {
    this.handlers.get(type)?.(data);
  }
}
