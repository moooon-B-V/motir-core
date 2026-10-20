// WHICH CONVERSATION a repair in the person's own agent continues (Story MOTIR-8981 ·
// MOTIR-9052). The server records, in the `fix` run's `run_opened`, the profile and the
// session of the card's last agent run (`repair.resume`); this decides what to launch.
//
// ⚠️ A resume is an ATTEMPT, never a requirement. The id is a claim about another
// process's state — expired, pruned, or from a different checkout — so a resumed first
// turn that exits non-zero is retried ONCE as a fresh agent, and says so.
import type { ParsedAgentCommand } from './agentProfiles.js';
import { agentModeAgent, resumeFixAgent } from './commands/dispatch.js';
import type { DispatchRunRepair } from './client.js';

type AgentRunner<R> = (input: {
  command: ParsedAgentCommand;
  prompt: string;
  cwd: string;
}) => Promise<R>;

export interface RepairAgentChoice {
  /** The command the first turn launches — the resumed one when a resume was built. */
  parsed: ParsedAgentCommand;
  /** The fresh command a failed resume falls back to; null when nothing was resumed. */
  fresh: ParsedAgentCommand | null;
  /** The ONE line printed before the first turn. */
  line: string;
}

export function chooseRepairAgent(
  key: string,
  resume: DispatchRunRepair['resume'],
  env: NodeJS.ProcessEnv,
): RepairAgentChoice {
  const base = agentModeAgent(env);
  const profile = base.stream?.profile ?? null;
  if (!resume) {
    return {
      parsed: base,
      fresh: null,
      line: `${key}: no earlier agent run to resume — starting a fresh agent.`,
    };
  }
  if (resume.profile !== profile) {
    return {
      parsed: base,
      fresh: null,
      line: `${key}: the last run was in ${resume.profile}, this agent is ${profile ?? 'another'} — starting a fresh agent.`,
    };
  }
  if (!resume.canResume || !resume.sessionId) {
    return {
      parsed: base,
      fresh: null,
      line: `${key}: the last ${resume.profile} run recorded no session to resume — starting a fresh agent.`,
    };
  }
  const resumed = resumeFixAgent(base, resume.sessionId, env);
  if (!resumed) {
    return {
      parsed: base,
      fresh: null,
      line: `${key}: ${resume.profile} cannot resume a session here — starting a fresh agent.`,
    };
  }
  return {
    parsed: resumed,
    fresh: base,
    line: `${key}: resuming the ${resume.profile} session from the last run.`,
  };
}

/**
 * The runner with the one-shot fallback: the FIRST launch of the resumed command that
 * exits non-zero is re-run with the fresh command, on the same prompt and checkout.
 */
export function withFreshFallback<R extends { exitCode: number | null }>(
  runAgent: AgentRunner<R>,
  choice: RepairAgentChoice,
  say: (line: string) => void,
): AgentRunner<R> {
  const { parsed: resumed, fresh } = choice;
  if (!fresh) return runAgent;
  let spent = false;
  return async (input) => {
    const result = await runAgent(input);
    if (spent || input.command !== resumed || result.exitCode === 0) return result;
    spent = true;
    say(
      `${resumed.stream?.profile ?? 'The agent'} could not resume that session — starting a fresh agent.`,
    );
    return runAgent({ ...input, command: fresh });
  };
}
