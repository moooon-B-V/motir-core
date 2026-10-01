// THE VENDOR CLIs' HEADLESS HALF, STUBBED — the acceptance lane's stand-in for
// `claude -p` and `codex exec` behind the agent chat (Story MOTIR-6863 ·
// MOTIR-7019). TEST-ONLY: `bin/claude` and `bin/codex` exec it, and only the
// lane's terminal host (host.ts) puts `bin/` on a machine's PATH.
//
// ⚠️ IT NEVER REACHES A VENDOR. No network connection is opened, no model is
// called, no credential is read or written. What it does:
//
//   - answers ONLY the invocations `docs/decisions/agent-chat.md` records — Q3's
//     headless turn (new and resumed) and Q2's `claude auth status --json` —
//     argv for argv. Anything else exits 2, so an adapter that drifts from the
//     ADR fails the spec instead of being answered;
//   - replays a fixture COPIED FROM THE ADAPTERS' OWN (`packages/cli/test/
//     agentTerminal/fixtures/chat/**`, with this story's words), one line at a
//     time at a human pace, so what the tab draws went through the REAL adapter
//     and the REAL runner;
//   - keeps Claude Code's session store the way the binary does
//     (`$CLAUDE_CONFIG_DIR/projects/<cwd>/<id>.jsonl`), so the session list and
//     a resume's history are read by the adapter from a real file;
//   - RECORDS every invocation, its prompt and every signal it receives, one JSON
//     line each, to `$MOTIR_E2E_STUB_CALLS` — the spec asserts on arguments
//     (`--resume <id>`) and signals (SIGINT) from there.
//
// The sign-in `claude auth status` reports is chosen by the machine's own
// environment, which the spec seeds per agent (host.ts's setup sidecar):
// `MOTIR_E2E_CLAUDE_SIGNIN=api_key` answers an Anthropic API-key sign-in, and
// anything else a Claude subscription. The replayed `system/init` carries the
// matching `apiKeySource`, so Q2's per-turn backstop reads the same answer the
// gate did.
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const [cli, ...args] = process.argv.slice(2);

/** Delay after each replayed line, by what the line is — slow enough to watch. */
const PACE = { delta: 80, tool: 450, line: 40 };

function record(entry) {
  const file = process.env['MOTIR_E2E_STUB_CALLS'];
  if (!file) return;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ cli, pid: process.pid, ...entry })}\n`);
  } catch {
    // A stub that cannot record still answers; the spec's assertion will say so.
  }
}

function refuse(why) {
  record({ args, refused: why });
  process.stderr.write(`${cli} (e2e stub): unsupported invocation — ${why}\n`);
  process.exit(2);
}

/** A fixture's JSON lines, its `# ` header dropped. */
function fixture(name) {
  return readFileSync(path.join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('#'));
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function paceOf(value) {
  if (value?.type === 'stream_event') {
    return value.event?.delta?.type === 'text_delta' ? PACE.delta : PACE.line;
  }
  if (value?.type === 'item.started' || value?.type === 'item.completed') return PACE.tool;
  if (value?.type === 'user' || value?.type === 'assistant') return PACE.tool;
  return PACE.line;
}

let stopped = false;
/** Called on SIGINT, after the signal is recorded. */
let onStop = () => process.exit(130);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    record({ signal });
    if (signal !== 'SIGINT') process.exit(143);
    stopped = true;
    onStop();
  });
}

// ── claude ──────────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const apiKey = process.env['MOTIR_E2E_CLAUDE_SIGNIN'] === 'api_key';

/** Q3's argv exactly: `-p … (--session-id <uuid> | --resume <id>) --dangerously-skip-permissions`. */
function claudeTurnArgs() {
  const head = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (args.length !== head.length + 3) return null;
  if (head.some((flag, i) => args[i] !== flag)) return null;
  const [mode, id, last] = args.slice(head.length);
  if (last !== '--dangerously-skip-permissions' || !UUID.test(id ?? '')) return null;
  if (mode === '--session-id') return { id, resumed: false };
  if (mode === '--resume') return { id, resumed: true };
  return null;
}

/** Which recorded stream answers this prompt. */
function claudeFixture(prompt, resumed) {
  if (!resumed) return 'claude/folders.jsonl';
  if (/schema/i.test(prompt)) return 'claude/resume-schema.jsonl';
  if (/walk me through/i.test(prompt)) return 'claude/long-reply.jsonl';
  return 'claude/resume.jsonl';
}

