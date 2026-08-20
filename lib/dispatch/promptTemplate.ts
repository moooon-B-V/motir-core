import type { DispatchWorkflowMode } from '@/lib/dto/dispatch';
import { isManualReadyItem } from '@/lib/dto/ready';
import {
  isOrderingAdvisory,
  isReferenceAdvisory,
  isRepoStraddleAdvisory,
  isSelfBlockingDesignAdvisory,
  isSizingAdvisory,
  isSubsumptionAdvisory,
} from '@/lib/dto/workItems';
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
// `motir next --print`) tests for. The SERVICE reads state and calls this; this
// module never reads anything.
//
// ⚠️ THE INPUT RECORD NOW INCLUDES THE RUN'S POLICY (MOTIR-3020), and the
// determinism property is RESTATED rather than weakened. It used to be phrased as
// "two calls for an unchanged ITEM return byte-identical output"; the honest form
// is two-sided:
//
//   • the same item WITH THE SAME POLICY returns byte-identical output; and
//   • the same item with a DIFFERENT policy returns DIFFERENT output — which has
//     to be asserted explicitly, or an inert switch passes every disabled-branch
//     test vacuously.
//
// This trades a property MOTIR-2406 stated deliberately — *"every instruction
// here is unconditional"* — and the trade is recorded in
// `docs/decisions/run-findings-protocol.md` Q1, not slipped in. What it costs:
// a prompt is no longer reproducible from the CARD alone, and two agents on one
// card can be told different things. What it buys: an operator can say what their
// agent may write, and a flag the prompt never carried could never have done
// that, because the prompt is the entire contract with a sandboxed agent.
// {@link FULL_FINDINGS_POLICY} is what an omitted policy means, and it is the
// complete protocol.
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
/**
 * The two capabilities a run may switch OFF for its agent (MOTIR-3020,
 * `docs/decisions/run-findings-protocol.md` Q1).
 *
 * Named after the CAPABILITY rather than the CLI flag that disables it: the
 * grammar must not inherit one client's `--disable-` prefix, and the same names
 * are what the `findingsPolicy` query parameter carries on the wire.
 */
export interface FindingsPolicy {
  /** May the agent FILE A BUG for a defect that is not about its own card? */
  logBug: boolean;
  /** May the agent SUBMIT A RE-PLAN when its own card's premise is false? */
  replan: boolean;
}

/**
 * The default, and the reason the default is this way round.
 *
 * An omitted policy renders the COMPLETE protocol, so every existing caller —
 * and a human reading `motir run --print` to learn what an agent is told — sees
 * the whole contract. A prompt that quietly dropped a branch because a parameter
 * was absent would make the contract depend on how it was REQUESTED, which is the
 * failure the unconditional-prompt rule (MOTIR-2406) existed to prevent. What
 * this trades is narrower: an operator may now spend that property deliberately,
 * per run, and nothing spends it for them.
 */
export const FULL_FINDINGS_POLICY: FindingsPolicy = { logBug: true, replan: true };

/**
 * The wire vocabulary of {@link FindingsPolicy}: the tokens a caller may name to
 * DISABLE a capability. A closed set, and a list of what is OFF rather than a
 * mode, so a third capability adds one token instead of doubling an enum.
 */
export const FINDINGS_POLICY_TOKENS = ['log-bug', 'replan'] as const;

export type FindingsPolicyToken = (typeof FINDINGS_POLICY_TOKENS)[number];

/**
 * Parse the `findingsPolicy` parameter — a comma-separated list of DISABLED
 * capabilities — into the policy the template consumes.
 *
 * Shared by both transports on purpose: the `/api/v1` route and the MCP tool must
 * not be able to disagree about what a token means, and re-expressing the
 * vocabulary per transport is how they would.
 *
 * ⚠️ AN UNRECOGNISED TOKEN IS A REFUSAL, NOT AN IGNORED ONE — returned as
 * `{ unknown }` for the caller to raise in its own error shape. A typo that
 * silently rendered the FULL protocol is exactly the lie this whole story removes:
 * the operator would believe they had switched something off while the agent went
 * on being told to do it. Absent and empty both mean the full protocol, because a
 * client assembling a query string from an optional value should not have to know
 * the difference between omitting a key and sending it blank.
 */
