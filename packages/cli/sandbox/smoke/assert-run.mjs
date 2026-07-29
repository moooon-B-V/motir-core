#!/usr/bin/env node
//
// The SEQUENCE ASSERTIONS of the sandbox loop smoke test (7.9.7c / MOTIR-885).
//
// A smoke test that only checks `motir auto`'s exit code proves almost nothing:
// a loop that skipped `mark_integrated`, dispatched two items in one iteration,
// or handed the agent a prompt it never asked the server for would all still
// exit 0. So the stub server records EVERY MCP call and this script asserts the
// protocol story the loop is supposed to tell:
//
//   • one `next_ready` PER ITERATION — never a batch read-ahead,
//   • each item flipped to in_progress BEFORE its prompt is fetched,
//   • each item's prompt fetched with the run's session branch as the SEED,
//   • each item recorded via `mark_integrated` on that same branch,
//   • a final `next_ready` that comes back empty — the loop stops because the
//     server said it was drained, not because it ran out of patience,
//   • exactly ONE pull request, for the one repo the run touched.
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

// ── the recorded calls ──────────────────────────────────────────────────────

const entries = readFileSync(CALLS_PATH, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const toolCalls = entries.filter((e) => e.method === 'tools/call');
const names = toolCalls.map((e) => e.tool);

check(
  entries.some((e) => e.method === 'initialize'),
  'the CLI never completed an MCP `initialize` handshake',
);

// The expected shape, built rather than hard-coded so the item count is a knob.
const expected = [];
for (let i = 1; i <= ITEMS; i += 1) {
  expected.push('next_ready', 'transition_status', 'dispatch_prompt', 'mark_integrated');
}
expected.push('next_ready'); // the drain probe

check(
  names.join(',') === expected.join(','),
  `tool-call sequence mismatch:\n  expected: ${expected.join(' → ')}\n  actual:   ${names.join(' → ')}`,
);

// ── per-item detail ─────────────────────────────────────────────────────────
// The sequence being right is not enough: the calls must be about the RIGHT
// item and carry the run's branch. A loop that dispatched item 1 four times
// would satisfy the shape above.

const branches = new Set();

for (let i = 1; i <= ITEMS; i += 1) {
  const key = `${PROJECT}-${i}`;
  const base = (i - 1) * 4;

  const transition = toolCalls[base + 1];
  check(
    transition?.args?.key === key && transition?.args?.status === 'in_progress',
    `${key}: expected a transition to in_progress, got ${JSON.stringify(transition?.args)}`,
  );

  const dispatch = toolCalls[base + 2];
  check(
    dispatch?.args?.key === key,
    `${key}: dispatch_prompt was called for ${dispatch?.args?.key ?? '(nothing)'}`,
  );
  check(
    typeof dispatch?.args?.sessionBranch === 'string' &&
      dispatch.args.sessionBranch.startsWith('motir/auto-'),
    `${key}: dispatch_prompt carried no session-branch seed (got ${JSON.stringify(
      dispatch?.args?.sessionBranch,
    )})`,
  );

  const integrated = toolCalls[base + 3];
  check(
    integrated?.args?.key === key,
    `${key}: mark_integrated was called for ${integrated?.args?.key ?? '(nothing)'}`,
  );
  check(
    integrated?.args?.sessionBranch === dispatch?.args?.sessionBranch,
    `${key}: mark_integrated recorded a different branch than the one dispatched on`,
  );
  // The harness self-report (MOTIR-1685) is how a Motir tenant can tell agent
  // work from human work; an unattended run that stopped sending it would erase
  // that provenance silently.
  check(
    typeof integrated?.args?.implementationHarness === 'string' &&
      integrated.args.implementationHarness.startsWith('motir-cli/'),
    `${key}: mark_integrated carried no motir-cli harness stamp`,
  );

  if (dispatch?.args?.sessionBranch) branches.add(dispatch.args.sessionBranch);
}

check(
  branches.size === 1,
  `the run used ${branches.size} session branches; a run has exactly one (${[...branches].join(', ')})`,
);

// The loop must stop because the SERVER drained, which means the last call is a
// `next_ready` whose answer was empty — the item count is what proves it.
check(
  toolCalls.filter((e) => e.tool === 'next_ready').length === ITEMS + 1,
  `expected ${ITEMS + 1} next_ready calls (one per item plus the drain probe), got ${
    toolCalls.filter((e) => e.tool === 'next_ready').length
  }`,
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
