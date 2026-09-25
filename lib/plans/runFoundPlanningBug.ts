// =================================================================
// THE RUN-FOUND PLANNING BUG's COMPOSITION (Story MOTIR-5544 · Subtask
// MOTIR-6283) — turns what the run-found report knows into a bug TITLE and
// BODY, and does nothing else: no database, no filing, no permission.
//
// `docs/decisions/run-found-trigger-dispatched-path.md`, *Which plan, and where
// the bug lands*, is the record. A planning bug is filed into MOTIR's own
// planner-bug home whatever tenant the run was in, because a defect in Motir's
// planner is Motir's defect. That is the one moment in the feature where
// something crosses from a customer's workspace into ours, so the record fixes
// WHAT crosses in advance:
//
//   * `motir_workspace` — the caller's workspace IS the system principal's.
//     Nothing needs protecting, so the bug carries everything VERBATIM.
//   * `customer_workspace` — the bug carries ONLY ids, enums, timestamps and
//     field names: no titles, no card keys, no runner text. The runner's reason
//     and the plan title stay on the leg's `unbuildable_reported` event in the
//     customer's own tenant, addressed by workspace id and leg id.
//
// ⚠️ THE CUSTOMER BRANCH IS A CONSTRUCTION, NOT A REDACTION. It never sees the
// input: `composeRunFoundPlanningBug` first PROJECTS the input onto
// {@link RunFoundBugPointer} — a type with no `reason`, `key` or title field —
// and the customer renderer takes only that pointer. There is no scrubbing, no
// heuristic and no LLM: a leaked title reads exactly like a useful bug, so the
// only safe sanitiser is one that cannot reach the text at all.
//
// Which regime applies, and whether to file at all, are the CALLER's decisions
// (the report service, MOTIR-6285). This module composes whatever it is given —
// a `no_plan`-shaped input included.
// =================================================================

import type {
  ApprovedShapeVerdictDto,
  PlanAuthorSourceDto,
  WorkItemApprovedShapeVerdictDto,
} from '@/lib/dto/plans';

/** Which sanitising regime the bug is composed under — the caller decides. */
export type RunFoundBugRegime = 'motir_workspace' | 'customer_workspace';

/** Everything the report service knows when it composes the bug. */
export interface RunFoundBugInput {
  /** The CALLER's workspace — the tenant the run was in. */
  workspaceId: string;
  projectId: string;
  /** The run target. */
  workItemId: string;
  /** The target's `KEY-<n>` — free text in the customer's namespace. */
  key: string;
  /** The runner's stated reason, verbatim — free text. */
  reason: string;
  /** The verdict against the last approved plan that shaped the target. */
  verdict: WorkItemApprovedShapeVerdictDto;
  /** The approving plan; null when there is none (`no_plan`). */
  plan: {
    id: string;
    /** Free text. */
    title: string;
    authorSource: PlanAuthorSourceDto | null;
    authorHarness: string | null;
    authorModel: string | null;
  } | null;
  dispatchRunId: string;
  /** The leg (`DispatchRunCard`) the report was made on. */
  dispatchRunCardId: string;
  /** ISO timestamp of the report. */
  reportedAt: string;
}

/**
 * THE ALLOWLIST — the only shape the customer branch can render. Ids, enums,
 * timestamps and field names; deliberately NO `reason`, `key` or title field,
 * so reading one is a compile error rather than a review finding.
 */
export interface RunFoundBugPointer {
  workspaceId: string;
  projectId: string;
  workItemId: string;
  dispatchRunId: string;
  dispatchRunCardId: string;
  planId: string | null;
  proposalId: string | null;
  verdict: ApprovedShapeVerdictDto;
  divergingRevision: { id: string; changeKind: string; changedKeys: string[] } | null;
  childSet: { added: string[]; removed: string[] } | null;
  /** Server-written, never taken from a caller. */
  authorSource: PlanAuthorSourceDto | null;
  authorHarness: string | null;
  authorModel: string | null;
  decidedAt: string | null;
  reportedAt: string;
}

/** The title's fixed stem, shared by both regimes. */
export const RUN_FOUND_BUG_TITLE_STEM =
  "Planning bug (run-found): an approved plan's card was unbuildable, unchanged since approval";

/**
 * PROJECT the input onto the allowlist. Every field is named; nothing is
 * spread, so a field added to {@link RunFoundBugInput} never reaches the
 * pointer by accident.
 */
