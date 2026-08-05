import type { DispatchWorkflowMode } from '@/lib/dto/dispatch';
import { isManualReadyItem } from '@/lib/dto/ready';
import { isOrderingAdvisory, isRepoStraddleAdvisory } from '@/lib/dto/workItems';
import type {
  ExecutorDto,
  WorkItemKindDto,
  WorkItemPriorityDto,
  WorkItemProseAdvisoryDto,
  WorkItemTypeDto,
} from '@/lib/dto/workItems';
import { splitPlanBody } from '@/lib/markdown/planBody';

// The canonical DISPATCH-PROMPT grammar (Story 7.9 · MOTIR-1802) — the
// open-core, deterministic rebuild of the cancelled 7.7.2 `generate_prompt` job.
//
// PURE: a function of its input record only. No DB, no I/O, no LLM call, no
// clock, no randomness — which is exactly the property the consumer (MOTIR-881,
// `motir next --print`) tests for ("two calls for an unchanged item return
// byte-identical output"). The SERVICE reads state and calls this; this module
// never reads anything.
//
// The four sections (CONTEXT / WHAT TO DO / ACCEPTANCE CRITERIA / GIT WORKFLOW)
// productize the grammar `motir-meta/prompts/run.md` § *Prompt structure* has
// been applying by hand. Three shapes vary, and all three are decided HERE, from
// server state, never by the caller:
//
//   1. WHAT TO DO varies by the item's `type` (code / design / test / decision /
//      …) — a design card is told to produce a design asset, not code.
//   2. A MANUAL item (`type: manual` or `executor: human`) gets the
//      human-INSTRUCTION form and NO `GIT WORKFLOW` section at all: there is no
//      branch, no PR, and telling a person to open one is noise.
//   3. GIT WORKFLOW varies by session lineage — see {@link DispatchWorkflowMode}.
//
// EXTENSION POINT — `injections` (see {@link DispatchPromptInjections}). The two
// enrichment cards that were left waiting on the cancelled assembly point
// (MOTIR-927, the project convention; MOTIR-1191, `coding`-type lessons) fill
// those named slots and nothing else. They are EMPTY here by design: both are
// Epic 9 / motir-ai work and building them in this repo would straddle the
// open-core boundary. See docs/decisions/dispatch-prompt-assembly.md.

/** The rule bar every section heading sits between. */
const RULE = '═'.repeat(60);

/**
 * Named slots the Epic-9 enrichment cards fill — the ONE extension point this
 * assembly exposes. Each is a list of already-rendered Markdown blocks appended
 * to the CONTEXT section in a fixed order; empty (the only value this repo ever
 * supplies) renders nothing at all, so the prompt is unchanged until the
 * injecting card ships.
 */
export interface DispatchPromptInjections {
  /**
   * The project's STANDARD convention — the productized `CLAUDE.md` (MOTIR-927).
   * Blocked under Story 9.1 pending exactly this seam.
   */
  conventions: string[];
  /**
   * Retrieved `coding`-type lessons relevant to this item (MOTIR-1191), so a
   * known past mistake is never repeated. Blocked under Story 9.1 likewise.
   */
  lessons: string[];
}

/** The no-op injection set — what `motir-core` alone can supply today. */
export const NO_INJECTIONS: DispatchPromptInjections = { conventions: [], lessons: [] };

/** Everything the prompt is assembled from. Resolved by the service; the
 *  assembly reads nothing else. */