/** Claude Code's own store: `$CLAUDE_CONFIG_DIR/projects/<cwd, each non-alphanumeric → ->/<id>.jsonl`. */
function storeFile(id) {
  const config =
    process.env['CLAUDE_CONFIG_DIR'] || path.join(process.env['HOME'] ?? '', '.claude');
  const dir = path.join(config, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  return path.join(dir, `${id}.jsonl`);
}

async function claude() {
  if (args.length === 3 && args[0] === 'auth' && args[1] === 'status' && args[2] === '--json') {
    record({ args });
    const answer = apiKey ? 'auth-status-api-key.json' : 'auth-status-subscription.json';
    process.stdout.write(readFileSync(path.join(FIXTURES, 'claude', answer), 'utf8'));
    return;
  }
  const turn = claudeTurnArgs();
  if (!turn) refuse('not the headless turn agent-chat.md Q3 records');
  const prompt = readStdin();
  record({ args, prompt });
  const store = storeFile(turn.id);
  const cwd = process.cwd();
  const now = () => new Date().toISOString();
  const keep = (entry) =>
    appendFileSync(
      store,
      `${JSON.stringify({ cwd, sessionId: turn.id, ...entry, timestamp: now() })}\n`,
    );
  keep({ type: 'user', message: { role: 'user', content: prompt }, uuid: `p-${Date.now()}` });

  const aborted = JSON.parse(
    readFileSync(path.join(FIXTURES, 'claude/aborted-result.json'), 'utf8'),
  );
  const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  onStop = () => {
    // Q1's Stop row: the `aborted_streaming` result, then exit 0.
    emit({ ...aborted, session_id: turn.id });
    process.exit(0);
  };
  for (const line of fixture(claudeFixture(prompt, turn.resumed))) {
    if (stopped) return;
    const value = JSON.parse(line);
    if ('session_id' in value) value.session_id = turn.id;
    if (value.type === 'system' && value.subtype === 'init') {
      value.cwd = cwd;
      // The same answer the gate read: an API key, or none at all (Q2's backstop).
      value.apiKeySource = apiKey ? 'ANTHROPIC_API_KEY' : 'none';
    }
    emit(value);
    if (value.type === 'assistant' || value.type === 'user') {
      keep({ type: value.type, message: value.message, uuid: value.uuid });
    }
    await sleep(paceOf(value));
  }
}

// ── codex ───────────────────────────────────────────────────────────────────

const CODEX_FLAGS = ['--json', '-c', 'sandbox_mode="workspace-write"'];

/** Q3's argv exactly: `exec <flags> -`, or `exec resume <flags> <id> -`. */
function codexTurnArgs() {
  if (args[0] !== 'exec' || args[args.length - 1] !== '-') return null;
  const resumed = args[1] === 'resume';
  const flags = args.slice(resumed ? 2 : 1, (resumed ? 2 : 1) + CODEX_FLAGS.length);
  if (CODEX_FLAGS.some((flag, i) => flags[i] !== flag)) return null;
  const rest = args.slice((resumed ? 2 : 1) + CODEX_FLAGS.length, -1);
  if (resumed ? rest.length !== 1 : rest.length !== 0) return null;
  return { resumed, id: resumed ? rest[0] : null };
}

async function codex() {
  const turn = codexTurnArgs();
  if (!turn) refuse('not the headless turn agent-chat.md Q3 records');
  const prompt = readStdin();
  record({ args, prompt });
  // Q1's Stop row: exit 1, no final event.
  onStop = () => process.exit(1);
  for (const line of fixture('codex/command-and-edit.jsonl')) {
    if (stopped) return;
    const value = JSON.parse(line);
    if (value.type === 'thread.started' && turn.id) value.thread_id = turn.id;
    process.stdout.write(`${JSON.stringify(value)}\n`);
    await sleep(paceOf(value));
  }
}

// ── dispatch ────────────────────────────────────────────────────────────────

try {
  statSync(FIXTURES);
} catch {
  refuse('fixtures missing');
}
if (cli === 'claude') await claude();
else if (cli === 'codex') await codex();
else refuse('unknown CLI');
