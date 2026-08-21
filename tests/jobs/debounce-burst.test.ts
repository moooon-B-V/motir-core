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
/** The probe window, in ms — the string form is DERIVED from it so the value the
 *  scheduler is given and the value {@link stallDiagnosis} compares against
 *  cannot drift apart.
 *
 *  The documented MINIMUM is 1s and a case at 1s DOES pass — but only just: the
 *  burst below is sent one awaited round-trip at a time, so a single >1s hiccup
 *  anywhere in that loop expires the window mid-burst (measured: 1 failure in 6
 *  local runs at `1s`). 3s costs two seconds a case.
 *
 *  ⚠️ AND 3s IS NOT ENOUGH EITHER, WHICH IS WHY THIS FILE NO LONGER RELIES ON IT
 *  (MOTIR-3125). The comment here used to claim 3s bought "two orders of
 *  magnitude more slack than it needs"; a CI shard running 4 932 tests over
 *  4 253 s of test time expired the window anyway. Widening it again would be a
 *  probability reduction on a shared file — the same move, already made once,
 *  already failed once. What changed instead is that a stall is now DETECTED and
 *  NAMED rather than tolerated, so the next occurrence reports what happened
 *  instead of a bare value mismatch. */
const PERIOD_MS = 3_000;
const PERIOD = `${PERIOD_MS / 1000}s`;
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
/** The widest gap between two consecutive sends of one burst, 1-based. */
interface SendGap {
  ms: number;
  from: number;
  to: number;
}

/**
 * The message for a burst whose own send loop stalled past the debounce window —
 * or `null` when it did not (MOTIR-3125).
 *
 * ⚠️ WHY THIS EXISTS AT ALL. Every assertion in this file carries an unstated
 * precondition: that all of a burst's events reached the scheduler INSIDE one
 * debounce window. When the runner stalls past `PERIOD` that precondition fails,
 * and the file used to report the consequence rather than the cause — a bare
 * `expected 5 to be 6`, which reads exactly like the scheduler changing its
 * behaviour. Naming the stall converts an environmental failure into one that
 * explains itself.
 *
 * ⚠️ AND THE STALL DOES NOT ALWAYS PRESENT AS TWO RUNS, which is the trap that
 * cost this its diagnosis once already. The header above used to say a hiccup
 * "splits one expected run into two", so a reader greps for a LENGTH mismatch.
 * That is only true when the stall falls in the MIDDLE of a burst. When it falls
 * between the last two events, the tail event opens its own window whose run
 * lands after `SETTLE_MS` and is never observed at all — so `toHaveLength(1)`
 * passes and only the payload assertion fails. Both presentations are the same
 * mechanism, and this check sees both because it watches the SENDS rather than
 * the runs.
 *
 * ⚠️ AND OUR OWN CLOCK CANNOT ANSWER THE QUESTION AT ALL, WHICH IS WHY THE
 * SCHEDULER'S IS PASSED IN (MOTIR-3371). `spanMs` is measured from our own
 * send-ACKS. The window opens when the SCHEDULER receives event 1 and closes
 * `PERIOD` later on ITS clock, so a slow ack on the FIRST send alone moves our
 * start marker forward and hides the overrun: the 5th occurrence of this file's
 * `expected 5 to be 6` arrived with both terms below `PERIOD_MS` and the
 * diagnosis silent (PR #2247's `Vitest (2/3)`, run `32494861262`, 2026-08-21).
 * A span under `PERIOD_MS` on our clock does not prove the burst fit.
 *
 * `schedulerSpanMs` closes that: the dev server stamps each event with its OWN
 * `received_at` (`GET /v1/events/{id}`), so the span across the burst is
 * measured end to end on ONE clock, with our request latency out of it. Measured
 * on this box, a 4-event burst read **610 ms** from our acks and **754 ms** from
 * the scheduler's records — the two disagree by a quarter of the span, in the
 * direction that hides a miss. (The sibling field `ts` is NOT a substitute: it
 * is client-supplied and echoes back whatever the sender put there — an event
 * sent with `ts` an hour in the past returns it verbatim, while `received_at`
 * stays in sequence.)
 *
 * It is `null` when the scheduler's records could not be read, and then this
 * behaves exactly as it did before — a degradation, not a silent pass: the real
 * case below asserts the signal IS obtainable, so a CLI upgrade that withdraws
 * `received_at` goes red here instead of quietly reverting the check.
 *
 * ⚠️ AND A WINDOW MISS IS NOT THE ONLY PRODUCER OF `expected N to be 6` — do not
 * read a silent diagnosis as "so the burst was fine". Running this file ten
 * times with the scheduler's span recorded caught the SAME failure twice at
 * `schedulerSpanMs: 0` and `1`: six events inside one millisecond, one run, and
 * it carried event 5 (then 4). That is the scheduler coalescing correctly and
 * not keeping the last event, which the payload assertions above ask it to —
 * MOTIR-3398 owns that, and it is why this term's silence is informative rather
 * than exculpatory.
 *
 * PURE and exported so its directions are asserted directly, with synthetic
 * gaps, rather than by stalling a real runner for three seconds per case.
 */
