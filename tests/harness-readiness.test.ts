import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  assertHarnessReady,
  httpGet,
  parseInngestFunctionCount,
  pollUntilReady,
  waitForHttp200,
  waitForInngestReady,
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

describe('parseInngestFunctionCount', () => {
  it('returns the length of the functions array', () => {
    expect(
      parseInngestFunctionCount(JSON.stringify({ functions: [{ id: 'a' }, { id: 'b' }] })),
    ).toBe(2);
    expect(parseInngestFunctionCount(JSON.stringify({ functions: [] }))).toBe(0);
  });

  it('returns null for non-JSON or an unrecognised shape', () => {
    expect(parseInngestFunctionCount('<html>not json</html>')).toBeNull();
    expect(parseInngestFunctionCount(JSON.stringify({ version: '1.2.3' }))).toBeNull();
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

describe('waitForInngestReady', () => {
  it('waits until /dev reports at least one synced function (when the payload exposes one)', async () => {
    let hits = 0;
    const { origin } = await startServer((req, res) => {
      if (req.url !== '/dev') {
        res.writeHead(404);
        res.end();
        return;
      }
      hits += 1;
      // functions empty until the app "syncs" on the 2nd probe.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ functions: hits >= 2 ? [{ id: 'email.send' }] : [] }));
    });
    await waitForInngestReady(origin, { ...FAST, attempts: 10, log: () => {} });
    expect(hits).toBeGreaterThanOrEqual(2);
  });

  it('accepts the pinned inngest-cli /dev shape ({ ids, status }, no functions list) as ready', async () => {
    // The exact body the bundled `inngest-cli dev` returns on `/dev` — no
    // `functions` array, so the gate must NOT hard-wait for a function count.
    const { origin } = await startServer((req, res) => {
      res.writeHead(req.url === '/dev' ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(req.url === '/dev' ? JSON.stringify({ ids: ['stub'], status: 200 }) : '');
    });
    await expect(
      waitForInngestReady(origin, { ...FAST, attempts: 3, log: () => {} }),
    ).resolves.toBeUndefined();
  });

  it('throws when the dev server never returns 200', async () => {
    const { origin } = await startServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    await expect(
      waitForInngestReady(origin, { ...FAST, attempts: 3, log: () => {} }),
    ).rejects.toThrow(/inngest dev server did not become ready/);
  });
});

describe('assertHarnessReady', () => {
  it('passes when the app routes 200 and inngest reports functions synced', async () => {
    const { origin } = await startServer((req, res) => {
      if (req.url === '/sign-up' || req.url === '/api/inngest') {
        res.writeHead(200);
        res.end('ok');
        return;
      }
      if (req.url === '/dev') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ functions: [{ id: 'email.send' }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    // Same origin serves the app routes and the inngest /dev endpoint (the
    // paths don't collide), so one server stands in for both here.
    await expect(
      assertHarnessReady({
        baseUrl: origin,
        inngestBaseUrl: origin,
        poll: { ...FAST, attempts: 5, log: () => {} },
      }),
    ).resolves.toBeUndefined();
  });

  it('fails fast on the app auth route when /sign-up 404s (the MOTIR-1565 signature)', async () => {
    const { origin } = await startServer((req, res) => {
      // Root redirects (server "up"), /api/inngest is fine, but /sign-up 404s —
      // exactly the half-started-server signature this gate must catch.
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
        inngestBaseUrl: origin,
        poll: { ...FAST, attempts: 3, log: () => {} },
      }),
    ).rejects.toThrow(/app auth route \/sign-up did not become ready/);
  });
});
