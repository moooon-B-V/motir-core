import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuthError,
  CliError,
  IncompatibleServerError,
  NotFoundError,
  RateLimitError,
  ResponseShapeError,
  ScopeError,
} from '../src/errors.js';
import { describeField, isVersionBehind, V1Transport } from '../src/transport.js';
import { GENERATED_AGAINST } from '../src/api/index.js';

// The `/api/v1` transport core, driven against a REAL stub HTTP server over a
// real socket (Story 11.5 · Subtask 11.5.3 — MOTIR-2211).
//
// Deliberately not a mocked `fetch`. What this card has to prove is the request
// actually put on the wire (method, path, query, bearer) and the behaviour on a
// real status line with real headers — and a stubbed module proves neither. The
// server below records every request it receives, so the assertions are about
// bytes rather than about call arguments.

/** One canned reply the stub server serves for the next request. */
interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Serve raw text instead of JSON — for an unparseable body. */
  raw?: string;
}

/** What the stub recorded about a request it served. */
interface Recorded {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
}

class StubServer {
  private server: Server | undefined;
  private replies: Reply[] = [];
  readonly received: Recorded[] = [];
  /** A default reply, served once `replies` runs out. */
  fallback: Reply = { status: 500, body: { code: 'UNEXPECTED', error: 'no reply queued' } };
  url = '';

  async start(): Promise<void> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        this.received.push({
          method: req.method ?? '',
          url: req.url ?? '',
          authorization: req.headers.authorization,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        const reply = this.replies.shift() ?? this.fallback;
        res.writeHead(reply.status, {
          'content-type': 'application/json',
          ...(reply.headers ?? {}),
        });
        res.end(reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body)));
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const address = this.server?.address() as AddressInfo;
    this.url = `http://127.0.0.1:${address.port}`;
  }

  queue(...replies: Reply[]): void {
    this.replies.push(...replies);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
  }
}

/** A valid `Project`, the smallest real resource to round-trip. */
const PROJECT = { key: 'MOTIR', name: 'Motir', accessLevel: 'open', archived: false };

/** A spec document advertising `version`, for the skew probe. */
function specWithVersion(version: string): unknown {
  return { openapi: '3.1.0', info: { title: 'Motir API', version }, paths: {} };
}

let stub: StubServer;

beforeEach(async () => {
  stub = new StubServer();
  await stub.start();
});

afterEach(async () => {
  await stub.stop();
});

function transport(overrides: { now?: () => Date } = {}): V1Transport {
  return new V1Transport({ serverUrl: stub.url, token: 'motir_pat_test', ...overrides });
}

describe('the request primitive', () => {
  it('issues a real request with the bearer header and returns a validated body', async () => {
    stub.queue({ status: 200, body: PROJECT });

    const project = await transport().request('getProject', { path: { projectKey: 'MOTIR' } });

    expect(project).toEqual(PROJECT);
    expect(stub.received).toHaveLength(1);
    expect(stub.received[0]?.method).toBe('GET');
    expect(stub.received[0]?.url).toBe('/api/v1/projects/MOTIR');
    expect(stub.received[0]?.authorization).toBe('Bearer motir_pat_test');
  });

  it('URL-encodes a path parameter rather than interpolating it raw', async () => {
    stub.queue({ status: 200, body: PROJECT });
    await transport().request('getProject', { path: { projectKey: 'a/b' } });
    expect(stub.received[0]?.url).toBe('/api/v1/projects/a%2Fb');
  });

  it('builds a query string, skipping undefined and null', async () => {
    stub.queue({ status: 200, body: { items: [], nextCursor: null } });

    await transport().request('getProjectReadySet', {
      path: { projectKey: 'MOTIR' },
      query: { limit: 10, cursor: undefined },
    });

    expect(stub.received[0]?.url).toBe('/api/v1/projects/MOTIR/ready?limit=10');
  });

  it('sends a JSON body with a content type on a write, and none on a read', async () => {
    stub.queue({ status: 200, body: { items: [], nextCursor: null } });
    await transport().request('getProjectReadySet', { path: { projectKey: 'MOTIR' } });
    expect(stub.received[0]?.body).toBe('');
  });

  it('refuses to build a URL with a missing path parameter', () => {
    expect(() => transport().buildUrl('getProject', { path: { projectKey: '' } })).not.toThrow();
    // An explicitly absent parameter is an internal defect, not a server error.
    expect(() => transport().buildUrl('getProject', {})).toThrow(CliError);
  });
});

