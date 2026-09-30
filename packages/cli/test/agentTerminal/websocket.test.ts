import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_BYTES,
  WebSocketConnection,
  acceptWebSocket,
  isWebSocketUpgrade,
  refuseUpgrade,
} from '../../src/agentTerminal/websocket.js';

// The hand-written RFC 6455 server endpoint (MOTIR-6938), driven by a RAW
// client that writes frames byte by byte — so fragmentation, control frames,
// the close handshake and every refusal are exercised exactly as a peer could
// send them. (`server.test.ts` drives it with Node's own WebSocket client.)

let server: Server | null = null;
const sockets: { destroy(): unknown }[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

interface Peer {
  socket: Socket;
  connection: Promise<WebSocketConnection>;
  /** Every byte the server wrote after the 101 response. */
  received(): Buffer;
  /** The HTTP response head. */
  head(): string;
  closed: Promise<void>;
}

async function open(): Promise<Peer> {
  let resolveConnection!: (connection: WebSocketConnection) => void;
  const connection = new Promise<WebSocketConnection>((resolve) => (resolveConnection = resolve));
  server = createServer();
  server.on('upgrade', (req, socket, head) => {
    sockets.push(socket);
    resolveConnection(acceptWebSocket(req, socket, head));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const socket = connect(port, '127.0.0.1');
  sockets.push(socket);
  const chunks: Buffer[] = [];
  socket.on('data', (chunk) => chunks.push(chunk));
  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write(
    [
      'GET /v1/terminal HTTP/1.1',
      'Host: x',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      '',
      '',
    ].join('\r\n'),
  );
  await connection;
  return {
    socket,
    connection,
    closed,
    received: () => {
      const all = Buffer.concat(chunks);
      return all.subarray(all.indexOf('\r\n\r\n') + 4);
    },
    head: () => {
      const all = Buffer.concat(chunks);
      return all.subarray(0, all.indexOf('\r\n\r\n')).toString();
    },
  };
}

/** A masked client frame. */
function frame(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = randomBytes(4);
  const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i & 3]!));
  let header: Buffer;
  if (payload.length < 126)
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length]);
  else if (payload.length < 0x10000) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, mask, masked]);
}

/** Poll until `check` holds (2 s at most). */
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function messages(peer: Peer): Promise<[Buffer, boolean][]> {
  const out: [Buffer, boolean][] = [];
  (await peer.connection).on('message', (data, isBinary) => out.push([data, isBinary]));
  return out;
}

describe('the handshake', () => {
  it('answers with the RFC 6455 accept value', async () => {
    const peer = await open();
    await until(() => peer.head().length > 0);
    // The RFC's own example (§1.3): this key → s3pPLMBiTxaQ9kYGzzhZRbK+xOo=.
    expect(peer.head().split('\r\n')).toEqual([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
    ]);
  });

  it('recognises only a well-formed upgrade', () => {
    const req = (headers: Record<string, string>, method = 'GET') =>
      ({ method, headers }) as unknown as IncomingMessage;
    const good = {
      upgrade: 'websocket',
      'sec-websocket-key': Buffer.alloc(16).toString('base64'),
      'sec-websocket-version': '13',
    };
    expect(isWebSocketUpgrade(req(good))).toBe(true);
    expect(isWebSocketUpgrade(req(good, 'POST'))).toBe(false);
    expect(isWebSocketUpgrade(req({ ...good, upgrade: 'h2c' }))).toBe(false);
    expect(isWebSocketUpgrade(req({ ...good, 'sec-websocket-key': 'short' }))).toBe(false);
    expect(isWebSocketUpgrade(req({ ...good, 'sec-websocket-version': '8' }))).toBe(false);
  });

  it('refuses with a bare status line, or destroys a socket that cannot be written', () => {
    const written: string[] = [];
    const open = new PassThrough();
    open.on('data', (chunk: Buffer) => written.push(chunk.toString()));
    refuseUpgrade(open, 401, 'Unauthorized');
    expect(written.join('')).toBe(
      'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
    );
    const ended = new PassThrough();
    ended.end();
    refuseUpgrade(ended, 401, 'Unauthorized');
    expect(ended.destroyed).toBe(true);
  });
});

describe('messages', () => {
  it('reassembles a fragmented text message, split across TCP writes', async () => {
    const peer = await open();
    const got = await messages(peer);
    const bytes = Buffer.concat([
      frame(0x1, Buffer.from('hel'), false),
      frame(0x0, Buffer.from('lo'), false),
      frame(0x0, Buffer.from('!'), true),
    ]);
    for (const byte of bytes) peer.socket.write(Buffer.from([byte]));
    await until(() => got.length > 0);
    expect(got).toEqual([[Buffer.from('hello!'), false]]);
  });

  it('reads 16-bit and 64-bit lengths, and writes them back', async () => {
    const peer = await open();
    const got = await messages(peer);
    const medium = Buffer.alloc(300, 1);
    const large = Buffer.alloc(70_000, 2);
    peer.socket.write(Buffer.concat([frame(0x2, medium), frame(0x2, large)]));
    await until(() => got.length === 2);
    expect(got.map(([data, isBinary]) => [data.length, isBinary])).toEqual([
      [300, true],
      [70_000, true],
    ]);
    const connection = await peer.connection;
    connection.send(medium);
    connection.send(large);
    connection.send('text');
    await until(() => peer.received().length >= 4 + 300 + 10 + 70_000 + 6);
    const out = peer.received();
    expect([out[0], out[1], out.readUInt16BE(2)]).toEqual([0x82, 126, 300]);
    const second = out.subarray(4 + 300);
    expect([second[0], second[1], Number(second.readBigUInt64BE(2))]).toEqual([0x82, 127, 70_000]);
    const third = second.subarray(10 + 70_000);
    expect([...third]).toEqual([0x81, 4, ...Buffer.from('text')]);
  });

  it('answers a ping with a pong carrying the same payload, and ignores a pong', async () => {
    const peer = await open();
    peer.socket.write(Buffer.concat([frame(0xa, Buffer.from('x')), frame(0x9, Buffer.from('hi'))]));
    await until(() => peer.received().length >= 4);
    expect([...peer.received()]).toEqual([0x8a, 2, ...Buffer.from('hi')]);
  });
});

