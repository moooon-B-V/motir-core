#!/usr/bin/env node
//
// The SMOKE STUB MOTIR SERVER (Subtask 7.9.7c / MOTIR-885).
//
// A zero-dependency HTTP server that answers exactly the `/api/v1` requests one
// `motir auto` run makes. It exists so the loop can be validated
// AGENT-INDEPENDENTLY and SERVER-INDEPENDENTLY: the smoke test needs no LLM, no
// Motir deployment, no Postgres and no network — which is what makes it safe to
// run on every pull request inside the sandbox image.
//
// ── ⚠️ IT SPOKE MCP UNTIL 11.5.6, AND THAT IS WHY THIS FILE WAS REWRITTEN ──
// The CLI was an MCP client, so this was a hand-rolled streamable-HTTP JSON-RPC
// server with a `TOOLS` table. MOTIR-2214 moved every method onto `/api/v1`, and
// this file's request handler answered every `GET` with a 405 — so the FIRST
// request of every smoke run failed and nothing after it could pass
// (MOTIR-2436). The device-grant routes below are the only part that survived
// unchanged, because `motir login` never used MCP in the first place.
//
// ── The bodies are REAL v1 SHAPES, and they have to be ──────────────────────
// The old stub could answer loosely: an MCP tool result was an opaque blob the
// client cast to a type, so an approximate payload passed. The v1 client
// validates EVERY response against its generated Ajv validator before an adapter
// sees it, so a body that is nearly right is rejected by the CLI itself, with a
// message naming the field. That makes this file harder to write and much more
// valuable: once the smoke passes, it has proven that the shapes the image's CLI
// expects are the shapes the API documents.
//
// `packages/cli/test/sandboxStub.test.ts` runs every body below through those
// same validators, so a drift is caught in the unit lane in milliseconds rather
// than in a Docker matrix twenty minutes later.
//
// WHAT IT IS NOT: a conformance fixture. It asserts nothing about the real
// server's semantics — the suite that spawns the built binary against the REAL
// routes is 7.9.5's (tests/cli/). This one answers the question "does the loop
// drive an agent end to end, inside the sandbox, with nothing real attached",
// and it RECORDS every request so the smoke script can assert the sequence
// rather than just the exit code.
//
// It ALSO serves the two DEVICE-GRANT routes `motir login` speaks (MOTIR-1877):
// `/api/cli/device/start` and `/api/cli/device/token`. Those were never `/api/v1`
// and are not now — a login runs before any bearer exists, which is the shape
// the real server has too.
//
// The approval a human would give in a browser is scripted: the token endpoint
// answers `authorization_pending` for `--device-pending` polls and then grants.
// Zero is a legitimate value — an instantly-approved grant — and the default of
// one exercises the polling loop at least once.
//
// Usage:
//   node stub-server.mjs --port <n> --log <path> [--items <n>] [--device-pending <n>]
// It prints one line to stdout — the base URL — once it is listening.

import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';

// ── args ────────────────────────────────────────────────────────────────────

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const PORT = Number.parseInt(argOf('port', '0'), 10);
const LOG_PATH = argOf('log', '');
const ITEM_COUNT = Number.parseInt(argOf('items', '2'), 10);
const PROJECT_KEY = argOf('project', 'SMOKE');
/** Polls answered `authorization_pending` before the grant is approved. */
const DEVICE_PENDING_POLLS = Number.parseInt(argOf('device-pending', '1'), 10);

/**
 * Whether this file is being RUN, rather than imported for its fixtures.
 *
 * `packages/cli/test/sandboxStub.test.ts` imports it to validate every response
 * body against the generated Ajv validators, and an import must not demand a
 * `--log` path, truncate a file or bind a socket. Everything with a side effect
 * is behind this flag; everything a test reads is a pure function above it.
 */
const IS_SCRIPT = process.argv[1] !== undefined && process.argv[1].endsWith('stub-server.mjs');

if (IS_SCRIPT) {
  if (!LOG_PATH) {
    console.error(
      'stub-server: --log <path> is required (the call log the smoke test asserts on).',
    );
    process.exit(2);
  }
  writeFileSync(LOG_PATH, '');
}