export function toRunFoundBugPointer(input: RunFoundBugInput): RunFoundBugPointer {
  const { verdict } = input;
  return {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    workItemId: input.workItemId,
    dispatchRunId: input.dispatchRunId,
    dispatchRunCardId: input.dispatchRunCardId,
    planId: input.plan?.id ?? verdict.planId,
    proposalId: verdict.proposalId,
    verdict: verdict.verdict,
    divergingRevision: verdict.divergingRevision
      ? {
          id: verdict.divergingRevision.id,
          changeKind: verdict.divergingRevision.changeKind,
          changedKeys: [...verdict.divergingRevision.changedKeys],
        }
      : null,
    childSet: verdict.childSet
      ? { added: [...verdict.childSet.added], removed: [...verdict.childSet.removed] }
      : null,
    authorSource: input.plan?.authorSource ?? null,
    authorHarness: input.plan?.authorHarness ?? null,
    authorModel: input.plan?.authorModel ?? null,
    decidedAt: verdict.decidedAt,
    reportedAt: input.reportedAt,
  };
}

/** An inline code span, or `none` for an absent value. */
function code(value: string | null): string {
  return value === null ? '_none_' : `\`${value}\``;
}

function codeList(values: readonly string[]): string {
  return values.length === 0 ? '_none_' : values.map((v) => `\`${v}\``).join(', ');
}

/**
 * A fenced block that carries `text` BYTE-FOR-BYTE: the fence is longer than
 * any backtick run inside it, so no content can close it early.
 */
function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/** The facts BOTH regimes carry — rendered from the pointer alone. */
function pointerFacts(p: RunFoundBugPointer): string[] {
  const lines = [
    `- **Verdict:** ${code(p.verdict)}`,
    `- **Approving plan id:** ${code(p.planId)}`,
    `- **Shaping proposal id:** ${code(p.proposalId)}`,
    `- **Plan decided at:** ${code(p.decidedAt)}`,
    `- **Plan author:** source ${code(p.authorSource)} · harness ${code(p.authorHarness)} · model ${code(p.authorModel)}`,
    `- **Target work item id:** ${code(p.workItemId)}`,
    `- **Workspace id:** ${code(p.workspaceId)}`,
    `- **Project id:** ${code(p.projectId)}`,
    `- **Dispatch run id:** ${code(p.dispatchRunId)}`,
    `- **Dispatch leg id:** ${code(p.dispatchRunCardId)}`,
    `- **Reported at:** ${code(p.reportedAt)}`,
  ];
  if (p.divergingRevision) {
    lines.push(
      `- **Diverging revision:** ${code(p.divergingRevision.id)} · change kind ${code(p.divergingRevision.changeKind)} · changed keys ${codeList(p.divergingRevision.changedKeys)}`,
    );
  }
  if (p.childSet) {
    lines.push(
      `- **Child set:** added ${codeList(p.childSet.added)} · removed ${codeList(p.childSet.removed)}`,
    );
  }
  return lines;
}

/** The CUSTOMER regime — the pointer is all it can see. */
function composeCustomer(p: RunFoundBugPointer): { title: string; descriptionMd: string } {
  const descriptionMd = [
    "A dispatched run in a **customer workspace** stopped because its target was unbuildable, and the target was still what Motir's planner approved.",
    '## Pointer',
    pointerFacts(p).join('\n'),
    '## Where the evidence is',
    `The runner's reason and the plan title stay in the customer's tenant, on the \`unbuildable_reported\` event of dispatch leg ${code(p.dispatchRunCardId)} in workspace ${code(p.workspaceId)}. They are read there, under that tenant's own access rules, and are deliberately not copied here.`,
  ].join('\n\n');
  return { title: `${RUN_FOUND_BUG_TITLE_STEM} — leg ${p.dispatchRunCardId}`, descriptionMd };
}

/** MOTIR's OWN workspace — everything verbatim. */
function composeMotir(input: RunFoundBugInput): { title: string; descriptionMd: string } {
  const planTitle = input.plan?.title ?? input.verdict.planTitle;
  const descriptionMd = [
    `A dispatched run stopped because its target **${input.key}** was unbuildable, and the target was still what Motir's planner approved.`,
    '## Run target',
    [`- **Key:** ${input.key}`, `- **Plan title:** ${planTitle ?? '_none_'}`].join('\n'),
    '## Why the runner could not run it',
    fenced(input.reason),
    '## Facts',
    pointerFacts(toRunFoundBugPointer(input)).join('\n'),
  ].join('\n\n');
  return { title: `${RUN_FOUND_BUG_TITLE_STEM} — ${input.key}`, descriptionMd };
}

/**
 * Compose the run-found planning bug's title and body under `regime`. Pure: the
 * same input and regime always give the same text, and nothing is read or
 * written.
 */
export function composeRunFoundPlanningBug(
  input: RunFoundBugInput,
  regime: RunFoundBugRegime,
): { title: string; descriptionMd: string } {
  if (regime === 'customer_workspace') return composeCustomer(toRunFoundBugPointer(input));
  return composeMotir(input);
}