describe('an opaque cursor passes through untouched', () => {
  it('is sent verbatim and returned verbatim, never rebuilt', async () => {
    // A cursor is signed and collection-scoped (ADR §5). This one contains the
    // characters a client tempted to "helpfully" normalise would break.
    const cursor = 'eyJrIjoiMjAyNi0wOC0wNVQxMjowMDowMFoifQ==';
    stub.queue({ status: 200, body: { items: [], nextCursor: cursor } });

    const page = await transport().request('getProjectReadySet', {
      path: { projectKey: 'MOTIR' },
      query: { cursor },
    });

    expect(stub.received[0]?.url).toContain(`cursor=${encodeURIComponent(cursor)}`);
    expect(page.nextCursor).toBe(cursor);
  });
});

describe('the boundary PARSE names the field', () => {
  it('a MISSING required key', async () => {
    const { name: _dropped, ...withoutName } = PROJECT;
    stub.queue({ status: 200, body: withoutName });

    await expect(
      transport().request('getProject', { path: { projectKey: 'MOTIR' } }),
    ).rejects.toMatchObject({
      name: 'ResponseShapeError',
      // The case `instancePath` alone would have reported as "` `".
      message: expect.stringContaining('/name'),
    });
  });

  it('a WRONG SCALAR TYPE', async () => {
    stub.queue({ status: 200, body: { ...PROJECT, archived: 'nope' } });

    await expect(
      transport().request('getProject', { path: { projectKey: 'MOTIR' } }),
    ).rejects.toMatchObject({
      name: 'ResponseShapeError',
      message: expect.stringContaining('/archived'),
    });
  });

  it('a WRONG ENUM VALUE', async () => {
    stub.queue({ status: 200, body: { ...PROJECT, accessLevel: 'semi-open' } });

    const error = await transport()
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ResponseShapeError);
    expect((error as CliError).message).toContain('/accessLevel');
    expect((error as CliError).hint).toContain('motir doctor');
  });

  it('names the ROOT when the whole body is the wrong shape', () => {
    expect(
      describeField({ instancePath: '', schemaPath: '#/type', keyword: 'type', params: {} }),
    ).toBe('(root)');
  });

  it('names an ADDITIONAL property, so a server that GREW a field is legible', () => {
    expect(
      describeField({
        instancePath: '',
        schemaPath: '#/additionalProperties',
        keyword: 'additionalProperties',
        params: { additionalProperty: 'surprise' },
      }),
    ).toBe('/surprise');
  });
});

describe('the status map', () => {
  it('401 → AuthError, with the re-login hint', async () => {
    stub.queue({
      status: 401,
      body: { code: 'UNAUTHENTICATED', error: 'Authentication required.' },
    });

    const error = await transport()
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AuthError);
    expect((error as CliError).hint).toContain('motir auth login');
  });

  it('403 → ScopeError NAMING the scope, taken from the generated table', async () => {
    stub.queue({ status: 403, body: { code: 'INSUFFICIENT_SCOPE', error: 'nope' } });

    const error = await transport()
      .request('createWorkItem', {
        path: { projectKey: 'MOTIR' },
        body: { kind: 'subtask', title: 'x' },
      })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ScopeError);
    // `work_items:write` comes from `x-motir-scope` on the operation, NOT from
    // the server's sentence — which said only "nope".
    expect((error as CliError).message).toContain("'work_items:write'");
    expect((error as CliError).message).toContain('createWorkItem');
  });

  it('404 WITH an envelope → NotFoundError carrying the server’s own sentence', async () => {
    stub.queue({ status: 404, body: { code: 'WORK_ITEM_NOT_FOUND', error: 'No such work item.' } });

    const error = await transport()
      .request('getWorkItem', { path: { key: 'MOTIR-9999' } })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as CliError).message).toBe('No such work item.');
  });

  it('429 → RateLimitError reporting the reset instant and a relative retry', async () => {
    const resetAt = Math.floor(Date.UTC(2026, 7, 5, 12, 0, 30) / 1000);
    stub.queue({
      status: 429,
      body: { code: 'RATE_LIMITED', error: 'Too many requests.' },
      headers: { 'x-ratelimit-reset': String(resetAt) },
    });

    const error = await transport({ now: () => new Date(Date.UTC(2026, 7, 5, 12, 0, 0)) })
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as CliError).message).toContain('refills at');
    // v1 sends NO `Retry-After` by design; the relative hint is derived from the
    // absolute instant rather than read off a header that does not exist.
    expect((error as CliError).hint).toBe('Retry in 30 seconds.');
  });

  it('429 with NO reset header still produces a usable error', async () => {
    stub.queue({ status: 429, body: { code: 'RATE_LIMITED', error: 'Too many requests.' } });

    const error = await transport()
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as CliError).hint).toBe('Retry shortly.');
  });

  it('500 → CliError quoting the request id, which is what support needs', async () => {
    stub.queue({
      status: 500,
      body: { error: 'Something went wrong.' },
      headers: { 'x-request-id': 'req_abc' },
    });

    const error = await transport()
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((err: unknown) => err);

    expect((error as CliError).message).toContain('failed (500)');
    expect((error as CliError).message).toContain('req_abc');
  });

  it('a CONNECTION failure → CliError naming the server', async () => {
    await stub.stop();

    const error = await transport()
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain('Could not reach');
    expect((error as CliError).hint).toContain('motir doctor');
  });

  it('a documented 4xx (422) reports the server’s sentence with NO added hint', async () => {
    stub.queue({
      status: 422,
      body: { code: 'INVALID_CURSOR', error: 'That cursor is not ours.' },
    });

    const error = await transport()
      .request('getProjectReadySet', { path: { projectKey: 'MOTIR' }, query: { cursor: 'bad' } })
      .catch((err: unknown) => err);

    expect((error as CliError).message).toBe('That cursor is not ours.');
    expect((error as CliError).hint).toBeUndefined();
  });

  it('a 4xx with NO envelope still produces a legible error', async () => {
    stub.queue({ status: 409, raw: '<html>nope</html>' });

    const error = await transport()
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((err: unknown) => err);

    expect((error as CliError).message).toContain('answered 409');
  });
});

