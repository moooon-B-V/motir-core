import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { NextRequest } from 'next/server';
import { signalFromNodeResponse } from 'next/dist/server/web/spec-extension/adapters/next-request';
import { githubWebhookService } from '@/lib/services/githubWebhookService';

// MOTIR-6256 — `POST /api/github/webhook` surfaced `Error: aborted` in production:
// five events, every frame inside `node:_http_server` (`abortIncoming` ←
// `socketOnClose`), reported through Next's `onRequestError`.
//
// That is what `await req.text()` throws when the connection closes before the
// handler has READ the whole body — a sender that gave up mid-upload, or GitHub's
// ten-second delivery timeout expiring while the request waited for the handler
// to start. Either way nothing is left to answer, and the handler must not turn a
// departed client into an unhandled server error.
//
// These tests drive a REAL socket. A `NextRequest` built over a string body can
// never abort, so the defect is only reachable the way production reaches it: a
// Node `http` server handing its `IncomingMessage` to the route exactly as Next's
// `NextRequestAdapter.fromNodeNextRequest` does (the Node request as the body,
// `duplex: 'half'`, the signal Next derives from the response), and a client
// that sends the headers, part of the body, and then closes the socket.

type Outcome = { threw: unknown } | { status: number };

/** Serve ONE request through `handler` the way Next's Node server does, and
 *  resolve with what the handler did once it settles. */
function serveOnce(
  handler: (req: NextRequest) => Promise<Response>,
  opts: { delayBeforeHandlerMs?: number } = {},
): Promise<{ port: number; outcome: Promise<Outcome>; close: () => void }> {
  let settle!: (o: Outcome) => void;
  const outcome = new Promise<Outcome>((resolve) => {
    settle = resolve;
  });
  const server = http.createServer((req, res) => {
    const signal = signalFromNodeResponse(res);
    const nextReq = new NextRequest(`http://localhost${req.url ?? '/'}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      duplex: 'half',
      signal,
      body: req as unknown as ReadableStream,
    } as ConstructorParameters<typeof NextRequest>[1]);
    void (async () => {
      if (opts.delayBeforeHandlerMs) {
        await new Promise((r) => setTimeout(r, opts.delayBeforeHandlerMs));
      }
      try {
        const response = await handler(nextReq);
        settle({ status: response.status });
        if (!res.destroyed) res.end();
      } catch (err) {
        settle({ threw: err });
      }
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        outcome,
        close: () => server.close(),
      });
    });
  });
}

/** Send the headers for a `declaredLength`-byte body, write `sent` of it, and
 *  close the socket after `closeAfterMs`. */
function sendThenHangUp(
  port: number,
  {
    sent,
    declaredLength,
    closeAfterMs,
  }: { sent: string; declaredLength: number; closeAfterMs: number },
): void {
  const socket = net.connect(port, '127.0.0.1', () => {
    socket.write(
      [
        'POST /api/github/webhook HTTP/1.1',
        'Host: localhost',
        'Content-Type: application/json',
        'X-GitHub-Event: pull_request',
        'X-GitHub-Delivery: 6256-delivery-guid',
        'X-Hub-Signature-256: sha256=00',
        `Content-Length: ${declaredLength}`,
        '',
        '',
      ].join('\r\n') + sent,
    );
    setTimeout(() => socket.destroy(), closeAfterMs);
  });
  socket.on('error', () => {});
}

async function importRoute() {
  return (await import('@/app/api/github/webhook/route')).POST;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('POST /api/github/webhook — a client that closes the connection before the body is read', () => {
  it('answers without throwing when the sender hangs up MID-BODY, and processes nothing', async () => {
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', 'test-webhook-secret');
    const handleEvent = vi.spyOn(githubWebhookService, 'handleEvent');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const POST = await importRoute();

    const { port, outcome, close } = await serveOnce(POST);
    sendThenHangUp(port, { sent: '{"action":"clo', declaredLength: 400, closeAfterMs: 50 });
    const result = await outcome;
    close();

    expect(result).not.toHaveProperty('threw');
    expect(result).toEqual({ status: 499 });
    expect(handleEvent).not.toHaveBeenCalled();
    // The lost delivery is named, so it can be found in GitHub's delivery log.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('6256-delivery-guid'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pull_request'));
  });

  it('answers without throwing when the WHOLE body arrived but the connection closed before the handler read it', async () => {
    // GitHub's ten-second timeout expiring while the request waited to be handled:
    // every byte is on the socket, and the read still fails.
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', 'test-webhook-secret');
    const handleEvent = vi.spyOn(githubWebhookService, 'handleEvent');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const POST = await importRoute();

    const body = JSON.stringify({ action: 'closed' });
    const { port, outcome, close } = await serveOnce(POST, { delayBeforeHandlerMs: 150 });
    sendThenHangUp(port, { sent: body, declaredLength: body.length, closeAfterMs: 50 });
    const result = await outcome;
    close();

    expect(result).toEqual({ status: 499 });
    expect(handleEvent).not.toHaveBeenCalled();
  });
});

describe('isClientAbort / readRawBodyUnlessAborted — only a departed client is swallowed', () => {
  function nodeAbort(): Error {
    return Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
  }

  function requestWhoseBodyFails(err: Error, signal?: AbortSignal): Request {
    const body = new ReadableStream({
      pull(controller) {
        controller.error(err);
      },
    });
    return new Request('http://localhost/api/github/webhook', {
      method: 'POST',
      body,
      duplex: 'half',
      signal,
    } as RequestInit);
  }

  it("recognises Node's connection-reset abort, an AbortError, and a fired request signal", async () => {
    const { isClientAbort } = await import('@/lib/api/clientAbort');
    expect(isClientAbort(nodeAbort())).toBe(true);
    expect(isClientAbort(new DOMException('The operation was aborted.', 'AbortError'))).toBe(true);
    const fired = new AbortController();
    fired.abort();
    expect(isClientAbort(new Error('anything'), fired.signal)).toBe(true);
  });

  it('does NOT recognise a look-alike: the message without the code, the code without the message, or a non-error', async () => {
    const { isClientAbort } = await import('@/lib/api/clientAbort');
    expect(isClientAbort(new Error('aborted'))).toBe(false);
    expect(isClientAbort(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(
      false,
    );
    expect(isClientAbort('aborted')).toBe(false);
    expect(isClientAbort(new Error('aborted'), new AbortController().signal)).toBe(false);
  });

  it('returns null for an aborted read and the text for a complete one', async () => {
    const { readRawBodyUnlessAborted } = await import('@/lib/api/clientAbort');
    expect(await readRawBodyUnlessAborted(requestWhoseBodyFails(nodeAbort()))).toBeNull();
    const ok = new Request('http://localhost/x', { method: 'POST', body: '{"a":1}' });
    expect(await readRawBodyUnlessAborted(ok)).toBe('{"a":1}');
  });

  it('RE-THROWS a read failure that is not a client abort, so a real fault still reaches the monitor', async () => {
    const { readRawBodyUnlessAborted } = await import('@/lib/api/clientAbort');
    const fault = new TypeError('invalid chunk');
    await expect(readRawBodyUnlessAborted(requestWhoseBodyFails(fault))).rejects.toBe(fault);
  });

  it('the route re-throws that same non-abort failure rather than answering 499', async () => {
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', 'test-webhook-secret');
    const POST = await importRoute();
    const fault = new TypeError('invalid chunk');
    const req = new NextRequest(requestWhoseBodyFails(fault));
    await expect(POST(req)).rejects.toBe(fault);
  });
});