export function stallDiagnosis(
  fn: string,
  worst: SendGap | null,
  spanMs = 0,
  schedulerSpanMs: number | null = null,
): string | null {
  // THREE ways the precondition fails, and only one of them is a stall
  // (MOTIR-3276, MOTIR-3371).
  //
  // ⚠️ THE WINDOW OPENS AT THE FIRST EVENT AND IS NOT RE-ARMED BY LATER ONES, so
  // what the burst needs is *every event inside ONE window* — a property of its
  // SPAN, not of adjacent gaps. Six sends of 600 ms have a worst gap of 600 ms
  // and a span of 3 600 ms: the window closes mid-burst, the tail event's run
  // lands after `SETTLE_MS` and is never observed, `toHaveLength(1)` passes, and
  // only `seen[0].n` is wrong — the exact presentation the header above
  // describes, with no gap anywhere near the threshold to report.
  //
  // That is a real occurrence, not a hypothetical: 2026-08-20, PR #2223's
  // `Vitest (2/3)`, on a diff of one env var and an ADR. The gap check said
  // nothing and the failure arrived as the bare `expected 5 to be 6` this
  // function exists to prevent.
  const stalled = worst !== null && worst.ms >= PERIOD_MS;
  const missed = schedulerSpanMs !== null && schedulerSpanMs >= PERIOD_MS;
  const overran = spanMs >= PERIOD_MS;
  if (!stalled && !missed && !overran) return null;

  // Precedence is by how sharply each term names the CAUSE, not by how bad it
  // looks. A single stalled send explains everything downstream of it, so it
  // wins; between the two spans the SCHEDULER's is the authoritative one and
  // ours is the proxy, so it is reported with ours beside it rather than
  // instead of it.
  const cause = stalled
    ? `the runner stalled ${worst.ms} ms between events ${worst.from} and ${worst.to}`
    : missed
      ? `the SCHEDULER's own records span ${schedulerSpanMs} ms from the first event to the ` +
        `last (our send loop measured ${spanMs} ms)`
      : `the burst took ${spanMs} ms end to end (worst single gap ${worst?.ms ?? 0} ms)`;

  return (
    `${cause} of the \`${fn}\` burst, which meets or exceeds the ${PERIOD_MS} ms debounce ` +
    'PERIOD — so the window closed MID-BURST and this run measured a split burst rather than ' +
    'the scheduler coalescing one. That is an ENVIRONMENTAL failure of the precondition, not ' +
    'a regression in the scheduler: re-run it. Do not widen PERIOD to make it rarer ' +
    '(MOTIR-3125), and do not weaken the assertion — carrying the LATEST event is the property ' +
    'it exists to prove (MOTIR-3276).'
  );
}

/**
 * When the SCHEDULER says it received an event, in ms — read off the dev
 * server's own `received_at`, or `null` when it cannot be read.
 *
 * The event is indexed a beat AFTER the send is acked (28–241 ms, measured), so
 * a read straight after the send loop can 404. Retrying is what keeps the signal
 * rather than losing it to a race with the server's own writer — and losing it
 * is not free: a `null` here silently returns the whole diagnosis to the local
 * proxy MOTIR-3371 filed as insufficient, so the budget is generous.
 *
 * ⚠️ AND THE STAMP IS THE WRITER'S, NOT THE HANDLER'S — it is FLUSHED, so it
 * carries a few hundred ms of granularity. Measured on this box: nine events
 * whose acks spanned 12 ms were stamped 0 ms and 251 ms, in two batches. That is
 * why this term is compared against `PERIOD_MS` (3 000 ms) and never used to
 * decide anything finer — at THAT scale the writer's lag is noise, and the
 * quantity being measured is real.
 */
