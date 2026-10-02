import { createMcpHandler } from 'mcp-handler';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answerClientAbort } from '@/lib/mcp/clientAbort';
import { answerMalformedBody, JSON_RPC_PARSE_ERROR } from '@/lib/mcp/malformedBody';

// MOTIR-7299 — `POST /api/mcp` surfaced `SyntaxError: Unexpected end of JSON
// input` in production (15 events, every frame inside undici's
// `parseJSONFromBytes` ← `consumeBody`, the request from `curl`). `mcp-handler`
// reads a JSON POST with `await req.json()` before the MCP transport sees it, so
// an EMPTY body throws, the library hands the rejection to the route (the
// MOTIR-6853 patch), and `answerClientAbort` — correctly, it is not an abort —
// re-throws it to the monitor.
//
// No database and no auth: the library's transport under the options the route
// passes it, wrapped the way `app/api/mcp/route.ts` composes it.

type Handler = (req: Request) => Promise<Response>;

function libraryHandler(): Handler {
  return createMcpHandler(
    (server) => {
      server.tool('echo', 'Returns a fixed string', async () => ({
        content: [{ type: 'text', text: 'echo' }],
      }));
    },
    { serverInfo: { name: 'malformed-body-test', version: '0.0.0' } },
    { basePath: '/api', disableSse: true },
  );
}

function post(body: BodyInit | null, contentType = 'application/json'): Request {
  return new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': contentType, Accept: 'application/json, text/event-stream' },
    body,
    // A stream body needs half-duplex; a string body ignores it.
    duplex: 'half',
  } as RequestInit);
}

const TOOL_CALL = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'echo', arguments: {} },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MCP transport — a POST whose body is not JSON (MOTIR-7299)', () => {
  it('reproduces the defect: unwrapped, an EMPTY body throws the monitored SyntaxError out of the route', async () => {
    const outcome = await answerClientAbort(libraryHandler())(post('')).catch(
      (err: unknown) => err,
    );
    expect(outcome).toBeInstanceOf(SyntaxError);
    expect((outcome as SyntaxError).message).toBe('Unexpected end of JSON input');
  });

  it.each([
    ['an empty body', ''],
    ['a truncated body', TOOL_CALL.slice(0, 20)],
    ['a body that is not JSON at all', 'not json'],
  ])('%s answers 400 with JSON-RPC -32700 and warns — never throws', async (_label, body) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await answerClientAbort(answerMalformedBody(libraryHandler()))(post(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: JSON_RPC_PARSE_ERROR, message: 'Parse error: Invalid JSON' },
      id: null,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));
  });

  it('a well-formed tool call still reaches the tool and gets its result', async () => {
    const response = await answerMalformedBody(libraryHandler())(post(TOOL_CALL));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('echo');
  });

  it('a body the library does not parse as JSON (another Content-Type) is passed through untouched', async () => {
    const inner = vi.fn<Handler>(async () => new Response(null, { status: 204 }));
    const response = await answerMalformedBody(inner)(post('', 'text/plain'));
    expect(response.status).toBe(204);
    expect(inner).toHaveBeenCalledOnce();
  });

  it('a read that fails because the client hung up is re-thrown, for answerClientAbort to answer 499', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const aborted = Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(aborted);
      },
    });
    const response = await answerClientAbort(answerMalformedBody(libraryHandler()))(post(stream));
    expect(response.status).toBe(499);
  });

  it('a SyntaxError the WRAPPED handler throws is not swallowed — it is still a server fault', async () => {
    const fault = new SyntaxError('raised elsewhere');
    const outcome = await answerMalformedBody(async () => {
      throw fault;
    })(post(TOOL_CALL)).catch((err: unknown) => err);
    expect(outcome).toBe(fault);
  });
});
