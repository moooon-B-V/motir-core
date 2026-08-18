// Does Inngest's scheduler COALESCE a burst of same-key events into one run, or
// does it DROP the runs it cannot enqueue? (MOTIR-2994)
//
// `defineJob`'s `debounce` option is forwarded verbatim to Inngest, and
// `system.code-graph-refresh` is the shipped user: it debounces pushes on
// `installationId/owner/name` with a 2-minute period, and
// `docs/decisions/code-graph-index-fleet.md` §7.3 reasons from that coalescing
// being real. Whether it IS real is a property of Inngest's scheduler, not of
// our config — the same distinction `inngest-concurrency-fairness.mjs` was
// written for — so it is measured here rather than assumed. The results are
// recorded in the "Debounce" section of `docs/jobs.md`; this file produced them.
//
// The experiment: send a BURST of same-key events, wait past the debounce
// period, and count how many runs actually executed and which event each got.
//
//   LAB_MODE=same-key      — N events, ONE debounce key. Inngest's documented
//     contract is exactly ONE run, carrying the LAST event.
//   LAB_MODE=distinct-keys — N events, N DISTINCT keys. Each key is its own
//     debounce, so the contract is N runs — a burst on one key must not be able
//     to swallow another key's work.
//   LAB_SEND=serial|parallel|batch selects how the burst is delivered — one
//     awaited round-trip at a time, all at once, or the whole array in ONE
//     `send` call (what a bulk import actually does).
//
//   LAB_MODE=absent-key    — the shape a real event stream has: the debounce key
//     names a field only SOME events carry (`event.data.parentId` is absent on
//     every ROOT item), interleaved with events that do carry it. What the
//     scheduler does with an unresolvable key is not documented, and the
//     bulk-import stream that produced MOTIR-2994's log had exactly this shape.
//
//   LAB_MODE=no-debounce   — the control. The same N events with no `debounce`
//     at all, which must produce N runs. A mode that under-counts here is a
//     harness fault (a lost event, a short wait), not a scheduler finding.
//
// Run it:
//   node_modules/inngest-cli/bin/inngest dev -u http://localhost:3988/api/inngest \
//     --no-discovery --port 8488 --connect-gateway-port 8489 \
//     --connect-gateway-grpc-port 50252 --connect-executor-grpc-port 50253
//   LAB_MODE=same-key INNGEST_DEV=1 INNGEST_BASE_URL=http://localhost:8488 \
//     node scripts/experiments/inngest-debounce-coalescing.mjs
//
// ⚠️ The dev server's scheduling failures are logged by the SERVER, not raised
// to the sender: `inngest.send()` resolves 200 for an event whose run is then
// never enqueued. So capture the dev server's own stderr and grep it for
// `error enqueueing debounce job` — a run that never happens is otherwise
// indistinguishable from one this harness simply did not wait long enough for,
// which is why the wait below is generous and `no-debounce` is a mode.
//
// Use ports nobody else has: the dev server silently falls back to a DIFFERENT
// port when its default (8288) is taken by a sibling checkout's server, and the
// harness then registers with one server while sending events to another —
// which looks exactly like "the function never ran".
/* eslint-disable no-console -- this is a measurement script; stdout is its result. */
import { Inngest } from 'inngest';
import { createServer } from 'inngest/node';

const MODE = process.env.LAB_MODE ?? 'same-key';
/** Suffix every id so repeat runs never reuse a previous run's queue state. */
const TRIAL = process.env.LAB_TRIAL ?? '1';
const DEV_URL = process.env.LAB_DEV_URL ?? 'http://localhost:8488';
const PORT = Number(process.env.LAB_PORT ?? 3988);
/** How many events the burst carries. */
const BURST = Number(process.env.LAB_BURST ?? 4);
/** The debounce window. Short, so the whole trial fits in one wait. */
const PERIOD = process.env.LAB_PERIOD ?? '2s';
/** Optional cap on the total deferral, set exactly as a shipped job sets it. */
const TIMEOUT = process.env.LAB_TIMEOUT ?? '';
/**
 * How the burst reaches the server. A real bulk import does not send its events
 * one awaited round-trip at a time, and CONCURRENCY is a candidate trigger in
 * its own right: `serial` awaits each `send`, `parallel` fires them all at once,
 * `batch` hands the whole array to ONE `send` call.
 */
const SEND = process.env.LAB_SEND ?? 'serial';
/**
 * Milliseconds between events. `0` (the default) is the instantaneous burst;
 * a value that makes the stream outlast `timeout` is the interesting one — it
 * forces the debounce to FIRE while events are still arriving, which is the
 * only moment the scheduler has to re-enqueue a debounce for a key it is
 * already holding.
 */