async function receivedAt(id: string): Promise<number | null> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const res = await fetch(`${devUrl}/v1/events/${id}`);
      if (res.ok) {
        const body = (await res.json()) as { data?: { received_at?: string } };
        // RFC 3339 with NANOSECOND precision — `Date.parse` truncates it to ms.
        const ms = Date.parse(body.data?.received_at ?? '');
        if (Number.isFinite(ms)) return ms;
      }
    } catch {
      /* dev server not answering — treat as unavailable, below */
    }
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * The span of a burst on the SCHEDULER's clock — `max - min` over its own
 * `received_at` for every event sent — or `null` when any one of them could not
 * be read (MOTIR-3371).
 *
 * ALL or nothing, deliberately: a span computed over a SUBSET is shorter than
 * the burst's, which is the very understatement this term exists to remove.
 */
async function schedulerReceivedSpan(ids: string[]): Promise<number | null> {
  if (ids.length < 2) return null;
  const times = await Promise.all(ids.map(receivedAt));
  if (times.some((t) => t === null)) return null;
  const known = times as number[];
  return Math.max(...known) - Math.min(...known);
}

/**
 * Send a burst, wait for it to settle, and return the runs it produced.
 *
 * REFUSES rather than measures when its own send loop stalled past the window,
 * or when the SCHEDULER's own records say the burst did not fit one — see
 * {@link stallDiagnosis}. `injectStallMs` exists only for the self-test
 * below, which proves the diagnosis is WIRED into this loop and not merely
 * defined beside it; nothing else passes it.
 */
