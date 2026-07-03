// E2E harness readiness gate (MOTIR-1565).
//
// Playwright's built-in `webServer.url` check treats ANY response < 404 as
// "ready" (see playwright-core isURLAvailable: `statusCode >= 200 && < 404`).
// The app's root URL redirects the instant the dev-server socket is up, so the
// suite used to start against a HALF-started server: `/sign-up` still 404'd
// (breaking every account-creating shell flow) and the inngest dev server's
// `PUT /api/inngest` 404-cascaded because the serve route wasn't registered yet
// (MOTIR-1565 — PR #1517, bulk-4: 8 red shell-flows specs from one bad shard
// start, not a product regression).
//
// This module is the authoritative gate the Playwright globalSetup runs AFTER
// both webServers report their `url` ready but BEFORE the first spec. It polls
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
  /** Response body (capped at ~1MB — we only parse the small inngest /dev JSON). */
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

/**
 * Parse the inngest dev server's `/dev` payload for its synced-function count.
 * Returns `null` when the body isn't JSON or has no `functions` array (an
 * inngest-version shape we don't recognise) — the caller then falls back to
 * treating a 200 as ready rather than coupling the gate to an unstable shape.
 */
export function parseInngestFunctionCount(body: string): number | null {
  try {
    const json: unknown = JSON.parse(body);
    if (
      json &&
      typeof json === 'object' &&
      Array.isArray((json as { functions?: unknown }).functions)
    ) {
      return (json as { functions: unknown[] }).functions.length;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Wait until the inngest dev server (the executor) is up and answering. Polls
 * its `/dev` probe endpoint — the SDK's own dev-server-detection route, which
 * 200s once the executor is listening. Where a payload exposes a `functions`
 * array (a positive "app synced ≥1 function" signal), we require it to be
 * non-empty; the pinned `inngest-cli` instead returns `{ ids, status }` with no
 * function list, so a 200 alone is accepted there. The AUTHORITATIVE sync
 * guarantee is the app-side `/api/inngest` 200 gate in `assertHarnessReady`:
 * once the serve route is registered, the dev server's PUT-sync (the request
 * that 404-cascaded in MOTIR-1565) can no longer fail — so this check only has
 * to confirm the executor process itself came up.
 */
export async function waitForInngestReady(
  inngestBaseUrl: string,
  opts: PollOptions = {},
): Promise<void> {
  const devUrl = new URL('/dev', inngestBaseUrl).toString();
  await pollUntilReady(
    'inngest dev server',
    async () => {
      const { status, body } = await httpGet(
        devUrl,
        opts.probeTimeoutMs ?? DEFAULTS.probeTimeoutMs,
      );
      if (status !== 200) return { ready: false, detail: `GET ${devUrl} -> ${status}` };
      const count = parseInngestFunctionCount(body);
      if (count === null) {
        return {
          ready: true,
          detail: `GET ${devUrl} -> 200 (functions count unknown; treating as ready)`,
        };
      }
      return { ready: count > 0, detail: `GET ${devUrl} -> 200, functions=${count}` };
    },
    opts,
  );
}

export interface HarnessReadyOptions {
  /** The origin Playwright drives (e.g. http://localhost:3000). */
  baseUrl: string;
  /** The inngest dev server origin (e.g. http://localhost:8288). */
  inngestBaseUrl: string;
  /** Shared poll tuning (attempts / backoff / log). */
  poll?: PollOptions;
}

/**
 * The full harness readiness gate, in dependency order:
 *   1. the app auth route `/sign-up` returns 200 (the exact route that 404'd —
 *      every account-creating shell flow starts here),
 *   2. the app inngest serve route `/api/inngest` returns 200 (once open, the
 *      dev server's PUT-sync can no longer 404-cascade), then
 *   3. the inngest dev server (executor) is up and answering its `/dev` probe.
 * Throws (from the first failing check) if the server never comes up cleanly.
 */
export async function assertHarnessReady({
  baseUrl,
  inngestBaseUrl,
  poll = {},
}: HarnessReadyOptions): Promise<void> {
  await waitForHttp200(new URL('/sign-up', baseUrl).toString(), 'app auth route /sign-up', poll);
  await waitForHttp200(
    new URL('/api/inngest', baseUrl).toString(),
    'app inngest serve /api/inngest',
    poll,
  );
  await waitForInngestReady(inngestBaseUrl, poll);
}
