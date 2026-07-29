#!/usr/bin/env node
//
// The SMOKE STUB MOTIR SERVER (Subtask 7.9.7c / MOTIR-885).
//
// A zero-dependency streamable-HTTP MCP server that scripts exactly the tool
// calls one `motir auto` run makes. It exists so the loop can be validated
// AGENT-INDEPENDENTLY and SERVER-INDEPENDENTLY: the smoke test needs no LLM, no
// Motir deployment, no Postgres and no network — which is what makes it safe to
// run on every pull request inside the sandbox image.
//
// It is deliberately NOT the MCP SDK. The image installs `motir` as a global
// npm package, so the SDK lives under /usr/local/lib/node_modules where an ESM
// import from /workspace cannot resolve it; hand-rolling the four protocol
// moves the CLI actually makes (initialize → notifications/initialized →
// tools/call ×N) keeps this file runnable by the bare `node` in the image.
//
// WHAT IT IS NOT: a conformance fixture. It asserts nothing about the real
// server's semantics — the suite that spawns the built binary against the REAL
// /api/mcp route is 7.9.5's (tests/cli/). This one answers the question "does
// the loop drive an agent end to end, inside the sandbox, with nothing real
// attached", and it RECORDS every call so the smoke script can assert the
// sequence rather than just the exit code.
//
// Usage:
//   node stub-server.mjs --port <n> --log <path> [--items <n>]
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

if (!LOG_PATH) {
  console.error('stub-server: --log <path> is required (the call log the smoke test asserts on).');
  process.exit(2);
}
writeFileSync(LOG_PATH, '');

