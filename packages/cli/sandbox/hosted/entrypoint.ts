// The HOSTED AGENT's entrypoint — a LAUNCHER for the Motir CLI (Story MOTIR-683 ·
// MOTIR-687, reduced by MOTIR-6560).
//
// `docs/decisions/hosted-run-runs-the-cli-as-the-app.md` §1: a hosted run is the
// CLI's own `motir run` (or `motir continue`), executed in this container. So a
// leaf, a leaf that spans several repositories and a parent worked through its
// children all run exactly as they do on a laptop — the prompt, the clones, the
// code graph, OpenCode on the gateway key, the pushes, the pull requests, the
// events and the run's close are ALL the CLI's (`motir run --help`,
// `packages/cli/src/hostedMode.ts`, `hostedAgent.ts`, `hostedGit.ts`,
// `hostedCodegraph.ts`).
//
// What is left here is what only the container knows:
//
//   1. read and validate the run's inputs, naming every missing one at once;
//   2. exec `motir run <KEY>` in hosted mode on the run the server opened
//      (`MOTIR_DISPATCH_RUN_ID`), passing the environment through untouched;
//   3. forward the container's stop signal, and exit with the CLI's own code.
//
// It runs with Node's own type stripping and imports nothing but `node:`
// builtins, so the image carries no build step of its own.
//
// ⚠️ IT READS NO REPOSITORY AND NO GIT CREDENTIAL. The run's repositories come
// from the server (a run's legs' repository set), and GitHub is reached only
// through the CLI's credential helper on the run's git-credential route — no git
// token is ever in this container's environment (decision §5).

import { spawn } from 'node:child_process';

/** The exit code for a launch that never reached the CLI. */
export const SETUP_FAILED = 20;

/** Every input the launcher refuses to start without. */
export const REQUIRED_INPUTS = [
  'MOTIR_DISPATCH_RUN_ID',
  'MOTIR_WORK_ITEM_KEY',
  'MOTIR_API_URL',
  'MOTIR_RUN_TOKEN',
  'MOTIR_GATEWAY_URL',
  'MOTIR_RUN_KEY',
  'MOTIR_MODEL',
] as const;

/** `run` starts a card; `continue` resumes a dead run on its branch (the run-dies story). */
export type RunMode = 'run' | 'continue';

export interface Launch {
  mode: RunMode;
  key: string;
}

/** Read and validate the inputs; throws with EVERY problem named at once. */
export function readLaunch(env: NodeJS.ProcessEnv): Launch {
  const problems: string[] = [];
  const missing = REQUIRED_INPUTS.filter((name) => !env[name]?.trim());
  if (missing.length > 0) problems.push(`missing required input(s): ${missing.join(', ')}`);
  const key = env.MOTIR_WORK_ITEM_KEY?.trim() ?? '';
  if (key && !/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(key)) {
    problems.push(`MOTIR_WORK_ITEM_KEY must be a work item key (PROJECT-n), got "${key}"`);
  }
  const rawMode = env.MOTIR_RUN_MODE?.trim() || 'run';
  if (rawMode !== 'run' && rawMode !== 'continue') {
    problems.push(`MOTIR_RUN_MODE must be "run" or "continue", got "${rawMode}"`);
  }
  if (problems.length > 0) throw new Error(problems.join('; '));
  return { mode: rawMode as RunMode, key };
}

/**
 * The CLI command line for a launch. `continue` is named here so the launcher
 * is ready for it; the CLI answers for whether that command exists yet.
 */
export function cliArgs(launch: Launch): string[] {
  return [launch.mode, launch.key];
}

async function main(): Promise<number> {
  let launch: Launch;
  try {
    launch = readLaunch(process.env);
  } catch (err) {
    // Nothing to report to: without the run id, the API URL and the run token
    // there is no ingest to address. The container log is the record.
    process.stderr.write(`motir-hosted-agent: ${(err as Error).message}\n`);
    return SETUP_FAILED;
  }
  const bin = process.env.MOTIR_CLI_BIN?.trim() || 'motir';
  process.stderr.write(
    `motir-hosted-agent: ${bin} ${cliArgs(launch).join(' ')} (run ${process.env.MOTIR_DISPATCH_RUN_ID})\n`,
  );
  return await new Promise<number>((resolve) => {
    const child = spawn(bin, cliArgs(launch), { env: process.env, stdio: 'inherit' });
    // The fleet stops a container with SIGTERM; the CLI must hear it, so the
    // run it holds is closed by the CLI rather than cut off mid-write.
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    const onTerm = forward('SIGTERM');
    const onInt = forward('SIGINT');
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);
    child.on('error', (err) => {
      process.stderr.write(`motir-hosted-agent: could not start ${bin}: ${err.message}\n`);
      resolve(SETUP_FAILED);
    });
    child.on('close', (code, signal) => {
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onInt);
      // A CLI killed by a signal has no code of its own: 128 + n, as a shell says.
      resolve(code ?? (signal === 'SIGKILL' ? 137 : 143));
    });
  });
}

// Run only as the program, never when a test imports the helpers above.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = await main();
}
