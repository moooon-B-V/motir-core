import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParsedAgentCommand } from './agentProfiles.js';
import { CliError } from './errors.js';

// Running the user's OWN coding agent (Subtask 7.9.3 · MOTIR-881). BYOK: the
// agent binary, its credential, and its model are the user's — Motir launches
// it, hands it the server-generated prompt, and reports its exit code. It never
// reads the agent's credential and never inspects its output.
//
// The prompt is delivered BOTH ways, because agent CLIs disagree about how they
// take input:
//   • on STDIN, for the ones that read a piped prompt; and
//   • as `$MOTIR_PROMPT_FILE`, a path to a temp file, for the ones that want
//     `--prompt-file <path>` (or that re-exec themselves and lose stdin).
// Supplying both means a new agent usually needs no Motir change at all — which
// is the point of the agent-agnostic BYOK design.
//
// The child inherits stdout/stderr so its output STREAMS THROUGH live rather
// than being buffered and replayed: a coding agent run is minutes long, and a
// silent terminal is indistinguishable from a hang.
//
// ── the agent's SELF-REPORT ($MOTIR_AGENT_REPORT · MOTIR-2419) ──────────────
// One thing about a BYOK run only the agent can answer: WHICH MODEL ANSWERED.
// Nothing outside the process can see it, so it arrives by self-report — a JSON
// file the agent writes at the path in `$MOTIR_AGENT_REPORT`, which the prompt
// asks it for and this module reads back.
//
// The path lives in the SAME per-run temp dir as the prompt, and that is what
// makes the channel safe rather than merely convenient: the dir is created for
// this dispatch and removed when it ends, so there is no file for a later item
// to inherit. A fixed path in the checkout would carry item N's model onto item
// N+1 whenever the agent forgot to write one — a wrong answer wearing the shape
// of a right one, which is the exact failure the model field exists to avoid.
// Nothing here is trusted beyond its shape: an absent, unreadable, malformed or
// blank report is a null model, never a guess and never an error.

/** The file mode for the prompt temp file: owner read/write only. It carries
 *  the item's full description, which is the user's project data. */
const PROMPT_FILE_MODE = 0o600;

export interface AgentRunResult {
  /** The agent's exit code — 0 is success. A signal death reports 1 (there is
   *  no exit code in that case, and it is unambiguously not success). */
  exitCode: number;
  /** The signal that killed the agent, when it was killed by one. */
  signal: NodeJS.Signals | null;
  /**
   * The model the agent SELF-REPORTED, or null when it reported none.
   *
   * Null is a first-class answer, not a missing value: the caller records it
   * verbatim as `implementationModel`. Never defaulted — a run whose agent said
   * nothing must leave the field empty rather than name a model nobody
   * observed.
   */
  model: string | null;
}

/**
 * The longest string accepted as a model identifier. A self-report is UNTRUSTED
 * input that gets written to a database column, and something longer than this
 * is not a model id — it is an agent that dumped its context into the field.
 * Rejected rather than truncated: half an identifier is a wrong answer.
 */
const MAX_MODEL_LENGTH = 200;

/**
 * Read the agent's self-report. Total: every failure mode — no file, no
 * permission, invalid JSON, a non-object, a non-string, a blank or an
 * implausibly long `model` — is the same answer, a null model.
 */
function readAgentReport(path: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const model = (parsed as { model?: unknown }).model;
  if (typeof model !== 'string') return null;
  const trimmed = model.trim();
  if (trimmed === '' || trimmed.length > MAX_MODEL_LENGTH) return null;
  return trimmed;
}

export interface RunAgentOptions {
  command: ParsedAgentCommand;
  /** The server-generated prompt, delivered verbatim. */
  prompt: string;
  /** The resolved checkout (or workspace root) the agent runs in. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable seams for the tests — never overridden in production. */
  spawnFn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  tempDirFactory?: () => string;
}

function defaultTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'motir-prompt-'));
}

/**
 * Launch the agent on a prompt and resolve with its exit code.
 *
 * Never rejects on a non-zero exit — a failing agent is an ORDINARY outcome the
 * caller reports and records (the item stays In Progress, the exclude list
 * grows), not an exception. It DOES throw a {@link CliError} when the binary
 * cannot be launched at all (ENOENT), because that is a setup problem `motir
 * doctor` diagnoses rather than a failed piece of work.
 */
export async function runAgent(opts: RunAgentOptions): Promise<AgentRunResult> {
  const spawnFn = opts.spawnFn ?? spawn;
  const dir = (opts.tempDirFactory ?? defaultTempDir)();
  const promptFile = join(dir, 'prompt.md');
  const reportFile = join(dir, 'agent-report.json');
  writeFileSync(promptFile, opts.prompt, { mode: PROMPT_FILE_MODE });

  try {
    const result = await new Promise<Omit<AgentRunResult, 'model'>>((resolve, reject) => {
      const child = spawnFn(opts.command.binary, opts.command.args, {
        cwd: opts.cwd,
        // stdin piped (we write the prompt); stdout/stderr inherited so the
        // agent's output streams straight through to the user's terminal.
        stdio: ['pipe', 'inherit', 'inherit'],
        env: {
          ...(opts.env ?? process.env),
          MOTIR_PROMPT_FILE: promptFile,
          MOTIR_AGENT_REPORT: reportFile,
        },
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        reject(
          err.code === 'ENOENT'
            ? new CliError(`Could not launch the agent "${opts.command.binary}": not found.`, {
                hint: 'Run `motir doctor` to check your agent command and credentials.',
              })
            : new CliError(`Could not launch the agent "${opts.command.binary}": ${err.message}`),
        );
      });

      // An agent that closes stdin early (or never reads it) makes the write
      // fail with EPIPE. That is not an error: the prompt is ALSO on disk at
      // $MOTIR_PROMPT_FILE, which is the whole reason both channels exist.
      const stdin = child.stdin;
      if (stdin) {
        stdin.on('error', () => {});
        stdin.end(opts.prompt);
      }

      child.on('close', (code, signal) => {
        resolve({ exitCode: signal ? 1 : (code ?? 1), signal });
      });
    });
    // Read the self-report BEFORE the `finally` takes the temp dir with it —
    // and read it whatever the exit code was: an agent that reported its model
    // and then failed still ran on that model.
    return { ...result, model: readAgentReport(reportFile) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
