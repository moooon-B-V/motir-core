// The RUN CLOSE-OUT prompt (Story MOTIR-4906 · Subtask MOTIR-5357) — PURE.
//
// `docs/decisions/approval-gates.md` §9's 2026-09-13 amendment makes HOW TO TEST
// the deliverable of a RUN, written onto the RUN TARGET before the run finishes.
// A scoped CLI run finishes in orchestrator code (`packages/cli` `closeOutRepos`
// → `markSessionPrReady`) in which NO agent runs, and every per-card agent saw one
// child of the target, never the whole. This prompt is what puts one agent at
// that moment: it sees every card the run landed, reads what landed on each
// session branch, and publishes ONE record on the target.
//
// ⚠️ THE ACTOR IS A SANDBOXED AGENT holding the CLI token — never the
// orchestrator. `publish_test_instructions` asserts `work_item:edit`, which
// `CLI_TOKEN_GRANT` already carries, so nothing here widens a grant.
//
// Pure (no I/O) so every sentence the agent is held to is assertable without a
// database; `dispatchRunService.getCloseOutPrompt` supplies the input.

import { HOW_TO_TEST_TOOL_NAME, RENDERED_SURFACE_TRIGGER } from '@/lib/dispatch/promptTemplate';

/** One card the run LANDED (integrated or implemented). */
export interface CloseOutCard {
  key: string;
  title: string;
  type: string | null;
  /** The session branch its work was integrated onto, when recorded. */
  sessionBranch: string | null;
}

export interface CloseOutPromptSource {
  runId: string;
  target: { key: string; kind: string; title: string; descriptionMd: string | null };
  /** In the run's own order. */
  cards: readonly CloseOutCard[];
}

const RULE = '═'.repeat(60);

function section(title: string, body: string[]): string[] {
  return [RULE, title, RULE, '', ...body, ''];
}

export function assembleRunCloseOutPrompt(src: CloseOutPromptSource): string {
  const branches = [
    ...new Set(src.cards.map((c) => c.sessionBranch).filter((b): b is string => b !== null)),
  ];
  const lines = [
    ...section('YOUR TASK', [
      `The run ${src.runId} was launched against ${src.target.key} and has landed its work.`,
      `Before its pull requests are marked ready, write HOW TO TEST for the WHOLE run onto`,
      `${src.target.key} — once. You are the only agent that sees every card the run landed;`,
      'each card’s own agent saw one child and was told not to publish.',
    ]),
    ...section('THE RUN TARGET', [
      `- ${src.target.key} (${src.target.kind}): ${src.target.title}`,
      '',
      ...(src.target.descriptionMd?.trim()
        ? src.target.descriptionMd.trim().split('\n')
        : ['(no description)']),
    ]),
    ...section('WHAT THE RUN LANDED', [
      ...(src.cards.length > 0
        ? src.cards.map(
            (c) =>
              `- ${c.key} [${c.type ?? 'untyped'}] ${c.title}` +
              (c.sessionBranch ? ` — on ${c.sessionBranch}` : ''),
          )
        : ['- (no card landed)']),
      '',
      branches.length > 0
        ? `Session branches: ${branches.join(', ')}.`
        : 'No session branch was recorded for these cards.',
    ]),
    ...section('HOW', [
      '1. For each repository the run pushed to, read what landed: in its checkout,',
      '   `git log --oneline origin/<default>..<session branch>` and the diff over the',
      '   same range. Note the branch head commit you read.',
      `2. Call the ${HOW_TO_TEST_TOOL_NAME} tool ONCE, with key ${src.target.key}:`,
      '   - "repos": one entry per repository the run pushed to — the repository, its',
      '     session branch head as commitSha, and the setup commands a reviewer runs',
      '     after checking out that branch (install, migrate, seed, run). Motir fills',
      '     in the branch fetch itself — do not include it.',
      '   - "preconditionMd": the sign-in, role, or data the changed surface needs.',
      `   - If any card in this run ${RENDERED_SURFACE_TRIGGER},`,
      '     give ONE click-path for the run as a whole in "clickPathSteps", with a',
      '     "previewPath" when there is one. Otherwise pass "clickPathNotApplicable"',
      '     with the reason, e.g. "no rendered surface changed: a service and its tests".',
      '3. Report in one line what you published, or the refusal you got.',
    ]),
    ...section('DO NOT', [
      '- commit, push, or open, edit or mark ready any pull request — the run does that',
      '  after you exit, and renders what you published into each pull request body;',
      '- transition any work item’s status;',
      '- publish more than once, or on any key other than ' + `${src.target.key}.`,
      '',
      'If the publish is refused, report the refusal and exit. The run still finishes;',
      `${src.target.key} then shows that no run wrote how to test it, naming this run.`,
    ]),
  ];
  return lines.join('\n') + '\n';
}
