import { splitPlanBody } from '@/lib/markdown/planBody';

// THE REVIEW PROMPT (Story MOTIR-1626 · MOTIR-6821; ADR `docs/decisions/hosted-agent-run.md`
// §8.2–§8.4, `approval-gates.md` §12.3–§12.5) — the brief a hosted REVIEW run is handed.
//
// ⚠️ PURE, like `assembleDispatchPrompt` beside it: a function of its inputs and nothing
// else, so the same gate always yields the same text and the sections a later card adds
// (MOTIR-6904's coding conventions) JOIN the inputs rather than reading anything here.
// `agentReviewRunService.getReviewPrompt` is the half that touches state.
//
// What it says, and why:
//   · THE CARD — both bodies, the acceptance criteria under their own heading, and the
//     published How to test. The reviewer judges the change against what was ASKED, so
//     the card is the brief, not a summary of it.
//   · THE CODE — every pull request of the delivery set at the REVIEWED head, the one the
//     gate's `subjectVersion` names, never a head read later (§8.2). A two-repository card
//     is ONE review over both.
//   · THE LIMITS — read-only: push nothing, post nothing to GitHub (§8.3).
//   · THE ANSWER — ONE verdict, in an exact shape, through the verdict route (§8.4).
//
// ⚠️ IT NAMES NO CONVENTION FILE. Whether a repository has a coding convention, and what
// the reviewer is told about it, is MOTIR-6904's (§8.5): a `CLAUDE.md` or `AGENTS.md`
// named here unconditionally would send a reviewer after a file most repositories lack.

