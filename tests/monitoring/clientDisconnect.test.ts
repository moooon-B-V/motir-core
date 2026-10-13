import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Readable } from 'node:stream';
import type { ErrorEvent } from '@sentry/nextjs';
import { createElement, Suspense, use } from 'react';
import { renderToNodeFizzStream } from 'next/dist/server/app-render/stream-ops.node';
import { isAbortError, pipeNodeReadableToNodeResponse } from 'next/dist/server/pipe-readable';
import {
  DESTINATION_CLOSED_EARLY,
  dropClientDisconnectAborts,
  isClientDisconnectAbort,
} from '@/lib/monitoring/clientDisconnect';
import { serverBeforeSend } from '@/lib/monitoring/serverInit';

// MOTIR-8204 — `GET /workbench` reported `Error: The destination stream closed
// early.` 14 times in production, every frame inside Next's app-page runtime and
// Node's stream teardown, reported through `onRequestError`.
//
// These tests drive the page path production drives: a React tree with a
// Suspense boundary still pending after the shell (the Workbench's tab lists sit
// behind exactly such a boundary), rendered by Next's own
// `renderToNodeFizzStream` and piped by Next's own `pipeNodeReadableToNodeResponse`
// into a REAL `http.ServerResponse`, read by a real socket. A response built in
// memory can never be abandoned by its reader, so the defect is only reachable
// the way production reaches it: a client that reads the shell and leaves.

type Served = {
  /** Every value React handed `onError`, in order. */
  errors: unknown[];
  /** Resolves on the first `onError` call. */
  firstError: Promise<unknown>;
  port: number;
};

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

function Late({ text }: { text: Promise<string> }) {
  return createElement('p', null, use(text));
}

/** The shell paints at once; `late` decides when (and whether) the boundary does. */
function page(late: Promise<string>) {
  return createElement(
    'html',
    null,
    createElement(
      'body',
      null,
      createElement('h1', null, 'Workbench'),
      createElement(Suspense, { fallback: 'Loading…' }, createElement(Late, { text: late })),
    ),
  );
}

/** Serve `page(late)` the way Next's Node server streams an App Router page. */
async function serve(late: Promise<string>): Promise<Served> {
  const errors: unknown[] = [];
  let onFirst!: (e: unknown) => void;
  const firstError = new Promise<unknown>((resolve) => {
    onFirst = resolve;
  });
  const server = http.createServer((_req, res) => {
    void (async () => {
      const { stream } = await renderToNodeFizzStream(page(late), {
        onError: (err: unknown) => {
          errors.push(err);
          if (errors.length === 1) onFirst(err);
        },
      });
      res.setHeader('content-type', 'text/html; charset=utf-8');
      // The Node build of the stream ops returns a Node `Readable`; its declared
      // type is the union of both builds' streams.
      await pipeNodeReadableToNodeResponse(stream as Readable, res);
    })();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { errors, firstError, port: (server.address() as AddressInfo).port };
}

/** A raw HTTP/1.0 client: no keep-alive, so the server ends the body by closing. */
function connect(port: number): net.Socket {
  const socket = net.connect(port, '127.0.0.1');
  socket.write('GET /workbench HTTP/1.0\r\nHost: localhost\r\n\r\n');
  return socket;
}

function readAll(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
}

function readFirstChunk(socket: net.Socket): Promise<string> {
  return new Promise((resolve) => socket.once('data', (c: Buffer) => resolve(c.toString('utf8'))));
}

function eventFor(err: unknown): ErrorEvent {
  return {
    type: undefined,
    exception: { values: [{ type: (err as Error).name, value: (err as Error).message }] },
  };
}

describe('a client that leaves while /workbench is still streaming', () => {
  it('makes React report "The destination stream closed early." — which Next does not recognise as an abort', async () => {
    const served = await serve(new Promise<string>(() => {}));
    const socket = connect(served.port);

    // The shell arrives with the boundary still pending — then the visitor leaves.
    expect(await readFirstChunk(socket)).toContain('Workbench');
    socket.destroy();

    const err = await served.firstError;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('Error');
    expect((err as Error).message).toBe(DESTINATION_CLOSED_EARLY);
    // This is why it reached Sentry: Next's render error handlers drop only what
    // `isAbortError` matches, and React's cancel error is a plain `Error`.
    expect(isAbortError(err)).toBe(false);
    // …and why it no longer does.
    expect(isClientDisconnectAbort(err)).toBe(true);
    expect(serverBeforeSend(eventFor(err), { originalException: err })).toBeNull();
  });

  it('a client that stays gets the whole page, late boundary included, and React reports nothing', async () => {
    let resolveLate!: (text: string) => void;
    const served = await serve(
      new Promise<string>((resolve) => {
        resolveLate = resolve;
      }),
    );
    const socket = connect(served.port);
    const body = readAll(socket);

    expect(await readFirstChunk(socket)).toContain('Workbench');
    resolveLate('Your queue');

    const response = await body;
    expect(response).toMatch(/^HTTP\/1\.1 200/);
    expect(response).toContain('Your queue');
    expect(response).toContain('</html>');
    expect(served.errors).toEqual([]);
  });

  it('a client that leaves after the page finished streaming causes no error at all', async () => {
    const served = await serve(Promise.resolve('Your queue'));
    const socket = connect(served.port);

    const response = await readAll(socket);
    expect(response).toContain('Your queue');
    socket.destroy();

    expect(served.errors).toEqual([]);
  });

  it('a REAL render failure inside the boundary is still reported, with its own message', async () => {
    const failed = Promise.reject(new Error('workbench list read failed'));
    // React observes the rejection through `use()`; this only stops Node calling
    // it unhandled in the tick before React subscribes.
    failed.catch(() => {});
    const served = await serve(failed);
    const socket = connect(served.port);
    await readAll(socket);

    const err = await served.firstError;
    expect((err as Error).message).toBe('workbench list read failed');
    expect(isClientDisconnectAbort(err)).toBe(false);
    const event = eventFor(err);
    expect(serverBeforeSend(event, { originalException: err })).toBe(event);
  });
});

describe('isClientDisconnectAbort — the exact React abort and nothing wider', () => {
  it.each([
    [
      'the sibling "errored while writing" abort (a pipeline fault, not a departure)',
      new Error('The destination stream errored while writing data.'),
    ],
    ['the message as a bare string', DESTINATION_CLOSED_EARLY],
    [
      'the message on a differently named error',
      Object.assign(new Error(DESTINATION_CLOSED_EARLY), { name: 'TypeError' }),
    ],
    ['a message that merely contains it', new Error(`wrapped: ${DESTINATION_CLOSED_EARLY}`)],
    ['nothing at all', undefined],
  ])('does not match %s', (_label, value) => {
    expect(isClientDisconnectAbort(value)).toBe(false);
    const event = eventFor(value instanceof Error ? value : new Error(String(value)));
    expect(dropClientDisconnectAborts(event, { originalException: value })).toBe(event);
  });
});
