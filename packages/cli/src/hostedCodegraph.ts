import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

// A HOSTED RUN'S CODE GRAPH, per checkout (Story MOTIR-683 · MOTIR-6560).
//
// MOVED from the hosted image's old one-repository entrypoint, which indexed
// its single clone before starting OpenCode. Under
// `docs/decisions/hosted-run-runs-the-cli-as-the-app.md` §1 the CLI clones the
// checkouts itself — every repository a leg ships in, and for a parent every
// leg in turn — so the launcher cannot index them before `motir run` starts.
// The step therefore runs HERE, once per checkout, after it is materialized and
// before the agent is spawned on it.
//
// ⚠️ BEST-EFFORT, AS IT ALWAYS WAS. An agent without a code map is slower, not
// wrong: a missing `codegraph`, a failed `init` or a failed MCP registration is
// reported through `note` and the run carries on.
//
// ⚠️ THE INDEX NEVER REACHES A COMMIT. It lives in the checkout (`.codegraph/`),
// so the checkout's own `info/exclude` names it — the pull request carries the
// agent's work and nothing the container made to support it.

const HOOK_MARKER = 'motir-hosted-agent codegraph sync hook';
const EXCLUDE_LINE = '.codegraph/';

type Spawn = (
  command: string,
  args: string[],
  options: { cwd: string; encoding: 'utf8'; env: NodeJS.ProcessEnv },
) => SpawnSyncReturns<string>;

export interface HostedCodegraphDeps {
  spawn?: Spawn;
  env?: NodeJS.ProcessEnv;
}

/** Checkouts already prepared in this process — a parent's legs share them. */
const prepared = new Set<string>();
/** The OpenCode MCP registration is global, so it is made once per process. */
let registered = false;

/** Forget what this process prepared. Tests only. */
export function resetHostedCodegraph(): void {
  prepared.clear();
  registered = false;
}

function hookBody(): string {
  return [
    '#!/bin/sh',
    `# ${HOOK_MARKER}`,
    'command -v codegraph >/dev/null 2>&1 || exit 0',
    'root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0',
    '[ -d "$root/.codegraph" ] && codegraph sync --quiet "$root" >/dev/null 2>&1',
    'exit 0',
    '',
  ].join('\n');
}

/** Name `.codegraph/` in the checkout's own exclude file, once. */
function excludeIndex(repoDir: string): void {
  const exclude = join(repoDir, '.git', 'info', 'exclude');
  mkdirSync(dirname(exclude), { recursive: true });
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (current.split('\n').some((line) => line.trim() === EXCLUDE_LINE)) return;
  appendFileSync(
    exclude,
    `${current.endsWith('\n') || current === '' ? '' : '\n'}${EXCLUDE_LINE}\n`,
  );
}

/** Keep the index fresh as the branch moves — without replacing a hook we did not write. */
function installHooks(repoDir: string): void {
  const hooks = join(repoDir, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  for (const hook of ['post-merge', 'post-checkout']) {
    const path = join(hooks, hook);
    if (existsSync(path) && !readFileSync(path, 'utf8').includes(HOOK_MARKER)) continue;
    writeFileSync(path, hookBody());
    chmodSync(path, 0o755);
  }
}

function failure(res: SpawnSyncReturns<string>): string | null {
  if (res.error) return res.error.message;
  if (res.status !== 0)
    return (res.stderr || res.stdout || `exit ${res.status}`).trim().slice(-500);
  return null;
}

/**
 * Index every checkout a hosted leg is about to be worked in, and give OpenCode
 * the codegraph MCP server. A checkout that is not a git repository (nothing
 * was cloned there) is skipped — the leg's own materialize step reports that.
 */
export function prepareHostedCheckouts(
  dirs: readonly string[],
  note: (line: string) => void,
  deps: HostedCodegraphDeps = {},
): void {
  const run = deps.spawn ?? (spawnSync as unknown as Spawn);
  const env = { ...(deps.env ?? process.env), CODEGRAPH_TELEMETRY: '0' };
  for (const dir of dirs) {
    if (prepared.has(dir) || !existsSync(join(dir, '.git'))) continue;
    prepared.add(dir);
    excludeIndex(dir);
    if (!existsSync(join(dir, '.codegraph'))) {
      const why = failure(run('codegraph', ['init', dir], { cwd: dir, encoding: 'utf8', env }));
      if (why !== null) {
        note(
          `codegraph init failed on ${dir} — the agent works there without a code graph (${why})`,
        );
        continue;
      }
    }
    installHooks(dir);
    if (!registered) {
      const why = failure(
        run('codegraph', ['install', '--target', 'opencode', '--location', 'global', '--yes'], {
          cwd: dir,
          encoding: 'utf8',
          env,
        }),
      );
      if (why === null) registered = true;
      else note(`could not register the codegraph MCP server with OpenCode (${why})`);
    }
  }
}