describe('closing', () => {
  it('answers a client close with the same code and emits close once', async () => {
    const peer = await open();
    const connection = await peer.connection;
    const codes: number[] = [];
    connection.on('close', (code) => codes.push(code));
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(4000, 0);
    peer.socket.write(frame(0x8, payload));
    await peer.closed;
    expect([...peer.received()]).toEqual([0x88, 2, 0x0f, 0xa0]);
    expect(codes).toEqual([4000]);
    expect(connection.isOpen).toBe(false);
    connection.send('ignored after close');
    connection.close();
  });

  it('answers an empty close with 1000 and reports 1005', async () => {
    const peer = await open();
    const connection = await peer.connection;
    const codes: number[] = [];
    connection.on('close', (code) => codes.push(code));
    peer.socket.write(frame(0x8, Buffer.alloc(0)));
    await peer.closed;
    expect([...peer.received()]).toEqual([0x88, 2, 0x03, 0xe8]);
    expect(codes).toEqual([1005]);
  });

  it('a server close sends the code and ends once the peer answers', async () => {
    const peer = await open();
    const connection = await peer.connection;
    connection.close(1000);
    connection.close(1000); // idempotent
    await until(() => peer.received().length >= 4);
    expect([...peer.received()]).toEqual([0x88, 2, 0x03, 0xe8]);
    peer.socket.write(frame(0x8, Buffer.from([0x03, 0xe8])));
    await peer.closed;
    expect(connection.isOpen).toBe(false);
  });

  it('a server close drops a peer that never answers, after a grace period', async () => {
    const peer = await open();
    const connection = await peer.connection;
    const codes: number[] = [];
    connection.on('close', (code) => codes.push(code));
    connection.close(1001);
    await peer.closed;
    await until(() => codes.length > 0);
    expect(codes).toEqual([1006]);
  }, 10_000);

  it('terminate drops the socket at once and reports 1006', async () => {
    const peer = await open();
    const connection = await peer.connection;
    const codes: number[] = [];
    connection.on('close', (code) => codes.push(code));
    connection.terminate();
    await peer.closed;
    expect(codes).toEqual([1006]);
  });
});

describe('protocol violations close the connection and stop reading', () => {
  async function violation(
    bytes: Buffer,
  ): Promise<{ closeCode: number; got: [Buffer, boolean][] }> {
    const peer = await open();
    const got = await messages(peer);
    peer.socket.write(Buffer.concat([bytes, frame(0x1, Buffer.from('after'))]));
    await peer.closed;
    const out = peer.received();
    return { closeCode: out.readUInt16BE(2), got };
  }

  it.each([
    ['an unmasked frame', Buffer.from([0x81, 0x01, 0x41]), 1002],
    ['a set RSV bit', Buffer.from([0xc1, 0x80, 0, 0, 0, 0]), 1002],
    ['a fragmented control frame', frame(0x9, Buffer.from('x'), false), 1002],
    ['an over-long control frame', frame(0x9, Buffer.alloc(126)), 1002],
    ['an unknown control opcode', frame(0xb, Buffer.alloc(0)), 1002],
    ['an unknown data opcode', frame(0x3, Buffer.alloc(0)), 1002],
    ['a continuation with nothing to continue', frame(0x0, Buffer.from('x')), 1002],
    [
      'a new message inside a fragmented one',
      Buffer.concat([frame(0x1, Buffer.from('a'), false), frame(0x1, Buffer.from('b'))]),
      1002,
    ],
  ])('%s → %i', async (_label, bytes, code) => {
    const { closeCode, got } = await violation(bytes);
    expect(closeCode).toBe(code);
    expect(got).toEqual([]);
  });

  it('a 64-bit length over the limit → 1009, before any payload arrives', async () => {
    const header = Buffer.alloc(10);
    header[0] = 0x82;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(MAX_MESSAGE_BYTES + 1), 2);
    const { closeCode } = await violation(header);
    expect(closeCode).toBe(1009);
  });

  it('a fragmented message growing past the limit → 1009', async () => {
    const half = Buffer.alloc(MAX_MESSAGE_BYTES / 2 + 1);
    const { closeCode } = await violation(
      Buffer.concat([frame(0x2, half, false), frame(0x0, half, true)]),
    );
    expect(closeCode).toBe(1009);
  });
});