/** Append one call record. NDJSON so the smoke script can grep it line-wise. */
function record(entry) {
  if (!IS_SCRIPT) return;
  appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`);
}

// ── the scripted plan ───────────────────────────────────────────────────────
// N ready subtasks, all pinned to the `demo-repo` checkout the smoke fixture
// creates. Rows are REAL `ReadyItem` shapes — the CLI validates them, so an
// invented field or a missing one fails the run at the first read.

/** A fixed instant: the bodies are static, so a moving clock would be noise. */
const NOW = '2026-01-01T00:00:00.000Z';

const ITEMS = Array.from({ length: ITEM_COUNT }, (_unused, i) => ({
  key: `${PROJECT_KEY}-${i + 1}`,
  kind: 'subtask',
  title: `Smoke item ${i + 1}`,
  priority: 'medium',
  status: { key: 'todo', category: 'todo' },
  type: 'code',
  executor: 'coding_agent',
  // The READY row stays unclaimed: the loop re-reads the set each iteration, and
  // an item it already took is held out by its STATUS (in review), not by the
  // claim — so leaving this null keeps the fixture honest about which rule does
  // the work (MOTIR-2427).
  assigneeId: null,
  assignee: null,
  descriptionExcerpt: null,
  inheritedSessionBranch: null,
  dependencies: { blockedBy: [], blocks: [] },
}));

/**
 * WHAT MAKES AN ITEM LEAVE THE READY SET — and why it is a status flip rather
 * than a cursor.
 *
 * The MCP stub handed items out one per `next_ready` call and advanced a
 * `served` counter, because `next_ready` was a tool with a server-side cursor.
 * There is no such endpoint on `/api/v1` and there should not be: the CLI reads
 * the ready COLLECTION and picks the first row it has not excluded (MOTIR-2398).
 *
 * So the stub has to model the real rule instead, and the real rule is simple —
 * `workItemsService.listReady` returns childless leaves in the **todo** status
 * CATEGORY. `motir auto` flips an item to `in_progress` before fetching its
 * prompt, and that flip is what drops it out. Modelling it any other way (a
 * counter, an integration flag) would let a loop that never transitioned an item
 * still drain the set — which is precisely the regression the sequence
 * assertions exist to catch.
 */
const statuses = new Map(ITEMS.map((item) => [item.key, item.status]));
/** Who has claimed each item — written by the PATCH the loop makes before every
 *  dispatch (MOTIR-2427), and read back by the detail body. */
const assignees = new Map();

const IN_PROGRESS = { key: 'in_progress', category: 'in_progress' };
const IN_REVIEW = { key: 'in_review', category: 'in_progress' };

/** The rows still in the ready set, newest status applied. */
function readyRows() {
  return ITEMS.filter((item) => statuses.get(item.key)?.category === 'todo').map((item) => ({
    ...item,
    status: statuses.get(item.key),
  }));
}

// ── the `/api/v1` responses ─────────────────────────────────────────────────
//
// One function per operation, each returning the body of that operation's
// documented success response. Named functions selected by an explicit table,
// never a lookup indexed by something off the wire — the same reason the MCP
// version gave: a dynamic callee lets a request choose which function runs, and
// CodeQL is right to flag it (js/unvalidated-dynamic-method-call).

function me() {
  return {
    user: { id: 'u1', name: 'Smoke User', email: 'smoke@example.invalid' },
    workspaceId: 'w1',
    scopes: ['read', 'work_items:write', 'integration'],
  };
}

function workspaces() {
  return {
    items: [{ id: 'w1', name: 'Smoke', slug: 'smoke', createdAt: NOW }],
    nextCursor: null,
  };
}

function projects() {
  return {
    items: [{ key: PROJECT_KEY, name: 'Smoke', accessLevel: 'open', archived: false }],
    nextCursor: null,
  };
}

/**
 * The ready collection — one page, no cursor.
 *
 * `motir ready` reads it as a page and `motir auto` walks it once per iteration,
 * so this one function serves both. Before the loop it describes the set the
 * loop is about to drain; after it, an empty one — which is what lets the smoke
 * assert the loop stopped because the SERVER drained rather than because it ran
 * out of patience.
 *
 * It is also the cheapest end-to-end proof that a credential RESOLVED, which is
 * why the mount-free legs (MOTIR-1877) run `motir ready` as their first
 * assertion.
 */
function readySet() {
  return { items: readyRows(), nextCursor: null };
}

// The SEED contract (MOTIR-1802): a `sessionBranch` argument is a fallback an
// item with no lineage of its own adopts. The stub mirrors that rather than
// inventing a branch, because the whole point of the smoke run is that the
// CLI's branch reaches the agent's prompt. It arrives as a QUERY parameter now,
// not a tool argument.
function dispatchPrompt(key, query) {
  const branch = query.get('sessionBranch');
  return {
    key,
    // MOTIR-2445 — the parent as a field. The v1 client validates every body,
    // so this is required even though the smoke loop never reads it.
    parentKey: null,
    prompt: [
      `You are executing ${key}.`,
      '',
      'GIT WORKFLOW',
      branch
        ? `Integrate your work into the session branch ${branch}. Do NOT open a pull request.`
        : 'Open a pull request of your own.',
      '',
      `MOTIR_SMOKE_ITEM=${key}`,
      branch ? `MOTIR_SMOKE_BRANCH=${branch}` : '',
    ].join('\n'),
    targetRepo: 'demo-repo',
    targetRepoCloneUrl: null,
    targetRepoDefaultBranch: null,
    workflowMode: branch ? 'session_lineage' : 'per_item_pr',
    sessionBranch: branch,
    advisories: [],
  };
}

/**
 * The status flip. Answers a full `WorkItemDetail`, because that is what the
 * operation declares — the CLI throws the value away, but it VALIDATES it first,
 * so a thinner body fails the run with a message naming the missing field.
 */
function transition(key, body) {
  if (body?.status === 'in_review') statuses.set(key, IN_REVIEW);
  else if (body?.status === 'in_progress') statuses.set(key, IN_PROGRESS);
  return workItemDetail(key);
}

/**
 * The CLAIM (MOTIR-2427) — a plain assignment before every dispatch.
 *
 * Answers the full `WorkItemDetail` the PATCH declares, for the same reason the
 * transition does: the CLI discards the body but VALIDATES it first, so a thin
 * one fails the run with a field name rather than a routing error.
 */
function claim(key, body) {
  if (typeof body?.assigneeId === 'string') assignees.set(key, body.assigneeId);
  return workItemDetail(key);
}

function integration(key, body) {
  // Integration lands the item In Review, which keeps it out of the ready set
  // for the rest of the run even if a future CLI stopped transitioning first.
  statuses.set(key, IN_REVIEW);
  return {
    key,
    status: 'in_review',
    sessionBranch: body?.sessionBranch ?? null,
    updatedAt: NOW,
    implementationSource: 'byok',
    implementationHarness: body?.implementationHarness ?? null,
    implementationModel: body?.implementationModel ?? null,
  };
}

/** A minimal but COMPLETE `WorkItemDetail` — every field the schema declares. */
function workItemDetail(key) {
  const item = ITEMS.find((row) => row.key === key);
  return {
    key,
    kind: item?.kind ?? 'subtask',
    type: item?.type ?? 'code',
    title: item?.title ?? `Smoke item ${key}`,
    status: statuses.get(key)?.key ?? 'todo',
    priority: item?.priority ?? 'medium',
    // Reflects the claim the loop wrote, so the smoke can assert the item really
    // was assigned rather than that a request merely 200'd (MOTIR-2427).
    assigneeId: assignees.get(key) ?? null,
    reporterId: 'u1',
    dueDate: null,
    estimateMinutes: null,
    storyPoints: null,
    createdAt: NOW,
    updatedAt: NOW,
    descriptionMd: null,
    parentKey: null,
    ancestorKeys: [],
    children: [],
    links: {
      blockedBy: [],
      blocks: [],
      relatesTo: [],
      duplicates: [],
      clones: [],
    },
    readiness: {
      ready: true,
      openBlockers: [],
      blockedByAncestorKey: null,
      blockedByAncestorTitle: null,
    },
    labels: [],
    components: [],
    commentCount: 0,
    sprintId: null,
    targetRepo: 'demo-repo',
    executor: item?.executor ?? 'coding_agent',
    planningSource: null,
    planningHarness: null,
    planningModel: null,
    implementationSource: null,
    implementationHarness: null,
    implementationModel: null,
    archivedAt: null,
  };
}

// ── the route table ─────────────────────────────────────────────────────────
//
// Keyed by method plus a path TEMPLATE with `{name}` for a dynamic segment — the
// spelling the OpenAPI paths use, so a row reads like the operation it serves.
//
// ⚠️ A LITERAL segment beats a dynamic one at the same position, matching
// Next.js's own precedence. Without it `…/work-items/{key}` would swallow a
// sibling literal route, and the failure would look like a missing card rather
// than a routing bug.

const ROUTES = [
  ['GET', '/api/v1/me', () => me()],
  ['GET', '/api/v1/workspaces', () => workspaces()],
  ['GET', '/api/v1/projects', () => projects()],
  ['GET', '/api/v1/projects/{projectKey}/ready', () => readySet()],
  ['GET', '/api/v1/work-items/{key}', (params) => workItemDetail(params.key)],
  [
    'GET',
    '/api/v1/work-items/{key}/dispatch-prompt',
    (params, query) => dispatchPrompt(params.key, query),
  ],
  [
    'POST',
    '/api/v1/work-items/{key}/transitions',
    (params, _query, body) => transition(params.key, body),
  ],
  ['PATCH', '/api/v1/work-items/{key}', (params, _query, body) => claim(params.key, body)],
  [
    'POST',
    '/api/v1/work-items/{key}/integration',
    (params, _query, body) => integration(params.key, body),
  ],
];

/** Resolve a pathname against one template, returning its `{name}` params. */
function matchTemplate(template, pathname) {
  const wanted = template.split('/');
  const actual = pathname.split('/');
  if (wanted.length !== actual.length) return null;
  const params = {};
  let literals = 0;
  for (const [i, segment] of wanted.entries()) {
    const here = actual[i];
    if (segment.startsWith('{') && segment.endsWith('}')) {
      params[segment.slice(1, -1)] = decodeURIComponent(here);
      continue;
    }
    if (segment !== here) return null;
    literals += 1;
  }
  return { params, literals };
}

/** The best-matching route for a request, literal segments winning ties. */
function matchRoute(method, pathname) {
  let best = null;
  for (const [routeMethod, template, handler] of ROUTES) {
    if (routeMethod !== method) continue;
    const matched = matchTemplate(template, pathname);
    if (!matched) continue;
    if (best === null || matched.literals > best.literals) {
      best = { handler, params: matched.params, literals: matched.literals };
    }
  }
  return best;
}

/**
 * Serve one `/api/v1` request. Returns false when the path is not ours, so an
 * unrouted request gets the honest 404 rather than a friendly invention — a
 * smoke test that accidentally depended on some other endpoint must FAIL rather
 * than pass against a fake.
 */
function handleV1(method, url, body, res) {
  if (!url.pathname.startsWith('/api/v1')) return false;
  record({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });

  const matched = matchRoute(method, url.pathname);
  if (!matched) {
    res
      .writeHead(404, { 'content-type': 'application/json' })
      .end(
        JSON.stringify({ code: 'NOT_FOUND', error: `no stubbed route ${method} ${url.pathname}` }),
      );
    return true;
  }

  const payload = matched.handler(matched.params, url.searchParams, body);
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
  return true;
}

// ⚠️ EXPORTED FOR `packages/cli/test/sandboxStub.test.ts`, which runs each body
// through the generated Ajv validator for its operation. Importing this file
// starts no server — the `listen` at the bottom is guarded on being run as a
// script — so the check costs nothing.
export const __fixtures = {
  me,
  workspaces,
  projects,
  readySet,
  workItemDetail,
  dispatchPrompt,
  transition,
  integration,
  matchRoute,
  ITEMS,
};

// ── the device grant (`motir login`) ────────────────────────────────────────
//
// The two routes deviceAuth.ts speaks. They are NOT MCP: a login runs before any
// credential exists, so there is no bearer to open an MCP session with — the real
// server has the same split, and the stub mirrors it rather than inventing a
// friendlier shape the CLI would never meet.
//
// The human in the middle is scripted, not skipped: the token endpoint answers
// `authorization_pending` until the configured number of polls has gone by, which
// is what makes the smoke run exercise the POLLING loop rather than a single
// lucky request.

const DEVICE_START_PATH = '/api/cli/device/start';
const DEVICE_TOKEN_PATH = '/api/cli/device/token';
const DEVICE_CODE = 'smoke-device-code';
/** Eight characters with no dash, so `groupUserCode` regroups it to K4TP-9RXM —
 *  the form the smoke assertions look for on the container's stderr. */
const USER_CODE = 'K4TP9RXM';

let devicePolls = 0;
let listeningPort = PORT;

function deviceStart(body) {
  devicePolls = 0;
  record({ device: 'start', hostname: body?.hostname ?? null });
  const base = `http://127.0.0.1:${listeningPort}`;
  return {
    status: 200,
    body: {
      device_code: DEVICE_CODE,
      user_code: USER_CODE,
      verification_uri: `${base}/device`,
      verification_uri_complete: `${base}/device?code=${USER_CODE}`,
      expires_in: 900,
      // One second is the CLI's floor (MIN_POLL_SECONDS) — the smoke run should
      // not sit through a realistic five.
      interval: 1,
    },
  };
}

