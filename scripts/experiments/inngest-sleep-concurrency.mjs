// Does a run sitting in `ctx.step.sleep` OCCUPY its function's concurrency
// slot? (MOTIR-3246, for MOTIR-3245)
//
// Two files in this repo used to disagree, and neither was measuring the same
// thing: `indexFleetSteps.ts` said a sleep "costs no invocation" (a BILLING
// unit), while `codeGraphRefresh.ts` said a stepped supervision loop "holds its
// Inngest concurrency slot for the CONTAINER'S WHOLE LIFE" (a SCHEDULING unit).
// MOTIR-3245 was filed on the second sentence, and every fix it proposed
// followed from it. Inngest's documentation answers it — but a documentation
// citation is what the corpus already had, so this measures the scheduler
// instead (`docs/jobs.md` § Concurrency records the result; this file produced
// it, exactly as `inngest-concurrency-fairness.mjs` produced the row above it).
//
// THE EXPERIMENT. One function, `concurrency: { limit: 1 }`, three events. Each
// run does `enter` → hold for HOLD_MS → `exit`, and the ONLY difference between
// the two modes is HOW it holds:
//
//   LAB_MODE=sleep — `ctx.step.sleep('hold', HOLD_MS)`. The supervisor's shape.
//   LAB_MODE=busy  — `ctx.step.run('hold', () => setTimeout(HOLD_MS))`. The
//                    CONTROL: a step that is demonstrably executing code, which
//                    the documentation says DOES count against the limit.
//
// The control is what makes this decisive rather than suggestive. Same limit,
// same event count, same hold duration — so if run 2's `enter` lands promptly
// under `sleep` and only after ~HOLD_MS under `busy`, the difference is
// attributable to the wait mechanism and to nothing else. Without it, a prompt
// start could equally mean the limit was never applied at all.
//
// Run it:
//   pnpm inngest-cli dev -u http://localhost:3988/api/inngest --no-discovery \
//     --port 8488 --connect-gateway-port 8489 \
//     --connect-gateway-grpc-port 50252 --connect-executor-grpc-port 50253
//   LAB_MODE=sleep INNGEST_DEV=1 \
//     node scripts/experiments/inngest-sleep-concurrency.mjs
//   LAB_MODE=busy  INNGEST_DEV=1 \
//     node scripts/experiments/inngest-sleep-concurrency.mjs
//
// Use ports nobody else has: the dev server does not fail on a port conflict, it
// logs `Port conflict, using new port` and carries on — after which the harness
// registers with one server and sends events to another, which presents exactly
// as "the function never ran". All four flags collide, not just `--port`.
//
// ⚠️ WHAT THIS DOES AND DOES NOT MEASURE. It measures the dev server
// (`inngest-cli`, the binary CI's E2E lane boots and every self-hosted
// deployment runs). Production runs Inngest CLOUD, a different implementation,
// and this harness cannot reach it without writing into production — so read
// the result as: the documented semantics are what the shipped scheduler
// actually does, on the implementation we can drive. The Cloud-side evidence is
// separate and is recorded on MOTIR-3245.
/* eslint-disable no-console -- this is a measurement script; stdout is its result. */
import { Inngest } from 'inngest';
import { createServer } from 'inngest/node';

/** `sleep` — the supervisor's shape; `busy` — the control that really occupies. */
const MODE = process.env.LAB_MODE ?? 'sleep';
/** Suffix every id so repeat runs never reuse a previous run's queue state. */
const TRIAL = process.env.LAB_TRIAL ?? '1';
const DEV_URL = process.env.LAB_DEV_URL ?? 'http://localhost:8488';
const PORT = Number(process.env.LAB_PORT ?? 3988);
/** How long each run holds. Long enough that a queued start is unmistakable. */
const HOLD_MS = Number(process.env.LAB_HOLD_MS ?? 8000);
/** How many runs to contend for the single slot. */
const RUNS = Number(process.env.LAB_RUNS ?? 3);

const EVENT = `sleepslot/${MODE}-${TRIAL}`;
/** Every step execution, stamped against the moment the events were sent. */
const marks = [];
let sentAt = 0;
const mark = (n, step) => marks.push({ n, step, at: Date.now() - sentAt });

const inngest = new Inngest({
  id: `sleepslot-lab-${MODE}-${TRIAL}`,
  // `isDev: '<url>'` does NOT put the client in dev mode — it leaves it in cloud
  // mode and `send()` then throws "couldn't find an event key". It is
  // `isDev: true` plus `baseUrl`.
  isDev: true,
  baseUrl: DEV_URL,
  eventKey: 'lab',
});

const task = inngest.createFunction(
  {
    id: `sleepslot-task-${MODE}-${TRIAL}`,
    retries: 0,
    // THE WHOLE POINT: one slot. Whatever holds it, holds it alone.
    concurrency: { limit: 1 },
    // Triggers belong in the options object — the legacy 3-arg createFunction
    // form throws at import in inngest@4.5.
    triggers: [{ event: EVENT }],
  },
  async ({ event, step }) => {
    const n = event.data.n;
    // The step whose TIMING is the measurement: when did this run first get to
    // execute code? Under a held slot, not until the run ahead of it finished.
    await step.run(`enter:${n}`, () => {
      mark(n, 'enter');
      return n;
    });

    if (MODE === 'busy') {
      // The CONTROL. Actively executing code for HOLD_MS — the documented
      // definition of occupying the limit.
      await step.run(`hold:${n}`, async () => {
        await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
        return 'held';
      });
    } else {
      // The SUPERVISOR'S SHAPE — `index-wait:<pid>:<n>` in `indexFleetSteps.ts`.
      await step.sleep(`hold:${n}`, HOLD_MS);
    }

    await step.run(`exit:${n}`, () => {
      mark(n, 'exit');
      return n;
    });
    return n;
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

console.log(`mode=${MODE} — ${RUNS} events, concurrency limit 1, hold ${HOLD_MS}ms each`);
sentAt = Date.now();
for (let n = 1; n <= RUNS; n += 1) {
  await inngest.send({ name: EVENT, data: { n } });
}

// Long enough to drain in EITHER direction: serialized is RUNS × HOLD_MS.
const drain = Number(process.env.LAB_WAIT_MS ?? RUNS * HOLD_MS + 12000);
await new Promise((resolve) => setTimeout(resolve, drain));

const enters = marks.filter((m) => m.step === 'enter').sort((a, b) => a.at - b.at);
const exits = marks.filter((m) => m.step === 'exit').sort((a, b) => a.at - b.at);
console.log(`  enter: ${enters.map((m) => `#${m.n}@${m.at}ms`).join(' ')}`);
console.log(`  exit:  ${exits.map((m) => `#${m.n}@${m.at}ms`).join(' ')}`);

const lastEnter = enters.at(-1);
const spread = enters.length > 1 ? lastEnter.at - enters[0].at : null;
console.log(`  every run entered within: ${spread === null ? 'n/a' : `${spread}ms`}`);
// The verdict, stated by the harness so a reader cannot mis-derive it from the
// two numbers. A spread well under HOLD_MS means the runs were NOT serialized by
// the limit — the slot was free while they waited.
if (enters.length < RUNS) {
  console.log(`  VERDICT: INCONCLUSIVE — only ${enters.length}/${RUNS} runs entered`);
} else if (spread < HOLD_MS / 2) {
  console.log(`  VERDICT: the wait does NOT hold the slot (all ${RUNS} entered concurrently)`);
} else {
  console.log(`  VERDICT: the wait HOLDS the slot (runs serialized, ~${HOLD_MS}ms apart)`);
}
process.exit(0);