export interface DispatchPromptSource {
  /** The `PROD-<n>` identifier. */
  key: string;
  title: string;
  kind: WorkItemKindDto;
  type: WorkItemTypeDto | null;
  executor: ExecutorDto | null;
  priority: WorkItemPriorityDto;
  storyPoints: number | null;
  estimateMinutes: number | null;
  /** The raw Markdown body — partitioned here into narrative / acceptance
   *  criteria / context refs (`splitPlanBody`). */
  descriptionMd: string | null;
  /** The `PROD-<n>` keys of this item's `is_blocked_by` dependencies. */
  blockerKeys: string[];
  parent: { key: string; title: string } | null;
  projectName: string;
  /** The project key, e.g. `PROD` — the identifier prefix. */
  projectKey: string;
  /** The RESOLVED target repo (MOTIR-1804), or null when Motir cannot say. */
  targetRepo: string | null;
  /** The inherited session branch, or null for the per-item-PR workflow. */
  sessionBranch: string | null;
  /**
   * The `likely-missing-edge` PROSE-vs-GRAPH advisories for this item
   * (MOTIR-2079) — items the card's ACCEPTANCE CRITERIA name but that it carries
   * no `blocked_by` edge to. Omitted or empty renders NOTHING (no empty
   * heading), which is the shape almost every card has.
   *
   * ⚠️ NOT a blocker and not a reason to refuse: it is told to the agent so the
   * agent can VERIFY before it branches. See {@link advisorySection}.
   */
  advisories?: WorkItemProseAdvisoryDto[];
  /** The Epic-9 enrichment slots; defaults to {@link NO_INJECTIONS}. */
  injections?: DispatchPromptInjections;
}

/** The assembled prompt plus the workflow variant it ended up carrying. */
export interface AssembledDispatchPrompt {
  prompt: string;
  workflowMode: DispatchWorkflowMode;
  /**
   * The session branch the prompt actually INSTRUCTS — the inherited branch in
   * `session_lineage` mode, else `null`. A MANUAL item is always `null` even when
   * it inherits a lineage: it has no branch and no pull request, so reporting one
   * would tell the CLI to route human work onto a git lineage it will never touch.
   */
  sessionBranch: string | null;
}

/**
 * The per-`type` WHAT-TO-DO steps. TOTAL over `WorkItemTypeDto` by construction
 * (`Record<WorkItemTypeDto, …>`), so adding a work-item type without deciding
 * how it dispatches is a COMPILE error here — the same totality guarantee
 * `TOOL_SCOPES` uses for the MCP scope map.
 */
const WHAT_TO_DO: Record<WorkItemTypeDto, string[]> = {
  code: [
    '1. Read the card description above and every file it names under "Context refs".',
    '2. Implement the change, following the repository conventions in its CLAUDE.md',
    '   (auto-loaded when you enter the repo) — do not restate or re-derive them.',
    '3. Ship the TESTS that cover the change in the SAME change set: the new logic,',
    '   every new branch, and the error / edge cases. Code without tests is incomplete.',
    '4. Run the repository checks (lint, typecheck, formatting, build) plus the test',
    '   files you added or changed. Do not run the full suite locally — CI runs it.',
    '5. Stop when every acceptance criterion below holds. Do not widen the scope; log',
    '   anything else you find as a separate work item.',
  ],
  design: [
    '1. Read the card description above, then INVENTORY the shipped reality the',
    '   surface lands in — the real routes, shell, and neighbouring design assets.',
    '   Design to FIT what exists; never invent a route, nav, or architecture.',
    '2. RENDER the surface as it ships today (or the real components it composes)',
    '   before drawing anything, and design against that pixel reality.',
    '3. Produce the design asset set for the surface, composed from the real design',
    "   system's primitives and tokens — never a raw hex colour or a fixed radius.",
    '4. Draw the ACCESS PATH: the affordance in the parent surface that opens this',
    '   one. Naming the route in prose is not enough — the reader must see the door.',
    '5. Stop at the asset. A design is reviewed before anything is built on it.',
  ],
  test: [
    '1. Read the card description above and the behaviour under test.',
    '2. Write the tests it names, against the real dependencies this repository',
    '   uses for tests — not mocks of the thing being verified.',
    '3. Make each test fail for the right reason first, so it can actually catch the',
    '   regression it claims to cover.',
    '4. Run the test files you added or changed and leave them green.',
  ],
  content: [
    '1. Read the card description above for the audience, surface, and voice.',
    '2. Write the copy to the existing product vocabulary — match the terms the app',
    '   already uses on screen; do not coin a synonym for a shipped term.',
    '3. Land the copy where the product reads it from (the message catalogue or the',
    '   content file), not inline in a component, and keep every locale in parity.',
  ],
  research: [
    '1. Read the card description above for the question being answered.',
    '2. Investigate it against primary sources — the code, the data, the vendor docs',
    '   — and record what you actually verified versus what you inferred.',
    '3. Write the findings up as the deliverable, ending in a recommendation with',
    '   its trade-offs. A research card ships a document, not a code change.',
  ],
  review: [
    '1. Read the card description above for what is being reviewed and against what.',
    '2. Review it end to end, checking correctness first and consistency second.',
    '3. Report findings with a concrete failure scenario each — file and line where',
    '   one applies. A finding without a scenario is an opinion, not a defect.',
  ],
  decision: [
    '1. Read the card description above for the decision to be made and its',
    '   constraints, and verify each constraint against the shipped code.',
    '2. Lay out the real options with their trade-offs, then DECIDE — a decision card',
    '   ships a decision, not a survey.',
    '3. Record it as a decision document in the repository docs, capturing the',
    '   context, the choice, the alternatives rejected, and the consequences.',
  ],
  deploy: [
    '1. Read the card description above for the target environment and the change.',
    '2. Make the pipeline / configuration change, keeping it reproducible in code —',
    '   never a one-off manual mutation of a live environment.',
    '3. State how the change is verified after it lands, and how it is rolled back.',
  ],
  manual: [
    '1. Read the description above — it is the instruction for the person doing this.',
    '2. Perform the steps in the external system it names (a dashboard, a provider',
    '   console, a credential store).',
    '3. Report back what you did and what it produced, so the work items waiting on',
    '   this one can start. Never paste a secret into the work item.',
  ],
  chore: [
    '1. Read the card description above for the exact maintenance change.',
    '2. Make it mechanically and keep the diff to that change alone.',
    '3. Run the repository checks and leave everything green.',
  ],
};

