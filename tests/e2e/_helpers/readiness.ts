// E2E harness readiness gate (MOTIR-1565).
//
// Playwright's built-in `webServer.url` check treats ANY response < 404 as
// "ready" (see playwright-core isURLAvailable: `statusCode >= 200 && < 404`).
// The app's root URL redirects the instant the dev-server socket is up, so the
// suite used to start against a HALF-started server: `/sign-up` still 404'd
// (breaking every account-creating shell flow) and, until MOTIR-3418, the
// vendor dev server's `PUT /api/inngest` 404-cascaded because the serve route
// wasn't registered yet (MOTIR-1565 — PR #1517, bulk-4: 8 red shell-flows specs
// from one bad shard start, not a product regression).
//
// ⚠️ THE SECOND HALF OF THAT GATE IS GONE WITH THE SECOND SERVER. There is one
// webServer now and the executor is the engine's own worker, a child of the
// runner — so what is left to probe is the app, and only the app.
//
// This module is the authoritative gate the Playwright globalSetup runs AFTER
// the webServer reports its `url` ready but BEFORE the first spec. It polls
// the routes the suite actually depends on, with bounded retry/backoff, and
// THROWS a clear error if the server never comes up — so a genuine startup
// failure reds the global-setup step alone, not the whole suite.
//
// Deliberately dependency-free (node:http/https only): it must not import the
// app (`@/lib/*`) or any spec helper, so it can run before anything else and be
// unit-tested in isolation (tests/harness-readiness.test.ts).

import * as http from 'node:http';
import * as https from 'node:https';

export interface HttpProbeResult {
  /** HTTP status code, or 0 on a connection error / timeout. */
  status: number;
  /** Response body (capped at ~1MB). */
  body: string;
}

/**
 * GET a URL and resolve its status + body. Never rejects — a connection error
 * or timeout resolves to `{ status: 0 }` so the caller's poll loop keeps going.
 */
export function httpGet(url: string, timeoutMs = 5_000): Promise<HttpProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: HttpProbeResult): void => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { Accept: '*/*' } }, (res) => {
      const status = res.statusCode ?? 0;
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (c: Buffer) => {
        bytes += c.length;
        if (bytes <= 1_000_000) chunks.push(c);
      });
      res.on('end', () => done({ status, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => done({ status, body: '' }));
    });
    req.on('error', () => done({ status: 0, body: '' }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      done({ status: 0, body: '' });
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface PollOptions {
  /** Total probe attempts before giving up (default 45 ≈ ~90s at the delay cap). */
  attempts?: number;
  /** First backoff delay in ms; doubles each miss up to `maxDelayMs` (default 500). */
  baseDelayMs?: number;
  /** Backoff ceiling in ms (default 2_000). */
  maxDelayMs?: number;
  /** Per-probe HTTP timeout in ms (default 5_000). */
  probeTimeoutMs?: number;
  /** Progress sink; defaults to `console.warn` (eslint-clean, goes to stderr). */
  log?: (msg: string) => void;
}

const DEFAULTS = { attempts: 45, baseDelayMs: 500, maxDelayMs: 2_000, probeTimeoutMs: 5_000 };

/**
 * Poll `probe` with exponential backoff until it reports `ready`, or throw a
 * clear harness-startup error once `attempts` is exhausted. The thrown message
 * names the last observed state so a CI failure is unambiguous.
 */
export async function pollUntilReady(
  label: string,
  probe: () => Promise<{ ready: boolean; detail: string }>,
  opts: PollOptions = {},
): Promise<void> {
  const attempts = opts.attempts ?? DEFAULTS.attempts;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const log = opts.log ?? ((m: string) => console.warn(m));

  let lastDetail = 'no attempt made';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { ready, detail } = await probe();
    lastDetail = detail;
    if (ready) {
      log(`[e2e-readiness] ${label}: ready (attempt ${attempt}/${attempts}) — ${detail}`);
      return;
    }
    if (attempt < attempts) {
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      log(
        `[e2e-readiness] ${label}: not ready (attempt ${attempt}/${attempts}) — ${detail}; retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }
  throw new Error(
    `[e2e-readiness] ${label} did not become ready after ${attempts} attempts (last: ${lastDetail}). ` +
      `The E2E harness aborted BEFORE running any spec because the server was not fully up. ` +
      `This is a harness-startup failure, NOT a product regression on the PR under test (MOTIR-1565).`,
  );
}

/** Wait until `url` returns HTTP 200. */
export async function waitForHttp200(
  url: string,
  label: string,
  opts: PollOptions = {},
): Promise<void> {
  await pollUntilReady(
    label,
    async () => {
      const { status } = await httpGet(url, opts.probeTimeoutMs ?? DEFAULTS.probeTimeoutMs);
      return { ready: status === 200, detail: `GET ${url} -> ${status}` };
    },
    opts,
  );
}

export interface HarnessReadyOptions {
  /** The origin Playwright drives (e.g. http://localhost:3000). */
  baseUrl: string;
  /** Shared poll tuning (attempts / backoff / log). */
  poll?: PollOptions;
}

/**
 * The harness readiness gate: the app auth route `/sign-up` returns 200 — the
 * exact route that 404'd, and the one every account-creating shell flow starts
 * at. Throws if the server never comes up cleanly.
 *
 * ⚠️ IT USED TO BE THREE CHECKS (MOTIR-3418 removed two). The others were the
 * app's `/api/inngest` serve route and the vendor dev server's own `/dev` probe,
 * in that order, because the dev server SYNCED against the serve route and a
 * sync issued before the route existed 404-cascaded. Neither the route nor the
 * dev server exists now, and the engine's worker needs no sync at all: it reads
 * the registry out of its own bundle. `startJobWorker` in globalSetup already
 * waits for the worker's own `[worker] started as` line, which is a stronger
 * signal than any HTTP probe of it would be.
 */
export async function assertHarnessReady({
  baseUrl,
  poll = {},
}: HarnessReadyOptions): Promise<void> {
  await waitForHttp200(new URL('/sign-up', baseUrl).toString(), 'app auth route /sign-up', poll);
}