function deviceToken(body) {
  devicePolls += 1;
  record({ device: 'token', poll: devicePolls });
  if (body?.device_code !== DEVICE_CODE) {
    // What the real server answers for an unknown / consumed code. Getting this
    // wrong would make a CLI regression look like a stub crash.
    return { status: 400, body: { error: 'invalid_grant' } };
  }
  if (devicePolls <= DEVICE_PENDING_POLLS) {
    return { status: 400, body: { error: 'authorization_pending' } };
  }
  return {
    status: 200,
    body: {
      access_token: 'device-not-a-real-token',
      token_type: 'bearer',
      scope: 'cli',
      expires_in: 0,
      user: { id: 'u1', name: 'Smoke User', email: 'smoke@example.invalid' },
      workspace: { id: 'w1', name: 'Smoke', slug: 'smoke' },
    },
  };
}

/** Handle a device route. Returns false when the path is not one of them. */
function handleDeviceRoute(pathname, body, res) {
  if (pathname !== DEVICE_START_PATH && pathname !== DEVICE_TOKEN_PATH) return false;
  const { status, body: payload } =
    pathname === DEVICE_START_PATH ? deviceStart(body) : deviceToken(body);
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
  return true;
}

// ── the socket ──────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = (req.method ?? 'GET').toUpperCase();

    // Drained BEFORE anything branches, so an unmatched request never leaves an
    // unread socket behind.
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"bad json"}');
        return;
      }
    }

    // The device routes are plain JSON and are dispatched on the PATH — they
    // predate any bearer, so they are not under `/api/v1` and never were.
    if (handleDeviceRoute(url.pathname, body, res)) return;
    if (handleV1(method, url, body, res)) return;

    record({ method, path: url.pathname, unhandled: true });
    res
      .writeHead(404, { 'content-type': 'application/json' })
      .end(JSON.stringify({ code: 'NOT_FOUND', error: `not a stubbed route: ${url.pathname}` }));
  })();
});

// 127.0.0.1 only. The stub has no auth of its own (it accepts any bearer), so
// it must never be reachable from outside the container.
if (IS_SCRIPT) {
  server.listen(PORT, '127.0.0.1', () => {
    // The URL is DATA — loop-smoke.sh redirects stdout into a file and reads it
    // as the readiness signal — so it is written, not logged.
    const address = server.address();
    listeningPort = address.port;
    process.stdout.write(`http://127.0.0.1:${address.port}\n`);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close();
      process.exit(0);
    });
  }
}
