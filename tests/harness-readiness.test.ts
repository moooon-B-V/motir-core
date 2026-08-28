import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  assertHarnessReady,
  httpGet,
  pollUntilReady,
  waitForHttp200,
} from './e2e/_helpers/readiness';

// Unit tests for the E2E harness readiness gate (MOTIR-1565). This file lives
// at the tests/ root (NOT under tests/e2e/) on purpose: Playwright's testDir is
// `tests/e2e` and its default testMatch grabs *.test.ts too, so a readiness
// *.test.ts under tests/e2e would be run by BOTH Playwright and Vitest. Vitest's
// include is `tests/**/*.test.ts`, so it picks this up while Playwright ignores
// it (wrong directory).

// Fast poll tuning so the failure-path test doesn't sleep for real.
const FAST = { baseDelayMs: 1, maxDelayMs: 2, probeTimeoutMs: 500 } as const;

const servers: http.Server[] = [];

/** Spin an ephemeral HTTP server with a per-request handler; auto-closed after each test. */
async function startServer(
  handler: http.RequestListener,
): Promise<{ origin: string; server: http.Server }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, server };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe('httpGet', () => {
  it('resolves the status and body of a 200', async () => {
    const { origin } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    const { status, body } = await httpGet(origin);
    expect(status).toBe(200);
    expect(body).toBe('ok');
  });

  it('resolves { status: 0 } when the connection is refused (never rejects)', async () => {
    // Port 1 is not listening; the request errors → status 0 rather than throwing.
    const { status } = await httpGet('http://127.0.0.1:1', 300);
    expect(status).toBe(0);
  });
});

describe('pollUntilReady', () => {
  it('retries until the probe reports ready', async () => {
    let calls = 0;
    await pollUntilReady(
      'flaky thing',
      async () => {
        calls += 1;
        return { ready: calls >= 3, detail: `attempt ${calls}` };
      },
      { ...FAST, attempts: 10, log: () => {} },
    );
    expect(calls).toBe(3);
  });

  it('throws a clear harness-startup error after exhausting attempts', async () => {
    await expect(
      pollUntilReady('never-ready thing', async () => ({ ready: false, detail: 'still 404' }), {
        ...FAST,
        attempts: 3,
        log: () => {},
      }),
    ).rejects.toThrow(
      /never-ready thing did not become ready after 3 attempts[\s\S]*still 404[\s\S]*harness-startup failure/,
    );
  });
});

describe('waitForHttp200', () => {
  it('waits through 404s and resolves once the route flips to 200', async () => {
    let hits = 0;
    const { origin } = await startServer((_req, res) => {
      hits += 1;
      res.writeHead(hits < 3 ? 404 : 200);
      res.end();
    });
    await waitForHttp200(`${origin}/sign-up`, 'sign-up', { ...FAST, attempts: 10, log: () => {} });
    expect(hits).toBeGreaterThanOrEqual(3);
  });

  it('throws if the route stays 404', async () => {
    const { origin } = await startServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await expect(
      waitForHttp200(`${origin}/sign-up`, 'app auth route /sign-up', {
        ...FAST,
        attempts: 3,
        log: () => {},
      }),
    ).rejects.toThrow(/app auth route \/sign-up did not become ready/);
  });
});

// ⚠️ TWO `describe`s STOOD HERE — `parseInngestFunctionCount` and
// `waitForInngestReady` (MOTIR-3418 removed both with the second webServer).
// They probed the vendor dev server's `/dev` endpoint for a synced-function
// count, tolerated the pinned CLI's own `{ ids, status }` shape, and failed the
// gate when the executor never came up. The lane's executor is the engine's own
// worker now, and `startJobWorker` waits for its `[worker] started as` line —
// the process itself, not an HTTP probe of it.

describe('assertHarnessReady', () => {
  it('passes when the app auth route 200s', async () => {
    const { origin } = await startServer((req, res) => {
      res.writeHead(req.url === '/sign-up' ? 200 : 404);
      res.end('ok');
    });
    await expect(
      assertHarnessReady({
        baseUrl: origin,
        poll: { ...FAST, attempts: 5, log: () => {} },
      }),
    ).resolves.toBeUndefined();
  });

  it('fails fast on the app auth route when /sign-up 404s (the MOTIR-1565 signature)', async () => {
    const { origin } = await startServer((req, res) => {
      // Root redirects (server "up") but /sign-up 404s — exactly the
      // half-started-server signature this gate must catch.
      if (req.url === '/') {
        res.writeHead(307, { Location: '/login' });
        res.end();
        return;
      }
      res.writeHead(req.url === '/sign-up' ? 404 : 200);
      res.end();
    });
    await expect(
      assertHarnessReady({
        baseUrl: origin,
        poll: { ...FAST, attempts: 3, log: () => {} },
      }),
    ).rejects.toThrow(/app auth route \/sign-up did not become ready/);
  });
});