/** WHAT TO DO for an item with no `type` set — the card body is all we have. */
const UNTYPED_WHAT_TO_DO = [
  '1. Read the card description above; it is the specification for this work.',
  '2. Do exactly what it asks, following the repository conventions in its',
  '   CLAUDE.md (auto-loaded when you enter the repo).',
  '3. Stop when every acceptance criterion below holds.',
  '',
  'NOTE: this work item has no `type` set, so these steps are the generic form.',
  'Setting a type (code / design / test / …) yields step-by-step guidance for it.',
];

/** The human-instruction WHAT TO DO — a manual item is done by a person. */
const MANUAL_WHAT_TO_DO = WHAT_TO_DO.manual;

/** Title-case a kind/type/priority enum value for prose (`in_progress` → `In progress`). */
function humanize(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * A branch-name slug from the item's title: lower-cased, non-alphanumerics
 * collapsed to single dashes, trimmed, and capped so the branch stays readable.
 * Deterministic — the same title always yields the same slug.
 */
export function branchSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'work';
}

/**
 * The branch PREFIX, chosen by what the diff will actually touch — the rule
 * `motir-meta/prompts/run.md` states as "prefix by DIFF content, not card type":
 * a design-asset-only diff uses `design/`, a docs-only diff `docs/`, and both
 * let CI skip the end-to-end legs that cannot be affected by them.
 */
function branchPrefix(type: WorkItemTypeDto | null): string {
  if (type === 'design') return 'design';
  if (type === 'decision' || type === 'research') return 'docs';
  return 'subtask';
}

/** The worktree directory the GIT WORKFLOW suggests — repo-qualified when Motir
 *  knows the repo, generic when it does not. */
function worktreeDir(targetRepo: string | null, key: string): string {
  return `../${targetRepo ?? '<repo>'}-${key.toLowerCase()}`;
}

/** A `KEY — Title` reference line, used for the parent. */
function refLine(ref: { key: string; title: string }): string {
  return `${ref.key} — ${ref.title}`;
}

/** Wrap a body in the rule-barred section heading every section shares. */
function section(heading: string, lines: string[]): string[] {
  return [RULE, heading, RULE, ...lines];
}

