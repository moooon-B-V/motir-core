#!/usr/bin/env node
//
// The SEQUENCE ASSERTIONS of the sandbox loop smoke test (7.9.7c / MOTIR-885).
//
// A smoke test that only checks `motir auto`'s exit code proves almost nothing:
// a loop that skipped the integration record, dispatched two items in one
// iteration, or handed the agent a prompt it never asked the server for would
// all still exit 0. So the stub server records EVERY request and this script
// asserts the story the loop is supposed to tell:
//
//   • one READ OF THE READY SET per iteration — never a batch read-ahead,
//   • each item's prompt fetched with the run's session branch as the SEED,
//   • each item flipped to in_progress before its agent is launched,
//   • each item recorded as integrated on that same branch,
//   • a final ready read that comes back to an empty set — the loop stops
//     because the server drained, not because it ran out of patience,
//   • exactly ONE pull request, for the one repo the run touched.
//
// ── ⚠️ THE RECORDED SHAPE CHANGED WITH THE PROTOCOL (MOTIR-2436) ────────────
// Every assertion here used to read a TOOL NAME and an `args` object, because
// the CLI was an MCP client. It reads a METHOD, a PATH and either a query or a
// body now. Every claim is preserved and none was WEAKENED to pass — an
// assertion that had to be relaxed would have been the tell that the migration
// lost something. Two changed, and both are noted below because a reader needs
// to know which parts of this file are a translation and which are a decision.
//
// The first could not survive and its replacement is stronger. The
// loop used to call a `next_ready` TOOL, which handed back one item and advanced
// a server-side cursor. There is no such endpoint on `/api/v1` and there should
// not be (MOTIR-2398): the CLI reads the ready COLLECTION and takes the first
// row. So "one `next_ready` per iteration" becomes "one GET of the ready set per
// iteration, and the set SHRINKS by one each time" — which additionally proves
// the transition actually landed, something the cursor version could not tell.
//
// ── ⚠️ AND ONE ORDER GENUINELY CHANGED, WHICH THIS FILE SHOULD HAVE CAUGHT ──
// The loop used to TRANSITION an item and then fetch its prompt. It now fetches
// the prompt FIRST: the prompt is what carries `targetRepo`, and MOTIR-2398 made
// the run resolve the repo from it rather than from the ready row — so the read
// has to happen before the routing decision it feeds. `auto.ts` marks the spot
// ("⚠️ SEED FIRST, THEN RESOLVE").
//
// That is a real behaviour change to the loop, and this file is the one place
// that would have said so out loud. It did not, because it had been failing at
// the first request since 11.5.6 and nobody could see past that. The expected
// sequence below is corrected rather than relaxed — the point of an ordered
// assertion is that a reorder has to be noticed and agreed to.
//
// Usage: assert-run.mjs --calls <ndjson> --gh <log> --items <n> --project <key>

import { readFileSync } from 'node:fs';

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const CALLS_PATH = argOf('calls');
const GH_PATH = argOf('gh');
const ITEMS = Number.parseInt(argOf('items', '2'), 10);
const PROJECT = argOf('project', 'SMOKE');

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

// ── the recorded requests ───────────────────────────────────────────────────

