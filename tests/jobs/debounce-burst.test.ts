import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { Inngest } from 'inngest';
import { createServer } from 'inngest/node';
import { codeGraphRefresh } from '@/lib/jobs/definitions/codeGraphRefresh';

// ─────────────────────────────────────────────────────────────────────────────
// A DEBOUNCE IS A CLAIM ABOUT THE SCHEDULER, AND UNTIL THIS FILE NOTHING TESTED
// IT (MOTIR-2994).
//
// `tests/jobs/code-graph-index.test.ts` pins that `system.code-graph-refresh`
// carries `debounce: { key, period: '2m', timeout: '15m' }` — read off `fn.opts`,
// which is the right way to assert CONFIG. But that assertion passes whatever the
// runtime does with the option, and the thing the config is FOR — "rapid pushes
// to the same repo coalesce into one run" — is a property of Inngest's executor.
// `docs/decisions/code-graph-index-fleet.md` §7.3 reasons from that coalescing
// being real ("one container per (repo × project) per debounced push"), so a
// scheduler that DROPPED the second same-key run instead of coalescing it would
// leave every push after the first unindexed, and every existing assertion green.
//
// So this file drives the REAL scheduler: it boots the pinned `inngest-cli` dev
// server — the same binary `playwright.config.ts` boots for E2E, and the one a
// self-hosted deployment runs — registers a probe function, sends a burst, and
// COUNTS THE RUNS. Against a run-dropping scheduler the first case measures 0
// runs where it requires 1; against one that ignores `debounce` entirely it
// measures 6. Both fail.
//
// Why a probe function and not the shipped job: the shipped job's period is 2
// MINUTES and its handler supervises containers, so driving it here would be a
// two-minute test of the fleet. What is under test is the EXECUTOR's treatment
// of the option, which is job-independent. The shipped config stays pinned where
// it belongs — on `fn.opts`, in `code-graph-index.test.ts` — and the last case
// here ties the two together by checking the one property of that config the
// measurements below turn on: that its key expression can always resolve.
//
// Measured on `inngest-cli` 1.27.0 / SDK 4.5.0. The standalone probe that
// produced the numbers in `docs/jobs.md` § Debounce — including the two
// behaviours that DIVERGE from the documented contract — is
// `scripts/experiments/inngest-debounce-coalescing.mjs`.
// ─────────────────────────────────────────────────────────────────────────────

const CLI_BIN = 'node_modules/inngest-cli/bin/inngest';
/** The probe window. The documented MINIMUM is 1s and a case at 1s DOES pass —
 *  but only just: the burst below is sent one awaited round-trip at a time, so a
 *  single >1s hiccup anywhere in that loop expires the window mid-burst and
 *  splits one expected run into two (measured: 1 failure in 6 local runs at
 *  `1s`). 3s buys the loop two orders of magnitude more slack than it needs and
 *  costs two seconds a case — the right trade for a spec that must never flake,
 *  since a flaky spec on `main` taxes every open PR's merge-with-main CI. */
const PERIOD = '3s';
/** Period + scheduler slack: the run lands ~1.2–1.5s after the window closes. */
const SETTLE_MS = 8_000;

/** Ask the OS for a free port. Parallel vitest workers must not collide, and a
 *  dev server whose port is taken does NOT fail — it silently moves to another
 *  one and the harness then talks to a server nothing is registered with. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createTcpServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (typeof address === 'string' || address === null) {
        probe.close(() => reject(new Error('no port')));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

let devProc: ChildProcess;
let devUrl: string;
let servePort: number;
/** Everything the probe functions serve on; one HTTP server for the whole file. */
const functions: ReturnType<Inngest['createFunction']>[] = [];
const runs: { fn: string; key: string; n: number }[] = [];
let client: Inngest;

/** A probe function with the given debounce key, recording every run it gets. */
function probe(id: string, key: string) {
  return client.createFunction(
    // Triggers belong in the options object — the 3-arg v3 form throws in
    // inngest@4.5.
    {
      id,
      retries: 0,
      triggers: [{ event: `debounce-probe/${id}` }],
      debounce: { key, period: PERIOD },
    },
    async ({ event }) => {
      runs.push({ fn: id, key: String(event.data.key ?? ''), n: Number(event.data.n) });
      return id;
    },
  );
}

