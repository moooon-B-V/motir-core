// Does Inngest's scheduler SKIP OVER a key-blocked run to a runnable one, or
// does it head-of-line block behind it? (MOTIR-1982)
//
// `defineJob` can now express `[{ limit: 1, key: 'event.data.workspaceId' },
// { limit: N }]` — one slot per tenant plus a global capacity. That idiom only
// delivers FAIRNESS if the scheduler, on finding the next queued run blocked by
// its own key, moves on to a run whose key is free. That is a property of
// Inngest's scheduler, not of our config, so it is measured here rather than
// assumed. The results are recorded in the "Concurrency" section of
// `docs/jobs.md`; this file is what produced them.
//
// The experiment: flood tenant A, then enqueue ONE event for tenant B, and time
// how long B waits.
//
//   LAB_MODE=global — `{ limit: 2 }`, the shape defineJob used to force. Both
//     tenants share one lane, so B's wait scales with A's backlog.
//   LAB_MODE=keyed  — `[{ limit: 1, key: tenant }, { limit: 2 }]`. A can hold
//     only one of the two slots, so a fair scheduler starts B almost at once.
//
// Run it:
//   pnpm inngest-cli dev -u http://localhost:3987/api/inngest --no-discovery \
//     --port 8388 --connect-gateway-port 8389 \
//     --connect-gateway-grpc-port 50152 --connect-executor-grpc-port 50153
//   LAB_MODE=keyed INNGEST_DEV=1 INNGEST_BASE_URL=http://localhost:8388 \
//     node scripts/experiments/inngest-concurrency-fairness.mjs
//
// Use ports nobody else has: the dev server silently falls back to a DIFFERENT
// port when its default (8288) is taken by a sibling checkout's server, and the
// harness then registers with one server while sending events to another —
// which looks exactly like "the function never ran".
/* eslint-disable no-console -- this is a measurement script; stdout is its result. */
import { Inngest } from 'inngest';
import { createServer } from 'inngest/node';

const MODE = process.env.LAB_MODE ?? 'keyed';
/** Suffix every id so repeat runs never reuse a previous run's queue state. */
const TRIAL = process.env.LAB_TRIAL ?? '1';
const DEV_URL = process.env.LAB_DEV_URL ?? 'http://localhost:8388';
const PORT = Number(process.env.LAB_PORT ?? 3987);
/** How long tenant A's backlog is — long enough that an unfair wait is obvious. */
const BACKLOG = Number(process.env.LAB_BACKLOG ?? 20);
/** How long each run occupies its slot. */
const HOLD_MS = Number(process.env.LAB_HOLD_MS ?? 500);

const EVENT = `fairness/${MODE}-${TRIAL}`;
const starts = [];
let sentAt = 0;
const log = (...args) => console.log(...args);

const inngest = new Inngest({
  id: `fairness-lab-${MODE}-${TRIAL}`,
  isDev: true,
  baseUrl: DEV_URL,
  eventKey: 'lab',
});

const task = inngest.createFunction(
  {
    id: `fairness-task-${MODE}-${TRIAL}`,
    retries: 0,
    concurrency:
      MODE === 'keyed' ? [{ limit: 1, key: 'event.data.tenant' }, { limit: 2 }] : { limit: 2 },
    // Triggers belong in the options object — the legacy 3-arg createFunction
    // form throws at import in inngest@4.5.
    triggers: [{ event: EVENT }],
  },
  async ({ event }) => {
    const tag = `${event.data.tenant}${event.data.n}`;
    starts.push({ tag, at: Date.now() - sentAt });
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    return tag;
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

log(`mode=${MODE} — flooding tenant A with ${BACKLOG} events, then 1 for tenant B`);
sentAt = Date.now();
for (let n = 1; n <= BACKLOG; n += 1) {
  await inngest.send({ name: EVENT, data: { tenant: 'A', n } });
}
await inngest.send({ name: EVENT, data: { tenant: 'B', n: 1 } });

// Long enough for the whole backlog to drain in either mode.
await new Promise((resolve) => setTimeout(resolve, Number(process.env.LAB_WAIT_MS ?? 20000)));

const bystander = starts.find((s) => s.tag === 'B1');
const lastA = starts.filter((s) => s.tag.startsWith('A')).at(-1);
log(`  started: ${starts.map((s) => s.tag).join(' ')}`);
log(`  tenant B waited: ${bystander ? `${bystander.at}ms` : 'NEVER STARTED'}`);
log(`  tenant A's backlog drained by: ${lastA ? `${lastA.at + HOLD_MS}ms` : 'n/a'}`);
process.exit(0);