const entries = readFileSync(CALLS_PATH, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

/** Every `/api/v1` request, in order, as `METHOD path`. */
const v1 = entries.filter((e) => typeof e.path === 'string' && e.path.startsWith('/api/v1'));

check(v1.length > 0, 'the CLI made no `/api/v1` requests at all — is it reaching the stub?');
check(
  !entries.some((e) => e.method === 'initialize' || e.method === 'tools/call'),
  'the CLI spoke MCP — it is an `/api/v1` client since 11.5.6, and this stub no longer serves MCP',
);

/** A request's shape, for the sequence comparison. Keys are collapsed to `{key}` so
 *  the expected sequence is about the OPERATION, not about which item it was for
 *  — the per-item detail below is what checks that. */
const shapeOf = (entry) =>
  `${entry.method} ${entry.path
    .replace(new RegExp(`${PROJECT}-\\d+`, 'g'), '{key}')
    .replace(`/${PROJECT}/`, '/{project}/')}`;

const READY = `GET /api/v1/projects/{project}/ready`;
const TRANSITION = 'POST /api/v1/work-items/{key}/transitions';
const PROMPT = 'GET /api/v1/work-items/{key}/dispatch-prompt';
const INTEGRATION = 'POST /api/v1/work-items/{key}/integration';

// The suite runs `motir ready` against this same stub before the loop starts —
// it is the cheapest proof that the credential resolved, whichever tier supplied
// it (MOTIR-1877) — so ONE leading ready read belongs to that pre-flight and is
// skipped here. Only a leading one: an EXTRA ready read from inside the loop
// would be the batch read-ahead this file exists to refuse, and the count check
// below is what catches it.
const shapes = v1.map(shapeOf);
const preflight = shapes[0] === READY ? 1 : 0;
const loop = v1.slice(preflight);
const loopShapes = shapes.slice(preflight);

// The expected shape, built rather than hard-coded so the item count is a knob.
const expected = [];
for (let i = 1; i <= ITEMS; i += 1) expected.push(READY, PROMPT, TRANSITION, INTEGRATION);
expected.push(READY); // the drain probe

check(
  loopShapes.join(',') === expected.join(','),
  `request sequence mismatch:\n  expected: ${expected.join(' → ')}\n  actual:   ${loopShapes.join(
    ' → ',
  )}`,
);

// ── per-item detail ─────────────────────────────────────────────────────────
// The sequence being right is not enough: the requests must be about the RIGHT
// item and carry the run's branch. A loop that dispatched item 1 four times
// would satisfy the shape above.

const branches = new Set();
const keyOf = (entry) => entry?.path?.match(new RegExp(`${PROJECT}-\\d+`))?.[0] ?? null;

for (let i = 1; i <= ITEMS; i += 1) {
  const key = `${PROJECT}-${i}`;
  const base = (i - 1) * 4;

  const dispatch = loop[base + 1];
  const transition = loop[base + 2];
  check(
    keyOf(transition) === key && transition?.body?.status === 'in_progress',
    `${key}: expected a transition to in_progress, got ${keyOf(transition)} ${JSON.stringify(
      transition?.body,
    )}`,
  );

  check(
    keyOf(dispatch) === key,
    `${key}: the dispatch prompt was fetched for ${keyOf(dispatch) ?? '(nothing)'}`,
  );
  // ⚠️ A QUERY parameter now, not a tool argument — the operation declares it
  // that way because fetching a prompt is a READ.
  const seed = dispatch?.query?.sessionBranch;
  check(
    typeof seed === 'string' && seed.startsWith('motir/auto-'),
    `${key}: the dispatch prompt carried no session-branch seed (got ${JSON.stringify(seed)})`,
  );

  const integrated = loop[base + 3];
  check(
    keyOf(integrated) === key,
    `${key}: the integration was recorded for ${keyOf(integrated) ?? '(nothing)'}`,
  );
  check(
    integrated?.body?.sessionBranch === seed,
    `${key}: the integration recorded a different branch than the one dispatched on`,
  );
  // The harness self-report (MOTIR-1685) is how a Motir tenant can tell agent
  // work from human work; an unattended run that stopped sending it would erase
  // that provenance silently.
  check(
    typeof integrated?.body?.implementationHarness === 'string' &&
      integrated.body.implementationHarness.startsWith('motir-cli/'),
    `${key}: the integration carried no motir-cli harness stamp`,
  );

  if (typeof seed === 'string') branches.add(seed);
}

check(
  branches.size === 1,
  `the run used ${branches.size} session branches; a run has exactly one (${[...branches].join(', ')})`,
);

// The loop must stop because the SERVER drained. Under MCP that was "N+1
// `next_ready` calls, the last one empty"; here it is the same claim made
// directly — one ready read per iteration plus the drain probe, and no more.
const readyReads = loopShapes.filter((shape) => shape === READY).length;
check(
  readyReads === ITEMS + 1,
  `expected ${ITEMS + 1} reads of the ready set (one per item plus the drain probe), got ${readyReads}`,
);

// ── the pull request ────────────────────────────────────────────────────────

const ghCalls = readFileSync(GH_PATH, 'utf8').split('\n').filter(Boolean);
const created = ghCalls.filter((line) => line.startsWith('pr create'));

check(created.length === 1, `expected exactly ONE pull request, got ${created.length}`);
check(
  created[0]?.includes('--base main'),
  `the session pull request did not target main: ${created[0]}`,
);
for (let i = 1; i <= ITEMS; i += 1) {
  check(
    created[0]?.includes(`${PROJECT}-${i}`),
    `${PROJECT}-${i} is missing from the session pull-request body`,
  );
}

// ── verdict ─────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error('SMOKE FAILED — the loop did not tell the expected story:');
  for (const failure of failures) console.error(`  • ${failure}`);
  process.exit(1);
}

process.stdout.write(
  `assert-run: OK — ${ITEMS} items dispatched one per iteration, integrated on one branch, one pull request.\n`,
);