/** Append one call record. NDJSON so the smoke script can grep it line-wise. */
function record(entry) {
  appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`);
}

// ── the scripted plan ───────────────────────────────────────────────────────
// N ready subtasks, all pinned to the `demo-repo` checkout the smoke fixture
// creates, handed out ONE PER `next_ready` — never as a list. The loop's
// re-query-every-iteration property is what makes that the honest shape.

const ITEMS = Array.from({ length: ITEM_COUNT }, (_, i) => ({
  id: `item-${i + 1}`,
  key: `${PROJECT_KEY}-${i + 1}`,
  kind: 'subtask',
  title: `Smoke item ${i + 1}`,
  priority: 'medium',
  status: { key: 'todo', category: 'todo' },
  type: 'code',
  executor: 'coding_agent',
  targetRepo: 'demo-repo',
  sessionBranch: null,
}));

/** Which items have been handed out. The loop excludes nothing on the happy
 *  path, so the stub is what advances the cursor. */
let served = 0;

// ── the tools the auto loop calls ───────────────────────────────────────────
//
// Named functions plus a `switch`, NOT a lookup table indexed by the name off
// the wire. A table dispatch (`TOOLS[name](args)`) lets a request choose which
// function runs — `TOOLS['constructor']` resolves through the prototype chain
// and gets invoked — so a stray request becomes a confusing stub crash instead
// of the honest `unknown_tool` result below. CodeQL flags that shape
// (js/unvalidated-dynamic-method-call) and is right to; a switch has no dynamic
// callee at all, so each arm is a statically known function.

function whoami() {
  return {
    user: { id: 'u1', name: 'Smoke User', email: 'smoke@example.invalid' },
    workspace: { id: 'w1', name: 'Smoke', slug: 'smoke' },
  };
}

function nextReady() {
  const item = ITEMS[served];
  if (!item) return { item: null };
  served += 1;
  return { item };
}

function transitionStatus(args) {
  return { key: args.key, status: args.status };
}

// The SEED contract (MOTIR-1802): a `sessionBranch` argument is a fallback an
// item with no lineage of its own adopts. The stub mirrors that rather than
// inventing a branch, because the whole point of the smoke run is that the
// CLI's branch reaches the agent's prompt.
function dispatchPrompt(args) {
  const branch = args.sessionBranch ?? null;
  return {
    key: args.key,
    prompt: [
      `You are executing ${args.key}.`,
      '',
      'GIT WORKFLOW',
      branch
        ? `Integrate your work into the session branch ${branch}. Do NOT open a pull request.`
        : 'Open a pull request of your own.',
      '',
      `MOTIR_SMOKE_ITEM=${args.key}`,
      branch ? `MOTIR_SMOKE_BRANCH=${branch}` : '',
    ].join('\n'),
    targetRepo: 'demo-repo',
    workflowMode: branch ? 'session_lineage' : 'per_item_pr',
    sessionBranch: branch,
  };
}

function markIntegrated(args) {
  return { key: args.key, sessionBranch: args.sessionBranch };
}

/** Advertised in `tools/list`. The auto loop never reads it — it calls the
 *  tools directly — so this is documentation, not dispatch. */
const TOOL_NAMES = [
  'whoami',
  'next_ready',
  'transition_status',
  'dispatch_prompt',
  'mark_integrated',
];

/** Dispatch one tool call. Returns null for a name this stub does not serve. */
function callTool(name, args) {
  switch (name) {
    case 'whoami':
      return whoami();
    case 'next_ready':
      return nextReady();
    case 'transition_status':
      return transitionStatus(args);
    case 'dispatch_prompt':
      return dispatchPrompt(args);
    case 'mark_integrated':
      return markIntegrated(args);
    default:
      return null;
  }
}

// ── JSON-RPC / streamable-HTTP ──────────────────────────────────────────────

function handleMessage(msg) {
  const { method, params = {} } = msg;

  if (method === 'initialize') {
    record({ method });
    // Echo the client's protocol version back: the SDK only accepts a version
    // it supports, and the one it asked for is by definition supported.
    return {
      protocolVersion: params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'motir-smoke-stub', version: '0.0.0' },
    };
  }

  if (method === 'tools/list') {
    record({ method });
    return {
      tools: TOOL_NAMES.map((name) => ({
        name,
        description: `smoke stub: ${name}`,
        inputSchema: { type: 'object' },
      })),
    };
  }

  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments ?? {};
    record({ method, tool: name, args });
    const structuredContent = callTool(name, args);
    if (structuredContent === null) {
      // An UNKNOWN tool is an `isError` result, not a JSON-RPC error — that is
      // how the real server reports a refused call, and the CLI maps the text
      // into a CliError. Getting this wrong would make a CLI regression look
      // like a stub crash.
      return {
        isError: true,
        content: [{ type: 'text', text: `unknown_tool: ${name}` }],
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  }

  record({ method, unhandled: true });
  return null;
}

const server = createServer((req, res) => {
  // The transport opens a GET stream after `notifications/initialized`. 405 is
  // the protocol's "this server offers no server→client stream", which the SDK
  // treats as fine — anything else would surface as a transport error.
  if (req.method === 'GET') {
    res.writeHead(405, { 'content-type': 'application/json' }).end('{"error":"no sse stream"}');
    return;
  }
  if (req.method === 'DELETE') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }

  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"bad json"}');
      return;
    }

    // A notification / response carries no id and gets no body — 202 is what
    // the transport expects for `notifications/initialized`.
    if (msg.id === undefined) {
      record({ method: msg.method, notification: true });
      res.writeHead(202).end();
      return;
    }

    let result;
    try {
      result = handleMessage(msg);
    } catch (err) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32603, message: String(err) },
        }),
      );
      return;
    }

    if (result === null) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        }),
      );
      return;
    }

    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
});

// 127.0.0.1 only. The stub has no auth of its own (it accepts any bearer), so
// it must never be reachable from outside the container.
server.listen(PORT, '127.0.0.1', () => {
  // The URL is DATA — loop-smoke.sh redirects stdout into a file and reads it as
  // the readiness signal — so it is written, not logged.
  const address = server.address();
  process.stdout.write(`http://127.0.0.1:${address.port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