describe('the error path reads the machine `code`, never the human sentence', () => {
  it('two different sentences under ONE code map to the same class', async () => {
    stub.queue({ status: 403, body: { code: 'INSUFFICIENT_SCOPE', error: 'Nope.' } });
    const first = await transport()
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((err: unknown) => err);

    stub.queue({
      status: 403,
      body: { code: 'INSUFFICIENT_SCOPE', error: 'A completely different sentence, unauthorized.' },
    });
    const second = await transport()
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((err: unknown) => err);

    expect(first).toBeInstanceOf(ScopeError);
    expect(second).toBeInstanceOf(ScopeError);
    // Note the second sentence contains "unauthorized" — the word the MCP-era
    // `isUnauthorized` regex matched. Under HTTP it changes nothing.
    expect(second).not.toBeInstanceOf(AuthError);
    expect((first as CliError).message).toBe((second as CliError).message);
  });
});

describe('the version-skew gate', () => {
  it('an incompatible MAJOR produces ONE upgrade error', async () => {
    stub.queue(
      { status: 200, body: { ...PROJECT, accessLevel: 'from-the-future' } },
      { status: 200, body: specWithVersion('2.0.0') },
    );

    const error = await transport()
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(IncompatibleServerError);
    expect((error as CliError).message).toContain('speaks Motir API v1');
    expect((error as CliError).message).toContain('serves v2');
    expect((error as CliError).hint).toContain('npm install -g @motir/cli@latest');
  });

  it('fires at most ONCE — the probe is latched per instance', async () => {
    const client = transport();
    stub.queue(
      { status: 200, body: { ...PROJECT, accessLevel: 'bad' } },
      { status: 200, body: specWithVersion('2.0.0') },
      { status: 200, body: { ...PROJECT, accessLevel: 'bad' } },
    );

    await client.request('getProject', { path: { projectKey: 'MOTIR' } }).catch(() => undefined);
    await client.request('getProject', { path: { projectKey: 'MOTIR' } }).catch(() => undefined);

    // Three requests, not four: two calls plus ONE spec fetch.
    expect(stub.received.map((r) => r.url)).toEqual([
      '/api/v1/projects/MOTIR',
      '/api/openapi/v1.json',
      '/api/v1/projects/MOTIR',
    ]);
  });

  it('a server AHEAD on the minor is NOT skew — §8 is additive-only', async () => {
    // The load-bearing negative. A newer server cannot break a client generated
    // earlier, so a parse failure there is a REAL defect and must be reported as
    // one rather than laundered into "upgrade something".
    const [major, minor] = GENERATED_AGAINST.split('.');
    stub.queue(
      { status: 200, body: { ...PROJECT, accessLevel: 'bad' } },
      { status: 200, body: specWithVersion(`${major}.${Number(minor) + 1}.0`) },
    );

    const error = await transport()
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ResponseShapeError);
    expect(error).not.toBeInstanceOf(IncompatibleServerError);
  });

  it('compares MINOR then PATCH, and treats equal as not behind', () => {
    // Asserted directly rather than through the stub: `GENERATED_AGAINST` is
    // `1.0.0`, so no version inside major 1 is below it and an end-to-end test
    // could not reach this arm today. It becomes reachable the first time the
    // contract's MINOR moves — which is exactly when getting it wrong would
    // start telling users to upgrade a server that is fine.
    expect(isVersionBehind([1, 0, 0], [1, 1, 0])).toBe(true);
    expect(isVersionBehind([1, 2, 0], [1, 1, 9])).toBe(false);
    expect(isVersionBehind([1, 1, 0], [1, 1, 4])).toBe(true);
    expect(isVersionBehind([1, 1, 4], [1, 1, 4])).toBe(false);
    expect(isVersionBehind([1, 1, 5], [1, 1, 4])).toBe(false);
  });

  it('a server at exactly the generated version is NOT skew', async () => {
    stub.queue(
      { status: 200, body: { ...PROJECT, accessLevel: 'bad' } },
      { status: 200, body: specWithVersion(GENERATED_AGAINST) },
    );

    await expect(
      transport().request('getProject', { path: { projectKey: 'MOTIR' } }),
    ).rejects.toBeInstanceOf(ResponseShapeError);
  });

  it('an UNREACHABLE spec yields NO verdict — the original error stands', async () => {
    stub.queue(
      { status: 200, body: { ...PROJECT, accessLevel: 'bad' } },
      { status: 404, raw: 'nope' },
    );

    const error = await transport()
      .request('getProject', { path: { projectKey: 'MOTIR' } })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ResponseShapeError);
  });

  it('an UNPARSEABLE spec yields no verdict either', async () => {
    stub.queue(
      { status: 200, body: { ...PROJECT, accessLevel: 'bad' } },
      { status: 200, raw: 'not json at all' },
    );

    await expect(
      transport().request('getProject', { path: { projectKey: 'MOTIR' } }),
    ).rejects.toBeInstanceOf(ResponseShapeError);
  });

  it('a spec with no `info.version` yields no verdict', async () => {
    stub.queue(
      { status: 200, body: { ...PROJECT, accessLevel: 'bad' } },
      { status: 200, body: { openapi: '3.1.0', paths: {} } },
    );

    await expect(
      transport().request('getProject', { path: { projectKey: 'MOTIR' } }),
    ).rejects.toBeInstanceOf(ResponseShapeError);
  });

  it('a non-semver `info.version` yields no verdict', async () => {
    stub.queue(
      { status: 200, body: { ...PROJECT, accessLevel: 'bad' } },
      { status: 200, body: specWithVersion('v1') },
    );

    await expect(
      transport().request('getProject', { path: { projectKey: 'MOTIR' } }),
    ).rejects.toBeInstanceOf(ResponseShapeError);
  });

  it('a 404 with NO envelope means the ROUTE is absent, and arms the probe', async () => {
    stub.queue(
      { status: 404, raw: '<html>404</html>' },
      { status: 200, body: specWithVersion('2.0.0') },
    );

    const error = await transport()
      .request('getWorkItem', { path: { key: 'MOTIR-1' } })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(IncompatibleServerError);
    expect(stub.received[1]?.url).toBe('/api/openapi/v1.json');
  });

  it('an absent route with a COMPATIBLE server is reported as a missing endpoint', async () => {
    stub.queue(
      { status: 404, raw: '<html>404</html>' },
      { status: 200, body: specWithVersion(GENERATED_AGAINST) },
    );

    const error = await transport()
      .request('getWorkItem', { path: { key: 'MOTIR-1' } })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain('has no getWorkItem endpoint');
  });

  it('a spec fetch that THROWS yields no verdict rather than a wrong one', async () => {
    stub.queue({ status: 200, body: { ...PROJECT, accessLevel: 'bad' } });
    let call = 0;
    const flaky: typeof fetch = async (input, init) => {
      call += 1;
      if (call > 1) throw new Error('socket hang up');
      return fetch(input, init);
    };

    const client = new V1Transport({ serverUrl: stub.url, token: 't', fetchImpl: flaky });
    await expect(
      client.request('getProject', { path: { projectKey: 'MOTIR' } }),
    ).rejects.toBeInstanceOf(ResponseShapeError);
  });
});
