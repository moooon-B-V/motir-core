// Is the FAST LANE slower when the system is IDLE? (MOTIR-3405, for MOTIR-3245)
//
// MOTIR-3245 was filed on the theory that a long code-graph refresh starves the
// `work-item/transitioned` consumers. MOTIR-3246 falsified the mechanism — a run
// inside `ctx.step.sleep` holds no concurrency slot, so a 30-minute index
// occupies ~128 sub-second steps rather than 30 minutes
// (`docs/decisions/job-lane-occupancy.md` §1–§2). What survived was an
// observation pointing the OTHER way: the fast lane measured FASTER while a
// refresh ran than while none did. This measures that split, so the number is
// re-derivable rather than quoted from a comment — which is the mistake this
// whole card family exists to have stopped making.
//
// WHAT IT MEASURES. For every `work-item/transitioned` event in a window:
//
//   lag = run_started_at − received_at
//
// `received_at` is the SCHEDULER's own receipt stamp (server-assigned,
// nanosecond precision), never the client-supplied `ts`, which is echoed back
// verbatim and would measure our own clock. `run_started_at` is when the
// executor actually began the run. The difference is queue wait plus dispatch —
// exactly the interval a "the tracker is stale" complaint is about.
//
// THE SPLIT. Every `system.code-graph-refresh` run in the same window gives a
// [run_started_at, ended_at] interval. A transitioned event is REFRESH-CONCURRENT
// if its `received_at` falls inside any of them, and IDLE otherwise. A refresh
// still `Running` at read time is treated as open-ended to now — otherwise the
// most recent (and most relevant) refresh would silently drop out of the
// concurrent arm and inflate the idle one.
//
// Run it:
//   IK=$(fly ssh console -a motir-core --machine <started-id> \
//        -C "printenv INNGEST_SIGNING_KEY" | tr -d '\r\n ')
//   INNGEST_SIGNING_KEY=$IK node scripts/experiments/inngest-fastlane-lag.mjs --hours 24
//
// READ-ONLY. It issues GETs against the Inngest REST API and writes nothing,
// which is what lets a card that forbids production behaviour changes run it.
/* eslint-disable no-console -- this is a measurement script; stdout is its result. */

const KEY = process.env.INNGEST_SIGNING_KEY;
if (!KEY) {
  console.error('INNGEST_SIGNING_KEY is required (read it off the running machine).');
  process.exit(1);
}

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const HOURS = Number(argOf('hours', 24));
/** The interactive lane: the event whose consumers a stale tracker is about. */
const FAST_EVENT = argOf('fast', 'work-item/transitioned');
/** The slow lane the original card blamed. */
const SLOW_EVENT = argOf('slow', 'system.code-graph-refresh');

const NOW = Date.now();
const SINCE = NOW - HOURS * 3600_000;
const iso = (ms) => new Date(ms).toISOString();