/**
 * The PROSE-vs-GRAPH advisory block (MOTIR-2079) — the CONTEXT lines that tell
 * the agent which items this card's acceptance criteria NAME but carry no
 * `blocked_by` edge to, and what to do about each.
 *
 * Why the prompt and not just the CLI: the CLI never assembles prompt text, so a
 * warning printed only there reaches one harness. Rendering it HERE means every
 * harness — Claude Code, Codex, opencode, a human reading the printed prompt —
 * inherits it, because none of them writes its own prompt.
 *
 * The instruction is VERIFY, never REFUSE. A `likely-missing-edge` is a strong
 * hint and not a fact: a boundary-contract card legitimately names both halves
 * of a two-PR split, an acceptance criterion legitimately names a card for
 * contrast, and a sibling may simply be done before this item is dispatched. The
 * agent is the one standing where the check is cheap (`git ls-tree origin/main`)
 * and is told to make it — which is exactly the step that has been skipped.
 *
 * Empty in, nothing out: no heading, no blank line, no trace.
 */
function advisorySection(advisories: WorkItemProseAdvisoryDto[]): string[] {
  if (advisories.length === 0) return [];
  const references = advisories.filter((a) => a.kind !== 'shape');
  const shapes = advisories.filter(isOrderingAdvisory);
  const straddles = advisories.filter(isRepoStraddleAdvisory);
  const lines: string[] = [];

  if (references.length > 0) {
    lines.push(
      '',
      'REFERENCED BUT NOT A DEPENDENCY — verify these before you branch:',
      ...references.map(
        (a) =>
          `    - ${a.referenced} (${a.referencedStatus}) is named in this card's acceptance` +
          ` criteria, but this item carries no blocked_by edge to it.`,
      ),
      '  For each one, confirm the substrate it provides is already on origin/main',
      '  (git ls-tree / git grep origin/main for the file, symbol or test the criterion',
      '  names). If it lives ONLY on an open pull request, this item is blocked in fact:',
      '  wire the blocked_by edge and STOP. Do not rebuild the other half yourself and do',
      '  not stack onto the unmerged branch — two green pull requests whose composition',
      '  turns main red is the recurring failure this warning exists to prevent.',
    );
  }

  // The ORDERING advisory (MOTIR-2175). Addressed to the agent because the agent
  // is the party the defect lands on: its two moves are to stop with the card
  // half-done or to fake the precondition (tag a pre-merge commit, publish from
  // an unmerged tree), and both are rule violations. Naming the criterion index
  // is what makes the third move — cut the card here — available.
  if (shapes.length > 0) {
    lines.push(
      '',
      "A CRITERION THAT TURNS ON THIS CARD'S OWN MERGE — read this before you start:",
      ...shapes.map(
        (a) =>
          `    - acceptance criterion ${a.criterionIndex} says "${a.phrase}", which is state` +
          ` that exists only after this card's pull request has MERGED.`,
      ),
      '  Your boundary ends at PR opened: this repo merges manually, and the merge is',
      "  the human reviewer's. So that criterion — and every criterion below it, which",
      '  inherits the same dependency — belongs to a follow-on card blocked_by this one.',
      '  Do NOT fake the precondition (no tagging a pre-merge commit, no publishing from',
      '  an unmerged tree) and do NOT silently drop the criterion. Build everything ABOVE',
      '  the line, then report the split so the remainder can be carded (plan-rules.md,',
      '  gate 14, ORDERING axis).',
    );
  }

  // The REPO-STRADDLE advisory (MOTIR-2177). Addressed to the agent for the same
  // reason: it is about to create ONE worktree in ONE repo, and a criterion
  // discharged in another repo is one it physically cannot satisfy from there.
  // Naming the PATH is what makes the finding checkable in a second rather than
  // taken on faith — and checkable is what it needs to be, because a
  // boundary-contract card fires here legitimately.
  if (straddles.length > 0) {
    lines.push(
      '',
      'A CRITERION DISCHARGED IN ANOTHER REPO — read this before you branch:',
      ...straddles.map((a) =>
        a.reason === 'contradiction'
          ? `    - acceptance criterion ${a.criterionIndex} names ${a.path}, which lives in` +
            ` ${a.repo} — not this card's pinned repo.`
          : `    - acceptance criterion ${a.criterionIndex} names ${a.path} (${a.repo}), and this` +
            ' card pins no repo while its criteria name more than one.',
      ),
      '  ONE SUBTASK = ONE REPO = ONE PR: one worktree, one pull request, so a criterion',
      "  discharged outside this card's repo cannot be satisfied inside it. CHECK IT FIRST —",
      "  if the other repo's half is already merged, or this is a boundary-contract card whose",
      '  own body pins the producer/mirror split (two coordinated PRs, one card), the finding',
      '  is a known false positive and you proceed. Otherwise do NOT silently pick one repo and',
      "  drop the other's criteria: that is run.md guard #5 — surface the split and STOP.",
    );
  }
  return lines;
}

