import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

// A minimal RFC 6455 SERVER endpoint (MOTIR-6938).
//
// Why hand-written rather than `ws`: `@motir/cli` is published to npm and
// installed on laptops, and `docs/decisions/agent-terminal.md` Q4 keeps
// `commander` its ONLY runtime dependency. Node has a WebSocket CLIENT built in
// but no server, and bundling `ws` into an ESM bin means shimming its CommonJS
// `require`s. The server needs a small, fixed subset — one text/binary message
// stream, ping/pong and the close handshake, no extensions, no subprotocols —
// and writing that subset keeps every byte path in code this package owns,
// which matters for a server whose promise is that no frame reaches a log.
//
// What it does NOT do: permessage-deflate (never negotiated — the handshake
// answers without `Sec-WebSocket-Extensions`, so a compliant client never sends
// RSV1), subprotocols, or client mode.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** The largest message accepted from a client; a larger one closes with 1009. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/**
 * Answer an HTTP upgrade with a refusal and end the socket. Only a status line
 * and no body the caller supplies, so nothing from the request is echoed.
 */
export function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Is this request a well-formed WebSocket upgrade (RFC 6455 §4.2.1)? */
export function isWebSocketUpgrade(req: IncomingMessage): boolean {
  const upgrade = req.headers.upgrade;
  const key = req.headers['sec-websocket-key'];
  return (
    req.method === 'GET' &&
    typeof upgrade === 'string' &&
    upgrade.toLowerCase() === 'websocket' &&
    typeof key === 'string' &&
    Buffer.from(key, 'base64').length === 16 &&
    req.headers['sec-websocket-version'] === '13'
  );
}

export interface WebSocketEvents {
  message: [data: Buffer, isBinary: boolean];
  close: [code: number];
}

/**
 * One accepted server-side connection. Emits `message` per complete message
 * and `close` exactly once, whoever closed it.
 */
export class WebSocketConnection extends EventEmitter<WebSocketEvents> {
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentOpcode: number | null = null;
  private closed = false;
  private closeSent = false;
  /** Set on a protocol violation: nothing more is read from the peer. */
  private failed = false;

  constructor(private readonly socket: Duplex) {
    super();
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => this.finish(1006));
    socket.on('error', () => this.finish(1006));
  }

  /** True until the connection has closed. */
  get isOpen(): boolean {
    return !this.closed;
  }

  send(data: Buffer | string): void {
    if (this.closed || this.closeSent) return;
    const binary = typeof data !== 'string';
    this.writeFrame(binary ? OP_BINARY : OP_TEXT, binary ? data : Buffer.from(data, 'utf8'));
  }

  /** Start the close handshake; the socket ends once the peer answers (or soon). */
  close(code = 1000): void {
    if (this.closed) return;
    if (!this.closeSent) {
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      this.writeFrame(OP_CLOSE, payload);
      this.closeSent = true;
    }
    // A peer that never answers the close must not hold the socket forever.
    setTimeout(() => this.socket.destroy(), 2000).unref();
  }

  /** Drop the connection now, without a handshake. */
  terminate(): void {
    this.socket.destroy();
    this.finish(1006);
  }

  private finish(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.emit('close', code);
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    if (!this.socket.writable) return;
    const length = payload.length;
    let header: Buffer;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 0x10000) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  /** A protocol violation: close with its code and stop reading. */
  private fail(code: number): void {
    this.failed = true;
    this.buffer = Buffer.alloc(0);
    this.close(code);
    this.socket.end();
  }

  private onData(chunk: Buffer): void {
    if (this.closed || this.failed) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (!this.closed && !this.failed) {
      const consumed = this.readFrame();
      if (consumed === 0) return;
      this.buffer = this.buffer.subarray(consumed);
    }
  }

  /** Parse one frame from the buffer; returns the bytes consumed, 0 if incomplete. */
  private readFrame(): number {
    const buf = this.buffer;
    if (buf.length < 2) return 0;
    const b0 = buf[0]!;
    const b1 = buf[1]!;
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;
    let offset = 2;
    // RSV bits: no extension is ever negotiated, so any set bit is a violation.
    if ((b0 & 0x70) !== 0 || !masked) {
      this.fail(1002);
      return 0;
    }
    if (length === 126) {
      if (buf.length < 4) return 0;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) return 0;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_MESSAGE_BYTES)) {
        this.fail(1009);
        return 0;
      }
      length = Number(big);
      offset = 10;
    }
    // A 7- or 16-bit length is at most 65535, under the limit by construction;
    // only the 64-bit form can exceed it, and it was refused above.
    if (buf.length < offset + 4 + length) return 0;
    const mask = buf.subarray(offset, offset + 4);
    const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + length));
    for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i & 3]!;
    this.handleFrame(fin, opcode, payload);
    return offset + 4 + length;
  }

  private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode >= 0x8) {
      // Control frames are never fragmented and carry at most 125 bytes.
      if (!fin || payload.length > 125) return this.fail(1002);
      if (opcode === OP_PING) return this.writeFrame(OP_PONG, payload);
      if (opcode === OP_PONG) return;
      if (opcode === OP_CLOSE) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        if (!this.closeSent) {
          const answer = Buffer.alloc(2);
          answer.writeUInt16BE(payload.length >= 2 ? code : 1000, 0);
          this.writeFrame(OP_CLOSE, answer);
          this.closeSent = true;
        }
        this.socket.end();
        this.finish(code);
        return;
      }
      return this.fail(1002);
    }
    if (opcode === OP_CONT) {
      if (this.fragmentOpcode === null) return this.fail(1002);
    } else if (opcode === OP_TEXT || opcode === OP_BINARY) {
      if (this.fragmentOpcode !== null) return this.fail(1002);
      this.fragmentOpcode = opcode;
    } else {
      return this.fail(1002);
    }
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > MAX_MESSAGE_BYTES) return this.fail(1009);
    this.fragments.push(payload);
    if (!fin) return;
    const data = this.fragments.length === 1 ? this.fragments[0]! : Buffer.concat(this.fragments);
    const isBinary = this.fragmentOpcode === OP_BINARY;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = null;
    this.emit('message', data, isBinary);
  }
}

/**
 * Complete the handshake for a request `isWebSocketUpgrade` accepted, and wrap
 * the socket. `head` is the first chunk Node already read past the headers.
 */
export function acceptWebSocket(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): WebSocketConnection {
  const key = req.headers['sec-websocket-key'] as string;
  const accept = createHash('sha1')
    .update(key + GUID)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const connection = new WebSocketConnection(socket);
  if (head.length > 0) socket.unshift(head);
  return connection;
}