async function api(path) {
  const res = await fetch(`https://api.inngest.com${path}`, {
    headers: { Authorization: `Bearer ${KEY}` },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * ⚠️ `/v1/events` CAPS AT 51 AND RETURNS NO CURSOR — so the window IS the
 * pagination (measured 2026-08-23, MOTIR-3405).
 *
 * `limit=100` returns 51. `metadata` carries only `fetched_at` — there is no
 * `cursor` / `fetched_cursor` / `next` field to walk, so a page loop cannot
 * exist. Proof that 51 is a CAP rather than the true count, on the same 24h
 * window: `inngest/function.finished` returns 51 for the whole window AND 51
 * for each 12h half; `work-item/transitioned` returns 51 for the window but
 * 34 + 39 = 73 across its halves.
 *
 * **This is the trap that makes the endpoint dangerous for exactly this
 * measurement.** A capped read is silently RECENCY-BIASED — you get the newest
 * 51 — so a script that runs during a busy period samples the busy period and
 * reports it as the day. For an idle-vs-busy comparison that is not a small
 * error; it is a bias aligned with the hypothesis under test.
 *
 * So: BISECT any window that comes back at the cap, and union the halves. Stop
 * at a floor so a genuinely dense minute cannot recurse forever, and report it
 * loudly if it is ever hit rather than returning a quietly short answer.
 */
const PAGE_CAP = 51;
/** Below this, a still-capped window is reported rather than split further. */
const MIN_SLICE_MS = 60_000;
let truncatedSlices = 0;

async function eventsInSlice(name, from, to) {
  const q = new URLSearchParams({
    name,
    received_after: iso(from),
    received_before: iso(to),
    limit: '100',
  });
  const batch = (await api(`/v1/events?${q}`)).data ?? [];
  if (batch.length < PAGE_CAP) return batch;
  if (to - from <= MIN_SLICE_MS) {
    truncatedSlices += 1;
    return batch;
  }
  const mid = from + Math.floor((to - from) / 2);
  const [a, b] = [await eventsInSlice(name, from, mid), await eventsInSlice(name, mid, to)];
  // The two half-open ranges overlap at `mid`, so de-duplicate on the event id.
  const seen = new Map();
  for (const ev of [...a, ...b]) seen.set(ev.internal_id ?? ev.id, ev);
  return [...seen.values()];
}

/** Every event of one name in the window, recovered by bisection. */
async function eventsNamed(name) {
  return eventsInSlice(name, SINCE, NOW);
}

/** The runs an event triggered — `run_started_at` is the number this exists for. */
async function runsOf(eventId) {
  try {
    return (await api(`/v1/events/${eventId}/runs`)).data ?? [];
  } catch {
    return [];
  }
}

const quantile = (sorted, q) => {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
};
const secs = (ms) => (ms / 1000).toFixed(1);

function describe(label, lags) {
  const s = [...lags].sort((a, b) => a - b);
  return {
    label,
    n: s.length,
    median: quantile(s, 0.5),
    p95: quantile(s, 0.95),
    max: s.at(-1) ?? NaN,
  };
}

console.log(`window: ${iso(SINCE)} → ${iso(NOW)}  (${HOURS}h)`);

// ── The slow lane's occupied intervals ────────────────────────────────────────
const slowEvents = await eventsNamed(SLOW_EVENT);
const intervals = [];
for (const ev of slowEvents) {
  for (const run of await runsOf(ev.internal_id ?? ev.id)) {
    if (!run.run_started_at) continue;
    const start = Date.parse(run.run_started_at);
    // A run still going is open-ended to NOW. Treating it as zero-length would
    // move the most recent events — the ones most likely to be concurrent — into
    // the idle arm, which is the exact bias this measurement is testing for.
    const end = run.ended_at ? Date.parse(run.ended_at) : NOW;
    intervals.push([start, end]);
  }
}
intervals.sort((a, b) => a[0] - b[0]);
console.log(`${SLOW_EVENT}: ${slowEvents.length} event(s), ${intervals.length} run(s)`);
for (const [s, e] of intervals) {
  console.log(`  ${iso(s)} → ${iso(e)}  (${((e - s) / 60000).toFixed(1)} min)`);
}

const insideARefresh = (t) => intervals.some(([s, e]) => t >= s && t <= e);

// ── The fast lane, split ──────────────────────────────────────────────────────
const fastEvents = await eventsNamed(FAST_EVENT);
const samples = [];
let noRun = 0;

for (const ev of fastEvents) {
  const received = Date.parse(ev.received_at);
  const runs = await runsOf(ev.internal_id ?? ev.id);
  const started = runs
    .map((r) => r.run_started_at)
    .filter(Boolean)
    .map(Date.parse);
  const ended = runs
    .map((r) => r.ended_at)
    .filter(Boolean)
    .map(Date.parse);
  if (started.length === 0) {
    noRun += 1;
    continue;
  }
  // The EARLIEST consumer to start. A stale tracker is about the first thing to
  // react, and taking the max would measure the slowest consumer's own work.
  const lag = Math.min(...started) - received;
  if (lag < 0) continue; // clock skew between the two stamps; not a queue wait
  samples.push({
    received,
    lag,
    // How long the whole consumer fan-out took once the first one started. This
    // separates "it waited" from "it ran slowly", which the lag alone cannot.
    span: ended.length ? Math.max(...ended) - Math.min(...started) : null,
    concurrent: insideARefresh(received),
  });
}

samples.sort((a, b) => a.received - b.received);
// The QUIET PERIOD before each event — the wake hypothesis's own variable.
for (let i = 0; i < samples.length; i += 1) {
  samples[i].gapBefore = i === 0 ? null : samples[i].received - samples[i - 1].received;
}

const concurrent = samples.filter((s) => s.concurrent).map((s) => s.lag);
const idle = samples.filter((s) => !s.concurrent).map((s) => s.lag);

console.log(
  `\n${FAST_EVENT}: ${fastEvents.length} event(s), ${noRun} with no run recorded (skipped)`,
);
if (truncatedSlices > 0) {
  console.log(
    `⚠️  ${truncatedSlices} slice(s) still hit the ${PAGE_CAP}-event cap at the ` +
      `${MIN_SLICE_MS / 1000}s floor — the population below is a FLOOR, not a count.`,
  );
}
console.log('');

const rows = [describe('while a refresh runs', concurrent), describe('while none runs', idle)];
console.log('| condition            |   n | median |    p95 |    max |');
console.log('| -------------------- | --- | ------ | ------ | ------ |');
for (const r of rows) {
  if (r.n === 0) {
    console.log(`| ${r.label.padEnd(20)} |   0 |      — |      — |      — |`);
    continue;
  }
  console.log(
    `| ${r.label.padEnd(20)} | ${String(r.n).padStart(3)} | ${secs(r.median).padStart(5)}s | ` +
      `${secs(r.p95).padStart(5)}s | ${secs(r.max).padStart(5)}s |`,
  );
}

// ── THE WAKE TEST — the hypothesis the card names, on its own variable ────────
//
// A cold-start / wake cost predicts ONE thing: an event that lands after a long
// quiet period pays it, and an event in a busy stretch does not. So split on the
// LAG and read back the quiet period each side actually had. If waking were the
// cost, the slow side would show the LONGER gap.
const SLOW_MS = 5_000;
const withGap = samples.filter((s) => s.gapBefore !== null);
const slow = withGap.filter((s) => s.lag > SLOW_MS);
const quick = withGap.filter((s) => s.lag <= SLOW_MS);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

console.log(`\nTHE WAKE TEST — quiet period before each event, split at ${SLOW_MS / 1000}s of lag`);
console.log('| arm             |   n | median gap before | median fan-out span |');
console.log('| --------------- | --- | ----------------- | ------------------- |');
for (const [label, arm] of [
  [`slow (>${SLOW_MS / 1000}s)`, slow],
  [`fast (<=${SLOW_MS / 1000}s)`, quick],
]) {
  const g = median(arm.map((s) => s.gapBefore));
  const sp = median(arm.map((s) => s.span).filter((x) => x !== null));
  console.log(
    `| ${label.padEnd(15)} | ${String(arm.length).padStart(3)} | ` +
      `${(Number.isNaN(g) ? '—' : secs(g) + 's').padStart(17)} | ` +
      `${(Number.isNaN(sp) ? '—' : secs(sp) + 's').padStart(19)} |`,
  );
}

// The single most decisive rows: what did the LONGEST quiet periods cost?
const byGap = [...withGap].sort((a, b) => b.gapBefore - a.gapBefore).slice(0, 3);
console.log('\nthe longest quiet periods in the window, and what the next event cost:');
for (const s of byGap) {
  console.log(
    `  after ${(s.gapBefore / 3600_000).toFixed(1)}h idle → lag ${secs(s.lag)}s   ${iso(s.received)}`,
  );
}

// The verdict, stated by the harness so two numbers cannot be mis-read into the
// conclusion somebody expected.
const [c, i] = rows;
console.log('');
if (slow.length && quick.length) {
  const gs = median(slow.map((s) => s.gapBefore));
  const gq = median(quick.map((s) => s.gapBefore));
  console.log(
    gs > gq
      ? `WAKE: CONSISTENT — slow events follow longer quiet (${secs(gs)}s vs ${secs(gq)}s).`
      : `WAKE: FALSIFIED — slow events follow SHORTER quiet (${secs(gs)}s vs ${secs(gq)}s), ` +
          'the opposite of a wake cost.',
  );
}
if (c.n === 0 || i.n === 0) {
  console.log(
    `VERDICT: INCONCLUSIVE — one arm is empty (concurrent n=${c.n}, idle n=${i.n}). ` +
      'Widen --hours, or the window contains no refresh at all.',
  );
} else if (i.p95 > c.p95) {
  console.log(
    `VERDICT: the idle tail REPRODUCES — p95 is ${secs(i.p95)}s idle vs ${secs(c.p95)}s ` +
      'while a refresh runs. The fast lane is slower when the system is quiet.',
  );
} else {
  console.log(
    `VERDICT: the idle tail does NOT reproduce — p95 is ${secs(i.p95)}s idle vs ` +
      `${secs(c.p95)}s while a refresh runs.`,
  );
}