beforeAll(async () => {
  const devPort = await freePort();
  const gatewayPort = await freePort();
  const gatewayGrpcPort = await freePort();
  const executorGrpcPort = await freePort();
  servePort = await freePort();
  devUrl = `http://127.0.0.1:${devPort}`;

  client = new Inngest({
    id: `debounce-burst-${servePort}`,
    // `isDev: '<url>'` does NOT put the client in dev mode — it leaves it in
    // cloud mode and `send()` throws "couldn't find an event key". It is
    // `isDev: true` plus `baseUrl`.
    isDev: true,
    baseUrl: devUrl,
    eventKey: 'test',
  });

  functions.push(
    probe('coalesce', 'event.data.key'),
    probe('per-key', 'event.data.key'),
    probe('unresolvable', 'event.data.absentOnEveryEvent'),
  );

  const serve = createServer({ client, functions });
  await new Promise<void>((resolve) => serve.listen(servePort, resolve));

  devProc = spawn(
    CLI_BIN,
    [
      'dev',
      '-u',
      `http://127.0.0.1:${servePort}/api/inngest`,
      '--no-discovery',
      '--port',
      String(devPort),
      '--connect-gateway-port',
      String(gatewayPort),
      '--connect-gateway-grpc-port',
      String(gatewayGrpcPort),
      '--connect-executor-grpc-port',
      String(executorGrpcPort),
    ],
    { stdio: 'ignore' },
  );

  // Wait for the dev server to answer, then sync our functions to it.
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const health = await fetch(`${devUrl}/dev`);
      if (health.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`inngest dev never came up on ${devUrl}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  // The SDK mis-parses the 1.27 dev server's register response (`status` arrives
  // as a string), so a "Failed to register" BODY is not a failure — the HTTP
  // status is what to check.
  const registration = await fetch(`http://127.0.0.1:${servePort}/api/inngest`, { method: 'PUT' });
  expect(registration.ok).toBe(true);
  await new Promise((r) => setTimeout(r, 2_000));
}, 60_000);

afterAll(() => {
  devProc?.kill('SIGKILL');
});

/** Send `events` to one probe, wait past the debounce window, return its runs.
 *
 *  ONE AWAITED `send` PER EVENT, deliberately. Handing the whole array to a
 *  single `send` coalesces just as well — the standalone harness measures that
 *  shape too — but the server does not then preserve the array's order, so
 *  "the LATEST event won" becomes a coin flip (it was, at 4 of 6). Sending
 *  serially is also what a webhook-driven producer actually does. */
async function burst(
  fn: string,
  events: Record<string, unknown>[],
): Promise<{ key: string; n: number }[]> {
  const before = runs.length;
  for (const data of events) {
    await client.send({ name: `debounce-probe/${fn}`, data });
  }
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  return runs.slice(before).filter((r) => r.fn === fn);
}

describe('debounce — what the SCHEDULER does with a burst (inngest-cli 1.27.0)', () => {
  it('coalesces a same-key burst into exactly ONE run, carrying the LAST event', async () => {
    const seen = await burst(
      'coalesce',
      Array.from({ length: 6 }, (_, i) => ({ key: 'acme/widgets', n: i + 1 })),
    );

    // ⚠️ THE ASSERTION THE CLASS WAS MISSING. `toHaveLength(1)` fails in BOTH
    // directions a debounce can be broken: 0 (the scheduler dropped the run it
    // could not enqueue — the failure MOTIR-2994 was filed to look for) and 6
    // (the option silently ignored). A config-level assertion catches neither.
    expect(seen).toHaveLength(1);
    // And it is the LATEST event that survives, which is what makes the
    // coalesced refresh index the newest head rather than a stale one.
    expect(seen[0]?.n).toBe(6);
  }, 60_000);

  it('gives every distinct key its OWN run — one repo’s burst cannot swallow another’s', async () => {
    const seen = await burst(
      'per-key',
      ['acme/alpha', 'acme/beta', 'acme/gamma'].flatMap((key) =>
        [1, 2, 3].map((n) => ({ key, n })),
      ),
    );

    // Nine events, three keys, three runs — and the set of keys matters as much
    // as the count: a scheduler that dropped one key's run entirely would still
    // satisfy a bare `toHaveLength(3)` if another key ran twice.
    expect(seen).toHaveLength(3);
    expect([...new Set(seen.map((r) => r.key))].sort()).toEqual([
      'acme/alpha',
      'acme/beta',
      'acme/gamma',
    ]);
  }, 60_000);

  it('collapses every event whose key EXPRESSION does not resolve into ONE shared bucket', async () => {
    const seen = await burst(
      'unresolvable',
      Array.from({ length: 6 }, (_, i) => ({ key: `unrelated-${i + 1}`, n: i + 1 })),
    );

    // ⚠️ THIS IS A CHARACTERIZATION, NOT AN ENDORSEMENT — it pins the trap.
    // Six unrelated events, a key expression naming a field NONE of them carries,
    // and the scheduler does not fall back to "not debounced": it debounces them
    // ALL TOGETHER, so five units of work vanish with nothing raised to the
    // caller. Inngest documents no behaviour for an unresolvable key, so this is
    // measured, and it is why the rule in `docs/jobs.md` § Debounce is that a
    // debounce key may only name fields the event payload type makes REQUIRED.
    // MOTIR-2902 is the instance: `key: 'event.data.parentId'` on
    // `work-item/created`, where a ROOT item has no parent.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.n).toBe(6);
  }, 60_000);

  it('the shipped `code-graph-refresh` key names only fields its payload REQUIRES', () => {
    // The tie between the three measurements above and the job that depends on
    // them. `CodeGraphRefreshData` makes all three fields non-optional, so the
    // concatenated key always resolves and the previous case's collapse cannot
    // reach this job. A field turned optional would break that silently —
    // TypeScript is happy either way, because the key is a CEL STRING.
    const config = (codeGraphRefresh as unknown as { opts: Record<string, unknown> }).opts as {
      debounce?: { key: string };
    };
    const key = config.debounce?.key ?? '';
    expect(key).toContain('event.data.installationId');
    expect(key).toContain('event.data.repoOwner');
    expect(key).toContain('event.data.repoName');

    const required: Record<keyof CodeGraphRefreshKeyFields, true> = {
      installationId: true,
      repoOwner: true,
      repoName: true,
    };
    expect(Object.keys(required).sort()).toEqual(['installationId', 'repoName', 'repoOwner']);
  });
});

/** The three payload fields the debounce key reads. Assigning them from
 *  `CodeGraphRefreshData` is what makes the test above a COMPILE-time check that
 *  none of them is optional: an optional field would not satisfy `-?`. */
type CodeGraphRefreshKeyFields = {
  [K in 'installationId' | 'repoOwner' | 'repoName']-?: NonNullable<
    import('@/lib/jobs/types').CodeGraphRefreshData[K]
  >;
};