/** The CONTEXT section's fact lines + the card's narrative body. */
function contextSection(
  src: DispatchPromptSource,
  narrative: string,
  contextRefs: string[],
  injections: DispatchPromptInjections,
): string[] {
  const facts: string[] = [
    `- Project: ${src.projectName} (${src.projectKey})`,
    `- Work item: ${src.key} · ${humanize(src.kind)} · type ${src.type ?? 'unset'} · executor ${
      src.executor ?? 'unset'
    } · priority ${src.priority}`,
  ];

  const sizing: string[] = [];
  if (src.storyPoints !== null) sizing.push(`${src.storyPoints} story points`);
  if (src.estimateMinutes !== null) sizing.push(`~${src.estimateMinutes} min`);
  if (sizing.length > 0) facts.push(`- Sizing: ${sizing.join(' · ')}`);

  facts.push(
    src.targetRepo
      ? `- Repo: ${src.targetRepo} — do the work in this repository's checkout.`
      : '- Repo: not pinned. Motir cannot say which repository this item belongs to;' +
          ' work in the checkout you were invoked from.',
  );
  facts.push(src.parent ? `- Parent: ${refLine(src.parent)}` : '- Parent: none (top-level item)');
  facts.push(
    src.blockerKeys.length > 0
      ? `- Depends on (already landed): ${src.blockerKeys.join(', ')}`
      : '- Depends on: nothing — this item stands alone.',
  );

  if (contextRefs.length > 0) {
    facts.push('- Context refs — READ these before you start:');
    for (const ref of contextRefs) facts.push(`    - ${ref}`);
  } else {
    facts.push('- Context refs: none named on the card.');
  }

  // The Epic-9 enrichment slots (empty in motir-core — see the module header).
  for (const block of injections.conventions) facts.push('', block);
  for (const block of injections.lessons) facts.push('', block);

  // Sibling to the lessons slot, and for the same reason: something the agent
  // must know BEFORE it starts, not something it would find in the card body.
  facts.push(...advisorySection(src.advisories ?? []));

  facts.push('', 'CARD DESCRIPTION');
  facts.push('', narrative.length > 0 ? narrative : '(The card carries no description body.)');
  return facts;
}

/** The ACCEPTANCE CRITERIA section — the card's own criteria, or the honest
 *  fallback when it names none. */
function acceptanceSection(criteria: string[]): string[] {
  if (criteria.length > 0) return criteria;
  return [
    'The card names no explicit acceptance criteria. Satisfy everything the',
    'description asks for — and nothing beyond it.',
  ];
}

/** The per-item-PR GIT WORKFLOW: branch from `origin/main`, one PR, stop. */
function perItemPrWorkflow(src: DispatchPromptSource): string[] {
  const branch = `${branchPrefix(src.type)}/${src.key}-${branchSlug(src.title)}`;
  const dir = worktreeDir(src.targetRepo, src.key);
  return [
    'This item has no session lineage, so it ships as ONE pull request of its own.',
    '',
    `1. git fetch origin && git worktree add ${dir} -b ${branch} origin/main`,
    `2. cd ${dir}, install dependencies, and do ALL the work inside this worktree.`,
    '3. Stage with explicit `git add <path>` — never `-A`, so concurrent work in',
    '   other worktrees, or unrelated local edits, cannot ride along in your commit.',
    `4. Commit with a Conventional Commits subject that carries ${src.key}.`,
    `5. Push the branch and open a pull request against main whose TITLE carries`,
    `   ${src.key} (that reference is what moves this work item to In Review, and`,
    '   moves it to Done when a human merges).',
    '6. STOP at the open pull request. Do not merge it and do not delete the branch.',
  ];
}

