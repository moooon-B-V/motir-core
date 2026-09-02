/**
 * Child-process harness for `tests/auth/session-request-memo.test.ts` (MOTIR-2453).
 *
 * ── Why this is a separate process and not just a test ──────────────────────
 *
 * React's `cache()` only memoises inside a SERVER render, and "server" there is
 * literal: the memoisation lives in the `react-server` build of React, reached
 * only under Node's `--conditions=react-server`. The default (client) build
 * exports `cache` as a pass-through, so a test running in Vitest's ordinary
 * worker would measure a no-op and pass whether or not the fix is present —
 * the worst kind of green. Nor does `react-dom/server` help: Fizz installs no
 * request cache scope (measured: the same three-deep tree still calls through
 * three times under `renderToReadableStream`).
 *
 * So the harness runs under `node --conditions=react-server` and renders through
 * the RSC Flight renderer — the same renderer Next.js drives App Router server
 * components with, and the thing that actually installs the per-request cache
 * scope. That makes the count a measurement of the production mechanism rather
 * than of a stand-in for it.
 *
 * Every mode prints ONE line of JSON prefixed with `PROBE_RESULT ` on stdout.
 * Run it via the test; the invocation (env, node flags) is part of the contract.
 */
import Module from 'node:module';
import { Writable } from 'node:stream';

/**
 * `getSession()` reads `next/headers`, which throws outside a Next request
 * scope. Rather than reconstruct Next's internal async-storage stack — a
 * private shape that would rot on the next upgrade — swap the module for the
 * one thing the code under test asks of it: a `Headers`.
 *
 * ⚠️ THERE IS A SECOND SUBSTITUTION NOW, AND IT IS A DIFFERENT KIND OF THING
 * (MOTIR-3909). `server-only` is a build-time MARKER: Next resolves it to a
 * no-op on the server and to a throw in a client bundle, and it has no runtime
 * behaviour to stand in for. Plain Node cannot resolve it at all — it is in
 * neither `package.json` nor `node_modules`, and the three Vitest configs each
 * alias it to `tests/stubs/server-only.ts` for exactly this reason. This
 * harness is the FOURTH environment that loads application code outside Vite
 * and it had no such alias, so the first server-only module to enter the graph
 * took the whole probe down with `Cannot find module 'server-only'` —
 * `lib/legal/documents.ts`, reached through `legalAcceptanceService`, on the
 * day it stopped reading `content/legal/` and started reading configuration.
 * Stubbing it RESTORES the environment rather than replacing anything under
 * test, which is why it does not weaken the claim below.
 *
 * `@/lib/auth` and React are still the real ones, and that is the claim that
 * matters: nothing that participates in the MEASUREMENT is substituted.
 */
const REQUEST_HEADERS = new Headers({ cookie: 'better-auth.session_token=probe-token' });
const ANONYMOUS_HEADERS = new Headers();

type Loader = (request: string, ...rest: unknown[]) => unknown;

function installModuleStubs(headers: Headers): void {
  const moduleInternals = Module as unknown as { _load: Loader };
  const load = moduleInternals._load;
  moduleInternals._load = function loadWithStubs(request: string, ...rest: unknown[]) {
    if (request === 'next/headers') return { headers: async () => headers };
    // The marker, not a module: an empty object is what Next resolves it to on
    // the server, and every consumer imports it for its side effect only.
    if (request === 'server-only') return {};
    return load.call(this, request, ...rest);
  };
}

/** Drain a Flight stream to completion, so every async component has run. */
async function renderToCompletion(element: unknown): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const flight = require('next/dist/compiled/react-server-dom-webpack/server.node');
  const stream = flight.renderToPipeableStream(element, {});
  await new Promise<void>((resolve, reject) => {
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    sink.on('finish', () => resolve());
    sink.on('error', reject);
    stream.pipe(sink);
  });
}

function emit(result: Record<string, unknown>): void {
  process.stdout.write(`PROBE_RESULT ${JSON.stringify(result)}\n`);
}

/**
 * Render a three-deep async server-component tree — the nesting an authenticated
 * page render actually has (`app/layout.tsx` → `app/(authed)/layout.tsx` → the
 * page) — and count how many times Better-Auth's `auth.api.getSession` is
 * reached underneath.
 *
 * `readSession` is the ONLY difference between the two modes, which is what
 * makes `direct` a control rather than decoration: same tree, same renderer,
 * same three call sites, and the only variable is whether the read goes through
 * the memoised helper. A harness that could not see three would not be evidence
 * of one.
 */
async function countSessionLookups(mode: 'memoized' | 'direct'): Promise<void> {
  installModuleStubs(REQUEST_HEADERS);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // Required AFTER the stub is installed — `@/lib/auth` imports `next/headers`
  // at module scope.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { auth, getSession } = require('@/lib/auth');

  let sessionApiCalls = 0;
  auth.api.getSession = async () => {
    sessionApiCalls += 1;
    return { user: { id: 'probe-user' }, session: { id: 'probe-session' } };
  };

  const readSession =
    mode === 'memoized'
      ? () => getSession()
      : () => auth.api.getSession({ headers: REQUEST_HEADERS });

  async function Page() {
    await readSession();
    return React.createElement('p', null, 'page');
  }
  async function AuthedLayout() {
    await readSession();
    return React.createElement('div', null, React.createElement(Page));
  }
  async function RootLayout() {
    await readSession();
    return React.createElement('main', null, React.createElement(AuthedLayout));
  }

  await renderToCompletion(React.createElement(RootLayout));
  emit({ mode, sessionApiCalls });
}

/**
 * The unauthenticated path, measured the same way: against a DATABASE_URL that
 * points at nothing. A session lookup that reached Postgres could only fail
 * there, so "resolved to null" IS the proof that no round-trip happened — no
 * query spy required, and nothing to keep in sync with Prisma's internals.
 *
 * `db-control` is what makes that argument load-bearing: it issues a query that
 * genuinely needs the database and reports the failure, so a `null` from
 * `anonymous` cannot be dismissed as an unreachable-database that was never
 * actually unreachable.
 */
async function probeAnonymous(mode: 'anonymous' | 'db-control'): Promise<void> {
  installModuleStubs(ANONYMOUS_HEADERS);

  try {
    if (mode === 'anonymous') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getSession } = require('@/lib/auth');
      const session = await getSession();
      emit({ mode, outcome: session === null ? 'null' : 'session' });
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { db } = require('@/lib/db');
    // Left on `@/lib/db` deliberately (MOTIR-2792 audit): `session` is an AUTH table,
    // not workspace-scoped, so no policy applies and there is no tenant to bind. The
    // probe's point is that the connection can reach it at all.
    await db.session.findFirst();
    emit({ mode, outcome: 'reached-database' });
  } catch (error) {
    emit({ mode, outcome: 'threw', message: String((error as Error)?.message).slice(0, 200) });
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  switch (mode) {
    case 'memoized':
    case 'direct':
      return countSessionLookups(mode);
    case 'anonymous':
    case 'db-control':
      return probeAnonymous(mode);
    default:
      throw new Error(`Unknown probe mode: ${String(mode)}`);
  }
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`${String((error as Error)?.stack ?? error)}\n`);
    process.exit(1);
  },
);