export function parseFindingsPolicy(
  raw: string | null | undefined,
): { policy: FindingsPolicy; unknown: null } | { policy: null; unknown: string } {
  const value = (raw ?? '').trim();
  if (value === '') return { policy: FULL_FINDINGS_POLICY, unknown: null };

  const disabled = new Set<string>();
  for (const part of value.split(',')) {
    const token = part.trim();
    if (token === '') continue;
    if (!(FINDINGS_POLICY_TOKENS as readonly string[]).includes(token)) {
      return { policy: null, unknown: token };
    }
    disabled.add(token);
  }
  return {
    policy: { logBug: !disabled.has('log-bug'), replan: !disabled.has('replan') },
    unknown: null,
  };
}

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
  /**
   * EVERY repository the item ships in (Story MOTIR-2731 · MOTIR-3132) —
   * ordered, the PRIMARY first, which is the repository the agent's process is
   * launched in. `targetRepos[0]?.name ?? null === targetRepo`, always.
   *
   * Omitted, empty, or of length ONE renders the prompt EXACTLY as it renders
   * today: the multi-repository grammar exists only where a card actually has
   * more than one repository, so every item that exists is unaffected by
   * construction rather than by inspection.
   *
   * The default branch travels WITH the name because the multi-repository blocks
   * branch from `origin/<default>` per repository; the single-repository
   * grammar's hardcoded `origin/main` is left exactly as it is (changing it
   * would move text this card promises not to move).
   */
  targetRepos?: { name: string; defaultBranch: string | null }[];
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
  /**
   * What this run permits the agent to WRITE (MOTIR-3020) — the per-run findings
   * policy, defaulting to {@link FULL_FINDINGS_POLICY} when omitted.
   *
   * ⚠️ IT IS PART OF THE INPUT RECORD, which is what keeps the module's purity
   * claim true rather than merely restated. See the header.
   */
  findingsPolicy?: FindingsPolicy;
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
    '5. Stop when every acceptance criterion below holds. Do not widen the scope —',
    '   anything else you find is a FOUND A DEFECT, handled in the outcome protocol',
    '   below, which says what to do with it and whether this run may file it.',
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
    '6. CONFIRM the design result reached the work item — CI publishes it from the',
    '   design-asset guards job, and that step is SKIPPED when the guards fail. Look',
    '   for "Published N design artifact(s)" in the job log, or the result on the',
    '   card. If it is not there, publish it yourself: POST the design-evidence',
    '   upload-token route, PUT each file, then POST the register route. The',
    '   REPOSITORY stays the source of truth — the published result is the card’s',
    '   view of the asset, never a replacement for committing the three files.',
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
  copy: [
    '1. Read the card description above for the surface, the audience and the voice.',
    '2. Write the strings to the product vocabulary already on screen — match the',
    '   terms the app uses; never coin a synonym for a shipped term.',
    '3. Land them where the product reads them from (the message catalogue), keyed',
    '   the way its neighbours are — never inline in a component.',
    '4. Every locale the catalogue ships stays in parity: a new key needs its twin',
    '   in each one, or the build has a hole in it.',
  ],
  translate: [
    '1. Read the card description above for the target locale and the source strings.',
    '2. Translate ONLY what already exists — a translation card authors no new',
    '   meaning. If a source string is missing or wrong, say so; do not invent it.',
    '3. Follow the locale style guide the repository records (register, tone, and',
    '   the glossary of terms that must not be translated).',
    '4. Leave the catalogue at exact key parity with the source locale.',
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
  verification: [
    '1. Read the card description above for the CLAIM to be verified — a stated fact',
    '   about the system, not a deliverable to judge.',
    '2. Verify it where the claim actually lives: pull the artifact from the registry',
    '   its consumer reads, grep the shipped code, read the value back from the',
    '   platform API. A config file in this repository is a claim, not a reading.',
    '3. Record the EVIDENCE — the command you ran and its output — not a verdict on',
    '   its own. "Verified" without the output it came from is an assertion.',
    '4. If the claim is false, say so plainly and log what is actually true. A',
    '   verification that cannot fail has verified nothing.',
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
  legal: [
    '1. Read the card description above for the legal artifact and the requirement it',
    '   satisfies.',
    '2. DRAFT it — and stop at the draft. This work ends in a signature, and you',
    '   cannot sign: the card defaults to a human executor for that reason.',
    '3. Ground every clause in something real (the requirement, the jurisdiction, the',
    '   product behaviour it describes); flag anything you had to assume.',
    '4. Name who must review and sign it before it is published anywhere.',
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
  const references = advisories.filter(isReferenceAdvisory);
  const shapes = advisories.filter(isOrderingAdvisory);
  const straddles = advisories.filter(isRepoStraddleAdvisory);
  const subsumed = advisories.filter(isSubsumptionAdvisory);
  const oversized = advisories.filter(isSizingAdvisory);
  const selfBlocking = advisories.filter(isSelfBlockingDesignAdvisory);
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

  // THE ESTIMATION GATE (MOTIR-3110). Addressed to the agent because the agent
  // is where the cost lands: a card sized past the gate is a session that runs
  // out of room, and the recurring ending is a hundred-file pull request nobody
  // can review. It goes in the prompt rather than only in the tool summary for
  // the same reason the other three do — the prompt is the one surface every
  // harness inherits, because none of them assembles its own.
  if (oversized.length > 0) {
    lines.push(
      '',
      'THIS CARD IS SIZED PAST THE ESTIMATION GATE — split it before you start:',
      ...oversized.map(
        (a) =>
          `    - ${a.storyPoints ?? '—'} story points / ${a.estimateMinutes ?? '—'} estimated` +
          ` minutes, over ${a.threshold === 'both' ? 'BOTH ceilings' : a.threshold === 'story_points' ? 'the 13-point split signal' : 'the 60-minute run ceiling'}.`,
      ),
      '  13+ points is the split signal read literally, and a coding_agent run must fit inside',
      '  an hour. READ THE CARD FIRST: every prior instance of this had already done the',
      '  analysis and written the axis to split on into its own description — that is why the',
      '  check exists, because the answer kept going into a field nothing reads. Propose the',
      '  split and STOP; do not start a run whose own sizing says it will not finish. If the',
      '  card is genuinely one unit and the numbers are wrong, say so and correct them on the',
      '  record — but do not simply proceed past this line.',
    );
  }

  // THE DESIGN GATE (MOTIR-3178). Addressed to the agent because the agent is the
  // one holding both halves: the card in its hand asks it to draw a design and
  // then build the files that match it, in one pull request, with nobody looking
  // in between. That is Principle #13 exactly inverted, and the agent is the last
  // point at which it is still cheap to say so.
  if (selfBlocking.length > 0) {
    lines.push(
      '',
      'THIS CARD IS ITS OWN DESIGN BLOCKER — it draws the design AND builds it:',
      ...selfBlocking.map(
        (a) =>
          `    - criterion ${a.designCriterionIndex} produces a design asset; criterion ` +
          `${a.surfaceCriterionIndex} builds a rendered surface against it.`,
      ),
      '  Design before code, WITHIN every story (Principle #13) means somebody sees the drawing',
      '  before the files written to match it. Read literally the design gate is satisfied here —',
      '  the type: design subtask this card must be linked to IS this card — which is exactly the',
      '  reading this check exists to catch. The remedy is a LIFT, not a cut: propose the design',
      '  criterion as its OWN type: design card, leave the rest blocked_by it, and STOP. Do not',
      '  draw and build in one pass. If the composition is genuinely right — the asset is a small',
      '  amendment nobody needs to approve separately — say so on the record and proceed.',
    );
  }

  // The SUBSUMPTION advisory (MOTIR-2903). Addressed to the agent because the
  // agent is the one about to spend a session rebuilding something that is
  // already on `main` — a rebuild that is green in isolation, conflicts with
  // nothing, and ends with a second mechanism for a problem that already has
  // one. The remedy is a diff to READ, so the pull request is named rather than
  // the finding merely asserted.
  if (subsumed.length > 0) {
    lines.push(
      '',
      'THIS CARD MAY ALREADY BE BUILT — read the diff before you write a line:',
      ...subsumed.map(
        (a) =>
          `    - ${a.path}, which this card's body names, was changed by ${a.pullRequest}` +
          ` (merged ${a.mergedAt}${a.pullRequestTitle ? ` — "${a.pullRequestTitle}"` : ''}),` +
          ' after this card was filed.',
      ),
      "  A card is not closed when the work that satisfies it merges under someone else's",
      '  key, so a card whose deliverable already shipped still reads ready, still ranks',
      "  high, and still gets claimed. READ that pull request against this card's",
      '  acceptance criteria. If it already delivers them, STOP: close the card with the',
      '  merge as the evidence and report it — do not rebuild merged work. If the two',
      '  merely touch the same file, which is the ordinary case, proceed normally.',
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

  const repoSet = multiRepoSet(src);
  if (repoSet) {
    // MOTIR-3132 — the agent is standing in ONE checkout and owes work in all of
    // them, so the set is named here rather than left to be discovered in the
    // GIT WORKFLOW section. The paths are the CLI's `<root>/<name>` convention
    // and are stated as an expectation, never as a fact: this text is assembled
    // server-side and cannot know where a person keeps their checkouts. The run
    // resolves and prints the real ones (MOTIR-3133).
    facts.push(`- Repositories (${repoSet.length}) — this item ships in EVERY one of them:`);
    repoSet.forEach((repo, i) => {
      facts.push(
        i === 0
          ? `    - ${repo.name} — the PRIMARY, and your working directory.`
          : `    - ${repo.name} — expected as a sibling of it, at ../${repo.name}.`,
      );
    });
    facts.push(
      '    The run names each repository\u2019s actual resolved path before you start. If one',
      '    is missing or elsewhere, say so in your outcome report — do not work around it.',
    );
  } else {
    facts.push(
      src.targetRepo
        ? `- Repo: ${src.targetRepo} — do the work in this repository's checkout.`
        : '- Repo: not pinned. Motir cannot say which repository this item belongs to;' +
            ' work in the checkout you were invoked from.',
    );
  }
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

/**
 * The repository SET, but ONLY when it is one this grammar has anything extra to
 * say about. Fewer than two repositories is today's world, and this returns
 * `null` for it so every caller reads one condition rather than three.
 */
function multiRepoSet(
  src: DispatchPromptSource,
): { name: string; defaultBranch: string | null }[] | null {
  const repos = src.targetRepos ?? [];
  return repos.length >= 2 ? repos : null;
}

/** The branch a card takes — the SAME name in every repository it ships in. */
function cardBranch(src: DispatchPromptSource): string {
  return `${branchPrefix(src.type)}/${src.key}-${branchSlug(src.title)}`;
}

/** How to reach a repository from the agent's working directory (the primary's
 *  checkout): itself, or a sibling under the workspace root. */
function siblingDir(repo: string, index: number): string {
  return index === 0 ? '.' : `../${repo}`;
}

/**
 * The per-repository steps of a MULTI-repository `per_item_pr` workflow — one
 * block per repository, in set order, primary first.
 *
 * Every block is complete on its own: enter the repository, branch, work,
 * commit, push, open a pull request whose TITLE carries the key. The key in the
 * title is the load-bearing part and the one an agent would most plausibly drop
 * — the completion gate counts merges against the item's LINKED pull requests,
 * so a pull request without it is invisible to the gate and the card is held
 * forever by work that has actually shipped.
 */
function multiRepoPrBlocks(
  src: DispatchPromptSource,
  repos: NonNullable<ReturnType<typeof multiRepoSet>>,
) {
  const branch = cardBranch(src);
  const lines: string[] = [];
  repos.forEach((repo, i) => {
    // Every step is relative to the repository's OWN checkout, which step 1
    // enters — so the worktree path is the same `../<repo>-<key>` the
    // single-repository grammar renders, for every element of the set.
    const wt = worktreeDir(repo.name, src.key);
    lines.push(
      '',
      `${repo.name}${i === 0 ? '  (your working directory)' : '  (a sibling checkout)'}`,
      '',
      `  1. cd ${siblingDir(repo.name, i)} && git fetch origin`,
      `  2. git worktree add ${wt} -b ${branch} origin/${repo.defaultBranch ?? 'main'}`,
      `  3. cd ${wt}, install dependencies, and do THIS repository's half of the work here.`,
      '  4. Stage with explicit `git add <path>` — never `-A`.',
      `  5. Commit with a Conventional Commits subject that carries ${src.key}.`,
      `  6. Push the branch and open a pull request against ${repo.defaultBranch ?? 'main'} whose`,
      `     TITLE carries ${src.key}.`,
    );
  });
  return lines;
}

/**
 * The MULTI-repository `per_item_pr` GIT WORKFLOW: one worktree, one branch and
 * one pull request PER REPOSITORY, and the item completes only when every one of
 * them has merged.
 *
 * ONE branch NAME across all of them, deliberately. It is what makes the set
 * legible as halves of one change rather than two unrelated pushes that happen
 * to share a key — `gh pr list --head <branch>` finds them all — and one level
 * up it is what lets the item record a single `sessionBranch`, which is a scalar.
 */
function multiRepoPerItemPrWorkflow(
  src: DispatchPromptSource,
  repos: NonNullable<ReturnType<typeof multiRepoSet>>,
): string[] {
  return [
    `This item ships in ${repos.length} repositories, so it needs ONE pull request in`,
    'EACH of them. It has no session lineage, so they are pull requests of its own.',
    '',
    `The branch name is the SAME in every repository: ${cardBranch(src)}`,
    ...multiRepoPrBlocks(src, repos),
    '',
    `STOP at the ${repos.length} open pull requests. Do not merge any of them and do not`,
    'delete any branch. This item is not complete until EVERY one of them has merged —',
    'a single merged pull request leaves it held, waiting on the others.',
    '',
    'If one repository turns out to need no change at all, say so in the outcome report',
    'rather than opening an empty pull request; that is a fact about the card, and',
    'somebody has to decide what it means.',
  ];
}

/**
 * The MULTI-repository `session_lineage` GIT WORKFLOW: the SAME session branch
 * in every repository, integrated in each, and exactly ONE `mark_integrated`.
 *
 * One call, not one per repository: `mark_integrated` reports THE ITEM's
 * lineage, and the item has one — `work_item.sessionBranch` is a scalar, which
 * is the same reason the branch name is shared.
 */
function multiRepoSessionLineageWorkflow(
  src: DispatchPromptSource,
  repos: NonNullable<ReturnType<typeof multiRepoSet>>,
  sessionBranch: string,
): string[] {
  const branch = cardBranch(src);
  const lines: string[] = [
    `This item inherits the session branch ${sessionBranch}, and it ships in`,
    `${repos.length} repositories. The lineage is the SAME branch name in each of them:`,
    'the work it depends on is integrated there and awaiting ONE human review, so this',
    'work joins that lineage in every repository instead of opening pull requests.',
    '',
    `Your working branch is the same in each too: ${branch}`,
  ];
  repos.forEach((repo, i) => {
    const wt = worktreeDir(repo.name, src.key);
    lines.push(
      '',
      `${repo.name}${i === 0 ? '  (your working directory)' : '  (a sibling checkout)'}`,
      '',
      `  1. cd ${siblingDir(repo.name, i)} && git fetch origin`,
      `  2. git worktree add ${wt} -b ${branch} origin/${sessionBranch}`,
      `  3. cd ${wt}, install dependencies, and do THIS repository's half of the work here.`,
      '  4. Stage with explicit `git add <path>` — never `-A`.',
      `  5. Commit with a Conventional Commits subject that carries ${src.key}.`,
      `  6. Integrate the commit into ${sessionBranch} and push that branch.`,
    );
  });
  lines.push(
    '',
    `Then report it ONCE: call the mark_integrated tool with key ${src.key} and`,
    `sessionBranch ${sessionBranch}. One call for the item, not one per repository —`,
    'the item records a single session branch, which is why the name is shared.',
    '',
    'Do NOT open a pull request in any repository. The session branch has one review',
    'surface per repository, and a human opens and merges them.',
  );
  return lines;
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
    `   ${src.key} (that reference is what LINKS the pull request to this work`,
    '   item: it moves the item to Done when a human merges, and it is how the CI',
    '   verdict on your commits finds the card).',
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

/**
 * WHICH MODEL RAN (MOTIR-2419) — the one fact only the agent holds.
 *
 * Every other half of the implementation provenance triple is derivable by the
 * launcher: it knows the source (a BYOK machine) and it knows the harness (it
 * ran the command). The MODEL is visible nowhere outside the agent process, so
 * either the agent says it or the record is empty forever — a run cannot be
 * re-interrogated after it exits.
 *
 * Applies to BOTH outcomes, which is why it sits above them: a card that turned
 * out to be wrong was still worked by a model, and knowing which one is part of
 * knowing what the finding is worth.
 *
 * The instruction is conditional on the environment variable rather than on a
 * prompt variant, because this prompt is also what a human reads when they run
 * `motir next --print` — there is no report file in that case, and an
 * unconditional instruction would have them inventing a path.
 *
 * The channel is a file rather than a tool call on purpose. Reporting the model
 * over MCP would put a claim about the run on the ITEM, where nothing could
 * check it against the process that made it; the file is written by the agent
 * into a directory the launcher created for this one dispatch and deletes when
 * it ends, so a report can only ever describe the run it came from.
 */
function modelSelfReport(): string[] {
  return [
    'FIRST, one line of bookkeeping that applies to BOTH outcomes below. If the',
    'environment variable MOTIR_AGENT_REPORT is set, write a JSON file at that path:',
    '',
    '         {"model": "<the model you are running as>"}',
    '',
    '  Name the model as precisely as you can — the identifier, not the family.',
    '  Nothing outside your process can observe which model answered, so this is the',
    "  only chance to record it, and it becomes the work item's implementation",
    '  provenance.',
    '',
    '  If you genuinely cannot tell, write no file at all: an empty record is honest,',
    '  and a guessed one is not. If the variable is unset, skip this entirely.',
  ];
}

/**
 * REPORTING THE OUTCOME (MOTIR-2406) — the two signals the loop cannot infer.
 *
 * ⚠️ WHY THIS IS IN THE PROMPT AND CANNOT BE ANYWHERE ELSE. `motir auto` runs
 * `claude --dangerously-skip-permissions` in a sandbox against the user's own
 * key. There is no wrapper, no policy layer and no second channel: the prompt is
 * the ENTIRE contract with the agent, and whatever is not in it does not happen.
 * An instruction that lives in a runbook, a CLAUDE.md or a reviewer's
 * expectations is an instruction the sandboxed agent never receives.
 *
 * Unconditional — no mode, no parameter. A human-driven `motir run` should
 * report the same way, and a signal that only some dispatches carry is a signal
 * the loop cannot rely on.
 *
 * The FAILURE THIS PREVENTS IS THE QUIET ONE. An agent that cannot do what the
 * card says will still do something — that is what makes it useful the rest of
 * the time. Faced with a false premise it finds the nearest satisfiable
 * interpretation and ships that, with a green test run and a confident pull
 * request, and the defect surfaces later as a change nobody asked for sitting on
 * a card nobody re-read. Telling it to stop and describe what it found turns the
 * most expensive failure mode into the cheapest one.
 */
/**
 * WHAT ENDS THIS WORK, and what does not.
 *
 * Three branches (MOTIR-3020, `docs/decisions/run-findings-protocol.md`), and the
 * third one is the one an agent gets wrong without being told: FINISHED and THE
 * CARD IS WRONG are both about the card in hand, while FOUND A DEFECT is about
 * something else entirely and must NOT end the run.
 *
 * Two of the three are switchable by the run's {@link FindingsPolicy}, and a
 * disabled branch renders NOTHING — no heading, no blank line, no trace — the
 * same empty-in-nothing-out shape {@link advisorySection} uses. What replaces it
 * is not silence: the agent is told what to do INSTEAD, because an agent with a
 * finding and no instruction improvises.
 */
function outcomeProtocol(src: DispatchPromptSource): string[] {
  const policy = src.findingsPolicy ?? FULL_FINDINGS_POLICY;
  return [
    'Two outcomes end this work, and the loop can only tell them apart if you SAY',
    'which one happened. A process that exits 0 proves the process ended, nothing',
    'more.',
    '',
    ...modelSelfReport(),
    '',
    'FINISHED — the work is done, committed, PUSHED, and its pull request is open:',
    '',
    '  IN THIS ORDER, and the order is the point:',
    '',
    '    1. commit',
    '    2. push the branch',
    '    3. open the pull request',
    `    4. move ${src.key} to Implemented with the transition_status tool`,
    `       (key ${src.key}, status implemented)`,
    '',
    '  Implemented means THE CODE IS ON THE REMOTE — not "I finished typing".',
    '  Transitioning before the push would make the card assert built work that',
    '  exists only in a worktree this run is about to delete. Pushing first makes',
    '  the failure honest instead: if you die after the push, the branch is there',
    '  and the card still reads in progress, which is what an interrupted run is.',
    '',
    '  The transition is REQUIRED, not a courtesy: it is the only positive',
    '  confirmation the run gets, and without it a finished card is',
    '  indistinguishable from an agent that died quietly.',
    '',
    '  Do NOT set In Review. You do not own that status — CI does. It is written',
    '  when the checks on your pushed commit go green, by the webhook, server-side',
    '  and after you have exited. Setting it yourself asserts a green run that has',
    '  not happened yet.',
    '',
    'THE CARD IS WRONG — its premise is false, a precondition it names has not',
    'shipped, or an acceptance criterion cannot be satisfied. Do NOT find the',
    'nearest thing that works and build that. In order:',
    '',
    '  1. REVERT FIRST. Put the tree back the way you found it and commit',
    '     NOTHING. Do this before anything else — every later step is a step in',
    '     which you might otherwise have committed a half-change.',
    ...cardIsWrongSteps(src, policy),
    ...foundADefect(src, policy),
  ];
}

/**
 * The steps after the revert, which is where the re-plan switch lives.
 *
 * ⚠️ THE PROHIBITION IS REPLACED, NOT DELETED, and what survives is the half that
 * was load-bearing: DO NOT RESTRUCTURE THE PLAN. An agent that can re-shape the
 * tree can card its way out of a card it cannot finish, which is the exact
 * improvisation this whole protocol exists to prevent.
 *
 * What GOES is the blanket ban on creation and the reason given for it — *"A plan
 * is PROPOSALS awaiting a human's approval; writing the cards would be doing the
 * approving"*. That sentence misdescribes the mechanism: `create_work_item` is a
 * DIRECT write that enters no proposal pipeline and that nobody approves. It is
 * how `motir log-bug` files bugs and how every card of this story was authored.
 */
function cardIsWrongSteps(src: DispatchPromptSource, policy: FindingsPolicy): string[] {
  const permitted = policy.replan
    ? 'Creating a bug and submitting a re-plan (both below) are permitted.'
    : 'Creating a bug is permitted where this prompt says so.';
  const restructuring = [
    '  2. Do not improvise. No adjacent fix, and no widening the card so it',
    '     becomes satisfiable. Do NOT RESTRUCTURE THE PLAN: no archiving, no',
    '     re-parenting, no re-scoping, and no editing any other card.',
    `     ${permitted}`,
    `  3. Comment the finding on ${src.key}: what is false, and the evidence — the`,
    '     file you read, the command you ran, what it said.',
  ];

  // The switch. With re-planning disabled there is nothing to submit and nowhere
  // to park the card: it stays In Progress, which is the honest record of a run
  // that started work and stopped, and the operator reads the comment.
  if (!policy.replan) {
    return [
      ...restructuring,
      '  4. Stop, and leave the card In Progress. Do not move its status: this run',
      '     was launched without re-planning, so there is no plan to submit and no',
      '     decision for anyone to make yet. Your comment is the whole report.',
      '  5. Do not pick up other work.',
    ];
  }

  return [
    ...restructuring,
    `  4. Move ${src.key} to Planning with the transition_status tool (key`,
    `     ${src.key}, status planning). That status is in the in-progress`,
    '     category, which is what actually takes the card out of the pickable set',
    '     — the card is not stuck on a dependency, it is being re-planned, and it',
    '     must not be handed out again until a human has acted on the plan.',
    '  5. Submit it for re-planning, exactly like this:',
    '',
    `         motir plan --detach ${src.key} "<what you found>"`,
    '',
    `     The leading ${src.key} anchors the thread to this card; without it you`,
    "     get a project-wide plan about one card's defect. `--detach` because you",
    '     must not sit waiting on a planner.',
    '  6. Run that command ONCE. Never retry it, even on a timeout — a submission',
    "     spends the token owner's AI credits, and a blind retry in an unattended",
    '     run costs them twice for one finding.',
    '  7. Stop. Do not pick up other work.',
  ];
}

/**
 * The THIRD branch: your card is fine, and something ELSE is broken.
 *
 * ⚠️ ITS FIRST JOB IS TO SAY IT IS NOT AN ENDING. An agent that has just found
 * something broken treats it as a reason to stop unless told otherwise, and a run
 * that abandoned a perfectly good card over a side-finding would be worse than
 * one that never looked.
 *
 * ⚠️ AND THE PARENT IS A KEY, NOT A RULE TO APPLY. The ADR's Q3 settles it — the
 * bug is parented under the in-flight card's PARENT — and the parent key is
 * already on the dispatch payload, so the text names it outright. An agent asked
 * to file something "in a sensible place" invents a place.
 */
function foundADefect(src: DispatchPromptSource, policy: FindingsPolicy): string[] {
  const heading = [
    '',
    'FOUND A DEFECT — your card is fine, and something ELSE is broken. This is NOT',
    'an ending: it does not finish your card, it does not fail it, and it does not',
    'change which of the two outcomes above you report. You record what you found',
    'and CARRY ON with the card in hand.',
    '',
  ];

  // The switch. Nothing renders in place of the branch's instructions except the
  // alternative: a comment. The finding must still reach a human — a policy that
  // turned filing off was never asking the agent to forget what it saw.
  if (!policy.logBug) {
    return [
      ...heading,
      `  This run was launched without bug filing, so do NOT create a work item.`,
      `  Comment the finding on ${src.key} instead: what is broken, how to make it`,
      '  happen, and the evidence — the command you ran and what it printed. Then',
      '  continue with your card.',
    ];
  }

  // The parent is the card's own parent; a top-level card is its own parent for
  // this purpose, because a bug with no parent lands at the project root where
  // nobody triaging this area will meet it.
  const parentKey = src.parent?.key ?? src.key;
  const parentNote = src.parent
    ? `${parentKey} — the parent of ${src.key}, the card you are working`
    : `${parentKey} — the card you are working, which has no parent of its own`;

  return [
    ...heading,
    '  1. REPRODUCE IT FIRST. Make the defect happen before you write a word about',
    '     it. A bug filed from reading the code is a claim, not an observation, and',
    '     it costs whoever picks it up the same investigation a second time.',
    '  2. File it with the create_work_item tool:',
    '',
    "         kind:      'bug'",
    `         parentKey: ${parentKey}`,
    '',
    `     That parent is not a choice: it is ${parentNote}.`,
    '     Do not look for a better home and do not invent one.',
    '  3. Its description carries three things, in this order:',
    '        - THE REPRODUCTION — what to do to make it happen.',
    '        - THE EVIDENCE — the command you ran and its output verbatim, or the',
    '          file and line you read.',
    `        - WHERE IT WAS SEEN — ${src.key}, and the branch or commit you were`,
    '          on. A number measured on an unmerged branch is not a number about',
    '          main, and saying which is the difference between a report and a',
    '          rumour.',
    `  4. Link it back: link_work_items, relationship relates_to, to ${src.key}.`,
    '     The parent says where the bug LIVES; this says where it was FOUND. It',
    '     is idempotent, and it usually IS a no-op: naming the card in step 3',
    '     already creates that edge. A "already linked" answer is success.',
    '  5. It BLOCKS NOTHING. No blocked_by edge, no sprint, no estimate. Filing is',
    '     purely additive — it claims no scope and holds nothing up — and that is',
    '     what makes it safe for an unattended run to do at all.',
    '  6. Carry on with your card and report its own outcome as above.',
  ];
}

/**
 * ONE CARD, ONE COMMIT — and what that commit message is FOR (MOTIR-2406).
 *
 * `motir auto` runs every card onto one session branch and opens ONE pull
 * request at close-out, whose body is assembled from the commits on that branch
 * (11.5.27). So the message is not bookkeeping: it is the only per-card
 * narrative that reaches a reviewer, and nobody reading the pull request opens
 * the card.
 */
function commitContract(src: DispatchPromptSource): string[] {
  return [
    '',
    'YOUR COMMIT',
    '',
    `  ONE commit for ${src.key}, and only if the work is finished. A run puts many`,
    '  cards on one branch and a reviewer reads the pull request as the list of',
    '  cards it delivers — a commit with no card behind it, from an agent that got',
    '  halfway and committed anyway, is worse than either finishing or stopping.',
    '',
    '  ⚠️ THE MESSAGE BECOMES THE PULL REQUEST. The run assembles its pull-request',
    '  body from these commit messages, so write yours for a REVIEWER WHO WAS NOT',
    '  THERE and who will not open the card. Subject: what changed. Body: why, and',
    '  whatever they need in order to decide whether to merge — including what',
    '  surfaced while you worked that the card could not have known. A subject that',
    '  restates the card title tells them nothing they cannot already see, and a',
    '  one-liner leaves the pull request with a heading and no reasoning under it.',
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
/**
 * WHICH `GIT WORKFLOW` variant this item gets — a 2×2 over the lineage and the
 * repository COUNT (`docs/decisions/dispatch-prompt-assembly.md`, *What varies,
 * and who decides*).
 *
 * Fewer than two repositories takes the shipped single-repository text, byte for
 * byte: that is the whole back-compatibility promise of MOTIR-3132, and putting
 * the choice in one function is what makes it checkable rather than asserted.
 */
function gitWorkflow(src: DispatchPromptSource, sessionBranch: string | null): string[] {
  const repos = multiRepoSet(src);
  if (sessionBranch !== null) {
    return repos
      ? multiRepoSessionLineageWorkflow(src, repos, sessionBranch)
      : sessionLineageWorkflow(src, sessionBranch);
  }
  return repos ? multiRepoPerItemPrWorkflow(src, repos) : perItemPrWorkflow(src);
}

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

  // A MANUAL item gets neither the git workflow nor the outcome protocol: it is
  // human work with no branch, no commit and no MCP session, and `motir auto`
  // skips it entirely. Its closing note already says how to report completion.
  let closing = MANUAL_CLOSING;
  if (!manual) {
    closing = [
      ...section('GIT WORKFLOW', [...gitWorkflow(src, sessionBranch), ...commitContract(src)]),
      '',
      // LAST, deliberately. The protocol is what the agent does at the end of
      // the work, and the last thing in a prompt is the thing it is holding when
      // it starts acting. Placing it earlier would leave the git workflow as the
      // final word, which is how "set the card to Implemented" becomes the step
      // that gets forgotten.
      ...section('REPORTING THE OUTCOME — say which one happened', outcomeProtocol(src)),
    ];
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