/** The session-lineage GIT WORKFLOW: branch from / integrate into the inherited
 *  session branch, then report it with `mark_integrated`. */
function sessionLineageWorkflow(src: DispatchPromptSource, sessionBranch: string): string[] {
  const branch = `${branchPrefix(src.type)}/${src.key}-${branchSlug(src.title)}`;
  const dir = worktreeDir(src.targetRepo, src.key);
  return [
    `This item inherits the session branch ${sessionBranch}: the work it depends on`,
    'is integrated there and awaiting ONE human review, so this work joins the SAME',
    'lineage instead of opening a pull request of its own.',
    '',
    `1. git fetch origin && git worktree add ${dir} -b ${branch} origin/${sessionBranch}`,
    `2. cd ${dir}, install dependencies, and do ALL the work inside this worktree.`,
    '3. Stage with explicit `git add <path>` — never `-A`.',
    `4. Commit with a Conventional Commits subject that carries ${src.key}.`,
    `5. Integrate the commit into ${sessionBranch} and push that branch.`,
    `6. Report it: call the mark_integrated tool with key ${src.key} and`,
    `   sessionBranch ${sessionBranch}.`,
    '7. Do NOT open a pull request for this item. The session branch has one review',
    '   surface, and a human opens and merges it.',
  ];
}

/** The closing note a MANUAL item gets in place of a GIT WORKFLOW section. */
const MANUAL_CLOSING = [
  'There is no git workflow for this work item: it is human work with no branch and',
  'no pull request. When it is complete, say so — that confirmation is what moves it',
  'to Done and releases the work items waiting on it.',
];

/**
 * Assemble the canonical dispatch prompt for a work item.
 *
 * Deterministic and total: every input shape yields a prompt (an untyped item, a
 * body with no acceptance criteria, an unknown repo, a manual item). See the
 * module header for the three axes that vary and where each is decided.
 */
export function assembleDispatchPrompt(src: DispatchPromptSource): AssembledDispatchPrompt {
  const injections = src.injections ?? NO_INJECTIONS;
  const { body, acceptanceCriteria, contextRefs } = splitPlanBody(src.descriptionMd);
  const manual = isManualReadyItem({ type: src.type, executor: src.executor });
  // The lineage the prompt instructs. A manual item is forced to `per_item_pr`
  // with no branch — it renders no GIT WORKFLOW at all (see the interface doc).
  const sessionBranch = manual ? null : src.sessionBranch;
  const workflowMode: DispatchWorkflowMode =
    sessionBranch !== null ? 'session_lineage' : 'per_item_pr';

  const header = [
    `You are working on the ${src.projectName} project.`,
    `You are executing ${humanize(src.kind)} ${src.key}: ${src.title}.`,
  ];
  if (manual) {
    header.push(
      '',
      'This is a MANUAL work item: a person does it, not a coding agent. The steps',
      'below are instructions for that person.',
    );
  }

  let whatToDo = UNTYPED_WHAT_TO_DO;
  if (manual) whatToDo = MANUAL_WHAT_TO_DO;
  else if (src.type) whatToDo = WHAT_TO_DO[src.type];

  let closing = MANUAL_CLOSING;
  if (!manual) {
    closing = section(
      'GIT WORKFLOW',
      sessionBranch !== null ? sessionLineageWorkflow(src, sessionBranch) : perItemPrWorkflow(src),
    );
  }

  const lines = [
    ...header,
    '',
    ...section('CONTEXT', contextSection(src, body, contextRefs, injections)),
    '',
    ...section('WHAT TO DO', whatToDo),
    '',
    ...section('ACCEPTANCE CRITERIA — every one must hold', acceptanceSection(acceptanceCriteria)),
    '',
    ...closing,
  ];

  return { prompt: lines.join('\n') + '\n', workflowMode, sessionBranch };
}