const GAP_MS = Number(process.env.LAB_GAP_MS ?? 0);

const EVENT = `debounce/${MODE}-${TRIAL}`;
const runs = [];
let sentAt = 0;
const log = (...args) => console.log(...args);

const inngest = new Inngest({
  id: `debounce-lab-${MODE}-${TRIAL}`,
  isDev: true,
  baseUrl: DEV_URL,
  eventKey: 'lab',
});

const task = inngest.createFunction(
  {
    id: `debounce-task-${MODE}-${TRIAL}`,
    retries: 0,
    // Triggers belong in the options object — the legacy 3-arg createFunction
    // form throws at import in inngest@4.5.
    triggers: [{ event: EVENT }],
    ...(MODE === 'no-debounce'
      ? {}
      : {
          debounce: {
            key: MODE === 'absent-key' ? 'event.data.parentId' : 'event.data.key',
            period: PERIOD,
            ...(TIMEOUT ? { timeout: TIMEOUT } : {}),
          },
        }),
  },
  async ({ event }) => {
    runs.push({ key: event.data.key, n: event.data.n, at: Date.now() - sentAt });
    return `${event.data.key}#${event.data.n}`;
  },
);

const server = createServer({ client: inngest, functions: [task] });
await new Promise((resolve) => server.listen(PORT, resolve));

// PUT to our own serve endpoint to sync with the dev server. NOTE: the SDK
// mis-parses the 1.27 dev server's response (`status` arrives as a string), so
// a "Failed to register" body is not necessarily a failure — but a non-200 is.
const registration = await fetch(`http://localhost:${PORT}/api/inngest`, { method: 'PUT' });
if (!registration.ok) {
  console.error(`register -> ${registration.status} ${await registration.text()}`);
  console.error(`Is the dev server up at ${DEV_URL}, pointed at :${PORT}?`);
  process.exit(1);
}
await new Promise((resolve) => setTimeout(resolve, 2000));

log(
  `mode=${MODE} send=${SEND} — sending ${BURST} events (debounce period ${PERIOD}${TIMEOUT ? `, timeout ${TIMEOUT}` : ', no timeout'})`,
);
sentAt = Date.now();
const payloads = Array.from({ length: BURST }, (_, i) => {
  const n = i + 1;
  if (MODE === 'absent-key') {
    // Four "parents" with children, everything else a root item carrying no
    // `parentId` at all — the contract is one run per parent, and whatever the
    // scheduler does with the keyless events must not eat one of those four.
    const parentId = n % 4 === 0 ? null : `parent-${n % 4}`;
    return { name: EVENT, data: { n, key: parentId ?? 'root', ...(parentId ? { parentId } : {}) } };
  }
  return { name: EVENT, data: { key: MODE === 'distinct-keys' ? `repo-${n}` : 'repo-1', n } };
});
// `send` resolves as soon as the event is ACCEPTED. Whether a RUN is enqueued
// for it is decided afterwards, server-side, and is not reported to the sender.
if (SEND === 'batch') {
  const ack = await inngest.send(payloads);
  log(`  sent ${BURST} in ONE call -> ${(ack.ids ?? []).length} ids`);
} else if (SEND === 'parallel') {
  await Promise.all(payloads.map((p) => inngest.send(p)));
  log(`  sent ${BURST} concurrently`);
} else {
  for (const p of payloads) {
    const ack = await inngest.send(p);
    log(
      `  sent n=${p.data.n} key=${p.data.key} @${Date.now() - sentAt}ms -> ${JSON.stringify(ack.ids ?? ack)}`,
    );
    if (GAP_MS > 0) await new Promise((resolve) => setTimeout(resolve, GAP_MS));
  }
}

// Long enough for the debounce window to elapse and every run to execute.
await new Promise((resolve) => setTimeout(resolve, Number(process.env.LAB_WAIT_MS ?? 15000)));

// With a gap the stream can outlast `timeout`, so more than one run is correct;
// the contract this asserts is the instantaneous-burst one.
const expected =
  MODE === 'same-key' ? 1 : MODE === 'absent-key' ? 3 + Math.floor(BURST / 4) : BURST;
log(`  runs executed: ${runs.length} (contract: ${expected})`);
log(`  payloads:      ${runs.map((r) => `${r.key}#${r.n}@${r.at}ms`).join(' ') || '(none)'}`);
if (MODE === 'same-key') {
  log(`  latest event won: ${runs.length === 1 && runs[0].n === BURST ? 'yes' : 'NO'}`);
}
log(runs.length === expected ? 'VERDICT: matches the contract' : 'VERDICT: DOES NOT match');
process.exit(0);
