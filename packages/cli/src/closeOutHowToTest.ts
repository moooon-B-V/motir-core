import { info } from './output.js';
import type { AgentRunResult, runAgent } from './agentRun.js';
import type { HowToTestRecord, MotirClient } from './client.js';
import type { ParsedAgentCommand } from './agentProfiles.js';
import { landedWork, type AutoSummary, type RepoSession } from './autoLoop.js';

// The scoped run's HOW TO TEST close-out step (Story MOTIR-4906 · MOTIR-5358).
//
// `docs/decisions/approval-gates.md` §9's 2026-09-13 amendment: HOW TO TEST is
// per RUN, written by an AGENT onto the RUN TARGET before the run finishes. A
// scoped run used to finish in orchestrator code alone — `closeOutRepos` rewrote
// each session pull request and marked it ready with no agent anywhere — so the
// obligation had nowhere to happen. This step puts ONE agent there: it fetches
// the server-assembled close-out prompt (MOTIR-5357), runs it in the run's
// checkouts, and then reads the published record back so `closeOutRepos` can
// render it into every session pull request body.
//
// ⚠️ IT NEVER STRANDS THE RUN. A failed fetch, a non-zero agent, or a refused
// publish is LOGGED with its reason and the run carries on to mark its pull
// requests ready: the item page then shows the honest "no run wrote how to test
// this" naming the run, which is better than finished work stuck in draft.
//
// ⚠️ IT IS RESUME-SAFE. A record already written by THIS run (a re-invoked or
// resumed close-out) is read, not re-produced — the same list-before-create
// shape `openSessionPr` has.

/** What `closeOutRepos` renders into each body: the target, and its record or null. */
export interface HowToTestForBody {
  targetKey: string;
  record: HowToTestRecord | null;
}

export interface CloseOutHowToTestInput {
  client: MotirClient;
  /** The SERVER's id for this run, or null when the reporter never opened one. */
  dispatchRunId: string | null;
  targetKey: string;
  summary: AutoSummary;
  agent: { parsed: ParsedAgentCommand };
  runAgentFn: typeof runAgent;
}

async function readRecord(client: MotirClient, key: string): Promise<HowToTestRecord | null> {
  try {
    return await client.workItemHowToTest(key);
  } catch (err) {
    info(
      `Could not read How to test on ${key}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Where each of the run's checkouts is, appended to the server's prompt. */
export function checkoutsSection(repos: readonly RepoSession[]): string {
  const lines = ['', '════ CHECKOUTS ════', ''];
  for (const repo of repos) {
    lines.push(
      `- ${repo.repoName ?? '(the project repository)'}: ${repo.cwd} — branch ${repo.branch}`,
    );
  }
  return lines.join('\n') + '\n';
}

export async function runCloseOutHowToTest(
  input: CloseOutHowToTestInput,
): Promise<HowToTestForBody> {
  const { client, dispatchRunId, targetKey, summary } = input;
  const done = (record: HowToTestRecord | null): HowToTestForBody => ({ targetKey, record });

  if (!summary.records.some(landedWork)) {
    info(`No work landed — no How to test to write on ${targetKey}.`);
    return done(await readRecord(client, targetKey));
  }
  if (dispatchRunId === null) {
    info(
      `The run was never recorded on the server, so no close-out prompt can be fetched — ` +
        `How to test was not written on ${targetKey}.`,
    );
    return done(await readRecord(client, targetKey));
  }

  const existing = await readRecord(client, targetKey);
  if (existing && existing.dispatchRunId === dispatchRunId) {
    info(`How to test on ${targetKey} was already written by this run — not writing it again.`);
    return done(existing);
  }

  let prompt: string;
  try {
    prompt = (await client.dispatchRunCloseOutPrompt(dispatchRunId)).prompt;
  } catch (err) {
    info(
      `Could not fetch the close-out prompt: ${err instanceof Error ? err.message : String(err)} ` +
        `— How to test was not written on ${targetKey}.`,
    );
    return done(existing);
  }

  const cwd = summary.repos[0]?.cwd ?? process.cwd();
  info(`Writing How to test for this run onto ${targetKey}…`);
  let result: AgentRunResult | null = null;
  try {
    result = await input.runAgentFn({
      command: input.agent.parsed,
      prompt: prompt + checkoutsSection(summary.repos),
      cwd,
    });
  } catch (err) {
    info(`The close-out agent could not run: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (result && result.exitCode !== 0) {
    info(`The close-out agent exited ${result.exitCode}.`);
  }

  const after = await readRecord(client, targetKey);
  if (after && after.dispatchRunId === dispatchRunId) {
    info(`How to test published on ${targetKey}.`);
    return done(after);
  }
  info(`No How to test was published on ${targetKey} by this run — the pull requests say so.`);
  return done(after);
}