/** The verdicts a review may give (§8.4). */
export const REVIEW_VERDICTS = ['pass', 'changes_requested'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** The summary's bound — a line or two a person reads on the card. */
export const REVIEW_SUMMARY_MAX_LENGTH = 500;
/**
 * The findings' bound. `ApprovalGate.noteMd` is unbounded `text`, so this is the verdict
 * route's own ceiling — generous for a review of any real change, and small enough that a
 * runaway agent cannot write megabytes onto a gate row every surface renders.
 */
export const REVIEW_FINDINGS_MAX_LENGTH = 65_536;

/** One pull request of the delivery set, at the head the review is about. */
export interface ReviewPullRequestForPrompt {
  /** `owner/name`. */
  repository: string;
  number: number;
  /** The REVIEWED head — from the gate's `subjectVersion`, never a later read. */
  headSha: string;
  /** The pull request's base branch, when Motir knows it. */
  baseBranch: string | null;
  /** Its head branch, when Motir knows it. */
  headBranch: string | null;
  title: string | null;
  url: string;
}

export interface ReviewPromptInput {
  key: string;
  title: string;
  projectName: string;
  descriptionMd: string | null;
  explanationMd: string | null;
  /** The CURRENT How to test's body, or null when none is published. */
  howToTestMd: string | null;
  /** The gate's `subjectVersion` — echoed into the verdict so a late one is detectable. */
  subjectVersion: string;
  /** The delivery set at the reviewed head, in the set's canonical order. */
  pullRequests: readonly ReviewPullRequestForPrompt[];
  /**
   * ── THE INSERTION POINT FOR MOTIR-6904 — the per-repository CODING CONVENTION block. ──
   *
   * Rendered VERBATIM after the pull requests when present, and nothing when absent. This
   * card never fills it: the service passes nothing. MOTIR-6904 assembles the block (one
   * repository's derived convention each, capped; none, not configured or unreachable ⇒
   * that repository is reviewed against the card alone) and passes it here, so this
   * assembler stays pure and owns no convention wording.
   */
  conventionSection?: string | null;
}

export interface AssembledReviewPrompt {
  prompt: string;
}

const RULE = '─'.repeat(72);

function section(title: string, lines: readonly string[]): string[] {
  return ['', title, '', ...lines];
}

function indent(md: string): string[] {
  return md.split('\n').map((line) => (line.length > 0 ? `  ${line}` : ''));
}

function pullRequestLines(pr: ReviewPullRequestForPrompt): string[] {
  const base = pr.baseBranch ?? '<its base branch>';
  return [
    `  - ${pr.repository} #${pr.number}${pr.title ? ` — ${pr.title}` : ''}`,
    `      ${pr.url}`,
    `      reviewed head: ${pr.headSha}`,
    `      base: ${base}${pr.headBranch ? ` · branch: ${pr.headBranch}` : ''}`,
    `      the change:    git fetch origin ${base} ${pr.headSha} && git diff origin/${base}...${pr.headSha}`,
  ];
}

/**
 * Assemble the review prompt. Deterministic: the same input gives byte-identical text.
 */
export function assembleReviewPrompt(input: ReviewPromptInput): AssembledReviewPrompt {
  const { body, acceptanceCriteria } = splitPlanBody(input.descriptionMd);
  const multi = input.pullRequests.length > 1;

  const lines: string[] = [
    `You are REVIEWING the delivered code of ${input.key} — "${input.title}" (${input.projectName}).`,
    '',
    'Motir asks you one question: is this code right for THIS card? Judge the change against',
    'what the card asked for — its description, its acceptance criteria and its How to test —',
    'not against what you would have built. You decide it alone, and your verdict is recorded',
    'as the review agent’s, before any person is asked to approve the merge.',
    RULE,
    ...section('THE CARD', [
      `  ${input.key} — ${input.title}`,
      '',
      ...(body ? indent(body) : ['  (The card has no description.)']),
    ]),
    ...section(
      'ACCEPTANCE CRITERIA',
      acceptanceCriteria.length > 0
        ? acceptanceCriteria.map((line) => `  ${line}`)
        : ['  (The card names none. Review against its description and How to test.)'],
    ),
    ...section(
      'WHY IT MATTERS (the card’s explanation)',
      input.explanationMd?.trim() ? indent(input.explanationMd.trim()) : ['  (None written.)'],
    ),
    ...section(
      'HOW TO TEST (as published for this card)',
      input.howToTestMd?.trim()
        ? indent(input.howToTestMd.trim())
        : ['  (None is published yet. Do not treat its absence as a finding.)'],
    ),
    ...section(
      multi
        ? `THE CODE — ${input.pullRequests.length} pull requests, ONE review over all of them`
        : 'THE CODE — one pull request',
      [
        '  Review each pull request at its REVIEWED head below — never a later commit. If the',
        '  branch has moved on, that is not yours to review: review the head named here.',
        '',
        ...input.pullRequests.flatMap(pullRequestLines),
      ],
    ),
    // ── MOTIR-6904's CODING CONVENTION block joins here (see `conventionSection`). ──
    ...(input.conventionSection?.trim() ? ['', input.conventionSection.trim()] : []),
    ...section('HOW TO REVIEW', [
      '  - Read the whole diff of every pull request above, and enough of the surrounding',
      '    code to judge it.',
      '  - Check it against EACH acceptance criterion: is it met, and is it tested?',
      '  - Look for defects the change introduces: wrong behaviour, a missed case the card',
      '    names, broken error handling, a security hole, a regression in code it touches.',
      '  - Report what must change for the card to be right. Style preferences that no',
      '    criterion or written standard asks for are not findings.',
      '  - If a finding relies on a written standard, QUOTE the rule it breaks.',
    ]),
    ...section('YOU ARE READ-ONLY', [
      '  - Push NOTHING. Do not commit, amend, rebase or push to any branch.',
      '  - Post NOTHING to GitHub — no review, no comment, no check, no label.',
      '  - Change no status and write nothing else in Motir. Your verdict is your only output.',
    ]),
    ...section('YOUR VERDICT — submit exactly ONE', [
      `  POST /api/v1/work-items/${input.key}/agent-review`,
      '',
      '  {',
      `    "subjectVersion": "${input.subjectVersion}",`,
      '    "verdict": "pass" | "changes_requested",',
      `    "summaryMd": "<at most ${REVIEW_SUMMARY_MAX_LENGTH} characters: what you concluded>",`,
      '    "findingsMd": "<Markdown findings>"',
      '  }',
      '',
      '  - `subjectVersion` is EXACTLY the string above: the version you reviewed.',
      '  - `pass` — the code meets the card. `findingsMd` is optional (minor notes only).',
      '  - `changes_requested` — something must change. `findingsMd` is REQUIRED: one',
      '    finding per item, each naming the FILE and LINE, the criterion (or quoted rule)',
      '    it breaks, and WHAT TO CHANGE.',
      '  - One verdict per review. A second is refused. If the code moved while you were',
      '    reviewing, your verdict is recorded and decides nothing — that is expected.',
    ]),
  ];

  return { prompt: `${lines.join('\n')}\n` };
}