async function burst(
  fn: string,
  events: Record<string, unknown>[],
  injectStallMs = 0,
): Promise<{ key: string; n: number }[]> {
  const before = runs.length;
  const ids: string[] = [];
  let previousAt = 0;
  // The window opens when the FIRST event lands, so the span is measured from
  // there — not from the loop's start, which would charge the burst for work
  // that happened before any window existed (MOTIR-3276).
  let firstSentAt = 0;
  let lastSentAt = 0;
  let worst: SendGap | null = null;
  for (const [index, data] of events.entries()) {
    if (injectStallMs > 0 && index === 1) {
      await new Promise((r) => setTimeout(r, injectStallMs));
    }
    const sent = await client.send({ name: `debounce-probe/${fn}`, data });
    ids.push(...sent.ids);
    const sentAt = Date.now();
    if (index === 0) firstSentAt = sentAt;
    lastSentAt = sentAt;
    if (index > 0) {
      const gap = sentAt - previousAt;
      if (!worst || gap > worst.ms) worst = { ms: gap, from: index, to: index + 1 };
    }
    previousAt = sentAt;
  }
  // Read the scheduler's own view of the same burst BEFORE deciding anything:
  // our send-acks cannot see a window that opened before the first one returned.
  const schedulerSpanMs = await schedulerReceivedSpan(ids);
  const stalled = stallDiagnosis(fn, worst, lastSentAt - firstSentAt, schedulerSpanMs);
  if (stalled) throw new Error(stalled);
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

  it('NAMES a stall past the window instead of reporting its consequence (MOTIR-3125)', async () => {
    // The WIRING proof. `stallDiagnosis` is asserted directly below with
    // synthetic gaps; this case stalls a REAL send loop, so it also proves the
    // check runs inside `burst` rather than merely existing beside it.
    //
    // Before this, the same stall surfaced as `expected 5 to be 6` from the case
    // above — which reads like the scheduler changed its behaviour, and cost a
    // diagnosis on PR #2151. Now the burst refuses and says what happened.
    await expect(
      burst(
        'stall-probe',
        Array.from({ length: 3 }, (_, i) => ({ key: 'acme/stall', n: i + 1 })),
        PERIOD_MS + 500,
      ),
    ).rejects.toThrow(/stalled \d+ ms between events 1 and 2 of the `stall-probe` burst/);
  }, 60_000);

  it('measures the burst on the SCHEDULER’s clock, not only on ours (MOTIR-3371)', async () => {
    // ⚠️ A GUARD ON THE SIGNAL'S ABSENCE, and that is the whole point of it.
    // `schedulerReceivedSpan` returns `null` when the dev server's records
    // cannot be read, and `stallDiagnosis` then falls back to the local span —
    // the exact proxy MOTIR-3371 filed as insufficient. That fallback is silent
    // by construction, so a CLI upgrade that renames or withdraws `received_at`
    // would retire this file's sharpest check while every case here stayed
    // green. This case is what turns that into a red one.
    //
    // A dedicated event name, so no probe function above is triggered and no
    // run count moves: what is under test is the READ, not the scheduler.
    const ids: string[] = [];
    for (let n = 1; n <= 3; n++) {
      const sent = await client.send({
        name: 'debounce-probe/clock',
        data: { key: 'acme/clock', n },
      });
      ids.push(...sent.ids);
    }

    const span = await schedulerReceivedSpan(ids);
    expect(span).not.toBeNull();
    expect(Number.isFinite(span)).toBe(true);
    // Monotonic: three serially-awaited sends cannot arrive out of order, so the
    // span is non-negative. No upper bound is asserted — a magnitude here would
    // be an assertion about how loaded the runner is.
    expect(span).toBeGreaterThanOrEqual(0);
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

describe('stallDiagnosis — the precondition every case above carries silently', () => {
  it('is SILENT when every gap fits inside the window', () => {
    expect(stallDiagnosis('coalesce', null)).toBeNull();
    expect(stallDiagnosis('coalesce', { ms: 0, from: 1, to: 2 })).toBeNull();
    expect(stallDiagnosis('coalesce', { ms: PERIOD_MS - 1, from: 4, to: 5 })).toBeNull();
  });

  it('REFUSES at the boundary and above, naming the gap and the two events', () => {
    // At exactly PERIOD the window has closed, so the boundary belongs on the
    // refusing side — a burst that measured exactly the window is not one whose
    // coalescing can be trusted.
    expect(stallDiagnosis('unresolvable', { ms: PERIOD_MS, from: 5, to: 6 })).toContain(
      'stalled 3000 ms between events 5 and 6',
    );

    const message = stallDiagnosis('unresolvable', { ms: 4113, from: 5, to: 6 });
    expect(message).toContain('stalled 4113 ms between events 5 and 6');
    expect(message).toContain('`unresolvable` burst');
    // The two things a reader needs and a value mismatch never gave them: that
    // this is environmental, and what NOT to do about it.
    expect(message).toContain('ENVIRONMENTAL');
    expect(message).toContain('re-run it');
    expect(message).toContain('Do not widen PERIOD');
  });

  it('reports the WIDEST gap — the one that decides whether the window survived', () => {
    // `burst` keeps the max rather than the last, because a burst is only
    // trustworthy if EVERY gap fit; one long pause anywhere spoils it.
    expect(stallDiagnosis('per-key', { ms: PERIOD_MS + 1, from: 2, to: 3 })).toContain(
      'between events 2 and 3',
    );
  });

  // ── The SPAN, which the gap check cannot see (MOTIR-3276) ──────────────────

  it('REFUSES a burst that overran the window with NO gap anywhere near it', () => {
    // The occurrence this case is written from: 2026-08-20, PR #2223's
    // `Vitest (2/3)`, on a diff of one env var and an ADR. Every gap was small,
    // the diagnosis said nothing, and the failure arrived as the bare
    // `expected 5 to be 6` this whole helper exists to prevent.
    //
    // The window opens at the FIRST event and is NOT re-armed by later ones, so
    // a burst of six 600 ms sends spans 3 600 ms with a worst gap of 600 ms —
    // the window closes mid-burst and the gap check is structurally blind to it.
    const message = stallDiagnosis('coalesce', { ms: 600, from: 3, to: 4 }, 3_600);
    expect(message).toContain('took 3600 ms end to end');
    // It says the gap too, so a reader can see WHY the other check was silent
    // rather than wondering whether it ran.
    expect(message).toContain('worst single gap 600 ms');
    expect(message).toContain('ENVIRONMENTAL');
    expect(message).toContain('Do not widen PERIOD');
  });

  it('is SILENT when the span fits, and REFUSES at the boundary', () => {
    expect(stallDiagnosis('coalesce', { ms: 100, from: 1, to: 2 }, PERIOD_MS - 1)).toBeNull();
    // Same boundary reasoning as the gap: a burst that measured exactly the
    // window is not one whose coalescing can be trusted.
    expect(stallDiagnosis('coalesce', { ms: 100, from: 1, to: 2 }, PERIOD_MS)).toContain(
      'end to end',
    );
  });

  it('names the STALL when both trip — the sharper cause of the two', () => {
    // A burst can overrun BECAUSE one send stalled. Reporting the span there
    // would bury the pause that actually caused it, so the gap wins the message.
    const message = stallDiagnosis('coalesce', { ms: PERIOD_MS + 500, from: 2, to: 3 }, 9_000);
    expect(message).toContain('stalled 3500 ms between events 2 and 3');
    expect(message).not.toContain('end to end');
  });

  it('defaults the span to zero, so an un-updated caller keeps the old behaviour', () => {
    // The parameter is optional on purpose: every existing call site reads as it
    // did, and a caller that has not been taught to measure the span cannot be
    // made to refuse by accident.
    expect(stallDiagnosis('coalesce', { ms: 10, from: 1, to: 2 })).toBeNull();
  });

  // ── The SCHEDULER's span, which OUR clock cannot see (MOTIR-3371) ─────────

  it('REFUSES a burst the SCHEDULER saw overrun while OUR span looked comfortable', () => {
    // The BLIND SPOT this case is written for: every gap small AND our span
    // small, so both terms above stay silent while the burst did not fit. A slow
    // ACK on the FIRST send moves our start marker forward after the scheduler's
    // window has already opened, so 1 300 ms of measured span sits inside
    // 3 200 ms of real one.
    //
    // ⚠️ It is written as the blind spot rather than as an explanation of the
    // 2026-08-21 occurrence (PR #2247's `Vitest (2/3)`, run `32494861262`),
    // because that occurrence's mechanism is NOT established. `toHaveLength(1)`
    // passing is equally consistent with one window that kept a middle event —
    // measured twice at `schedulerSpanMs` 0 and 1 (MOTIR-3398). Both produce the
    // identical CI line, and only this term tells them apart.
    const message = stallDiagnosis('coalesce', { ms: 400, from: 2, to: 3 }, 1_300, 3_200);
    expect(message).toContain("the SCHEDULER's own records span 3200 ms");
    // Our own number is reported beside it, not instead of it — a reader who
    // greps the log for the span they expected has to see BOTH to understand
    // why the old check was silent.
    expect(message).toContain('our send loop measured 1300 ms');
    expect(message).toContain('`coalesce` burst');
    expect(message).toContain('ENVIRONMENTAL');
    expect(message).toContain('re-run it');
    expect(message).toContain('Do not widen PERIOD');
  });

  it('is SILENT when the scheduler’s span fits, and REFUSES at the boundary', () => {
    expect(stallDiagnosis('coalesce', { ms: 100, from: 1, to: 2 }, 100, PERIOD_MS - 1)).toBeNull();
    // Same boundary reasoning as the other two terms: a burst the scheduler
    // recorded as exactly the window is not one whose coalescing can be trusted.
    expect(stallDiagnosis('coalesce', { ms: 100, from: 1, to: 2 }, 100, PERIOD_MS)).toContain(
      "the SCHEDULER's own records span 3000 ms",
    );
  });

  it('names the STALL ahead of the scheduler’s span — the sharper cause again', () => {
    // A single stalled send explains every span downstream of it, so it keeps
    // the message exactly as it does against our own span.
    const message = stallDiagnosis(
      'per-key',
      { ms: PERIOD_MS + 200, from: 2, to: 3 },
      4_000,
      9_000,
    );
    expect(message).toContain('stalled 3200 ms between events 2 and 3');
    expect(message).not.toContain('SCHEDULER');
  });

  it('names the SCHEDULER’s span ahead of ours when both overran', () => {
    // Between two spans the scheduler's is the measurement and ours is the
    // proxy, so ours never wins the message when the real one is available.
    const message = stallDiagnosis('coalesce', { ms: 600, from: 3, to: 4 }, 3_600, 3_900);
    expect(message).toContain("the SCHEDULER's own records span 3900 ms");
    expect(message).not.toContain('end to end');
  });

  it('defaults the scheduler span to NULL, so an unreadable server keeps the old behaviour', () => {
    // The degradation path, pinned. `schedulerReceivedSpan` returns null when
    // any event's record is unreadable, and a null must not be read as a zero
    // that silently passes — nor as a miss that spuriously refuses.
    expect(stallDiagnosis('coalesce', { ms: 10, from: 1, to: 2 }, 10)).toBeNull();
    expect(stallDiagnosis('coalesce', { ms: 10, from: 1, to: 2 }, 10, null)).toBeNull();
    // And with the local span alone over the line it still refuses, exactly as
    // it did before this parameter existed.
    expect(stallDiagnosis('coalesce', { ms: 10, from: 1, to: 2 }, PERIOD_MS, null)).toContain(
      'end to end',
    );
  });
});
