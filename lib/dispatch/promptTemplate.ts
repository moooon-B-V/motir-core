import type { DispatchWorkflowMode } from '@/lib/dto/dispatch';
import { isAgentDecisionItem, isManualReadyItem } from '@/lib/dto/ready';
import {
  isBlockerCountAdvisory,
  isOrderingAdvisory,
  isReferenceAdvisory,
  isRepoStraddleAdvisory,
  isBodyAboveFieldMoveAdvisory,
  isSelfBlockingDesignAdvisory,
  isSizingAdvisory,
  isSubsumptionAdvisory,
} from '@/lib/dto/workItems';
import { describeBodyAboveFieldMove } from '@/lib/workItems/bodyAboveFieldMove';
import type {
  ExecutorDto,
  WorkItemDifficultyDto,
  WorkItemKindDto,
  WorkItemPriorityDto,
  WorkItemProseAdvisoryDto,
  WorkItemTypeDto,
} from '@/lib/dto/workItems';
import { splitPlanBody } from '@/lib/markdown/planBody';
import type { DesignVerdictDto } from '@/lib/dto/designAccess';
import type { MonitorIssueLinkDto } from '@/lib/dto/monitorIssueLink';

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
//      …) — a design card is told to produce a design asset, not code, and
//      whether it publishes a design result is decided by whether open work is
//      `blocked_by` it (MOTIR-5495).
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
 * WHEN a How-to-test record needs a CLICK-PATH (Story MOTIR-4906 · MOTIR-5334).
 *
 * ⚠️ THESE ARE THE RUNBOOK'S OWN WORDS, BYTE FOR BYTE — the scope sentence of
 * `motir-meta` `prompts/run.md` § *The how-to-test rule*. A person running the
 * runbook and a dispatched agent must agree on which cards owe a walk-through,
 * so the trigger has one text in two homes, and a test pins this constant to it.
 * Re-word it here and the runbook stops matching; re-word it there and the test
 * says so.
 */
export const RENDERED_SURFACE_TRIGGER =
  'creates or changes any rendered surface (a UI `type: code` subtask, or any subtask ' +
  'adding/editing a page, component, route-rendered view, modal, or interactive control)';

/**
 * The tool the FINISHED order's step 4b names. A literal, because this module is
 * a leaf that imports nothing from `lib/mcp/`; `tests/dispatch/promptTemplate.test.ts`
 * asserts it equals the REGISTERED tool name, so a rename fails there.
 */
export const HOW_TO_TEST_TOOL_NAME = 'publish_test_instructions';

/**
 * The two DESIGN tools this prompt names, and the variable the CLI sets
 * (Story MOTIR-5553 · Subtask MOTIR-5563).
 *
 * Literals, because this module is a leaf that imports nothing from `lib/mcp/`
 * — the same reason {@link HOW_TO_TEST_TOOL_NAME} is one — and
 * `tests/dispatch/promptTemplate.test.ts` asserts each against the REGISTERED
 * tool name, so a rename fails there rather than in a prompt an agent reads six
 * weeks later.
 */
export const GET_DESIGN_TOOL_NAME = 'get_design';
export const LIST_DESIGNS_TOOL_NAME = 'list_designs';

/**
 * The environment variable the CLI sets when it has put the design on disk.
 *
 * ⚠️ THE OTHER HALF OF THIS NAME LIVES IN `packages/cli/src/designFiles.ts`, and
 * the two are pinned equal by a test in this module's suite — the only place
 * both are reachable, since this file cannot import a CLI module and that
 * package cannot import `lib/`. A drift makes this prompt name a variable
 * nothing sets, which reads to the agent as *there is no design*: the failure
 * with no error message.
 */
export const DESIGN_DIR_ENV = 'MOTIR_DESIGN_DIR';

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
  /**
   * Is this run's loop willing to APPROVE a re-plan itself and carry on
   * (`motir auto --auto-approve-replan`) — MOTIR-4085.
   *
   * ⚠️ THE ODD ONE OUT, in two ways worth stating rather than inferring.
   *
   * It switches something ON, where the other two switch a capability OFF; and
   * it is not a capability of the AGENT at all. Nothing the agent may do changes
   * with it — the same two tools, the same anchor, the same one shot. What
   * changes is what happens to what it submits, which the agent cannot cause and
   * could not find out any other way.
   *
   * It is here because the prompt is the whole contract with a sandboxed agent,
   * and an agent that does not know its plan may be approved unattended cannot
   * make the one choice this policy leaves it: keep the plan inside its own
   * card's lane and the loop may approve it, or deliberately reach beyond that
   * lane — a container, a sibling story — and the plan goes to a person. Both are
   * legitimate, and an agent that believes a person will read every plan will
   * write the second kind when the first would do.
   *
   * ⚠️ AND IT IS NOT THE BOUND. The bound is the LOOP's: it reads the returned
   * plan, checks the lane, and approves or does not. This flag makes the choice
   * legible to the agent; it does not make the agent trusted.
   */
  autoApproveReplan: boolean;
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
export const FULL_FINDINGS_POLICY: FindingsPolicy = {
  logBug: true,
  replan: true,
  // ⚠️ FALSE IS THE COMPLETE PROTOCOL HERE, and it is the one field of the three
  // where the default is not "everything on". The other two default ON because
  // the full contract is what an omitted policy renders; this one defaults OFF
  // because an omitted policy means nobody asked for automatic approval, and a
  // prompt that told an agent its plan might be approved unattended when no loop
  // will approve it would be a lie in the direction that matters.
  autoApproveReplan: false,
};

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
  /**
   * The auto-approve lane (MOTIR-4085), which rides its OWN parameter rather
   * than this token list — deliberately, and the reason is the list's own
   * documented meaning: it is *what this run switches OFF*. A token that turned
   * something ON inside it would make the list two things at once, and the next
   * reader would have to know which tokens go which way. Defaults to `false`, so
   * every existing caller parses to exactly the policy it parsed to before.
   */
  opts: { autoApproveReplan?: boolean } = {},
): { policy: FindingsPolicy; unknown: null } | { policy: null; unknown: string } {
  const autoApproveReplan = opts.autoApproveReplan === true;
  const value = (raw ?? '').trim();
  if (value === '') {
    return { policy: { ...FULL_FINDINGS_POLICY, autoApproveReplan }, unknown: null };
  }

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
    policy: {
      logBug: !disabled.has('log-bug'),
      replan: !disabled.has('replan'),
      // ⚠️ CONTRADICTORY BY CONSTRUCTION, so it is resolved here rather than
      // left to each transport: approving a re-plan the agent was told not to
      // submit is not a lane, it is a nonsense. The CLI refuses the two flags
      // together at parse time (`contradictoryReplanFlags`); this is the same
      // rule for every other caller, and it fails to the SAFE side — no lane.
      autoApproveReplan: autoApproveReplan && !disabled.has('replan'),
    },
    unknown: null,
  };
}

/** One confirmed decision as a dispatched prompt renders it (MOTIR-5959). */
export interface ConfirmedDecisionForPrompt {
  key: string;
  title: string;
  /** ISO-8601 — when a person confirmed it: the date the calendar rule compares. */
  decidedAt: string;
  /** The body's `## Decision` section. */
  decisionMd: string;
  /** The body's `## Resulting direction` section — the epic's direction in full. */
  resultingDirectionMd: string;
}

export interface DispatchPromptSource {
  /** The `PROD-<n>` identifier. */
  key: string;
  title: string;
  kind: WorkItemKindDto;
  type: WorkItemTypeDto | null;
  executor: ExecutorDto | null;
  /**
   * How HARD the work is to reason about (Story MOTIR-6016). Stated in ONE fact
   * line when set; when `null` the prompt says nothing about it at all — no
   * `unset` placeholder, unlike type and executor, so a leaf without one gets
   * exactly the prompt it got before the field existed.
   */
  difficulty: WorkItemDifficultyDto | null;
  priority: WorkItemPriorityDto;
  storyPoints: number | null;
  estimateMinutes: number | null;
  /** The raw Markdown body — partitioned here into narrative / acceptance
   *  criteria / context refs (`splitPlanBody`). */
  descriptionMd: string | null;
  /** The `PROD-<n>` keys of this item's `is_blocked_by` dependencies. */
  blockerKeys: string[];
  /**
   * The OTHER direction (MOTIR-5495): the keys of the open work items that are
   * `blocked_by` THIS item — not archived, status outside the `done` category —
   * ascending. A design card carries the publish step only when this is
   * non-empty, because the server refuses a design result nothing waits on
   * (`designEvidenceService.findWaitingDependentIds`, the one read both use).
   */
  openDependentKeys: string[];
  /**
   * The DESIGNS this card waits on (Story MOTIR-5553 · Subtask MOTIR-5563) —
   * one verdict per work item it is `blocked_by` whose type is `design`,
   * resolved by `designAccessService` and never re-derived here.
   *
   * EMPTY renders nothing at all, which is the ordinary case: most cards wait on
   * no design. It is the ABSENCE that the `code` steps then handle, by telling
   * an agent about to build a rendered surface to go and look.
   */
  designReference?: DesignVerdictDto[];
  /**
   * The CONFIRMED DECISIONS on this card's epic (Story MOTIR-5871 · Subtask
   * MOTIR-5959; ADR `approval-gates.md` §1's MOTIR-5952 amendment, points 9–10) —
   * every `human` decision under the nearest `epic` ancestor whose confirm gate was
   * approved, OLDEST confirmation first. Overturned and awaiting decisions are never
   * here: one governs nothing, the other is not yet agreed.
   *
   * EMPTY renders nothing at all — the normal case, since most epics carry no
   * decision, and a block saying so on every prompt is a block agents skip.
   */
  confirmedDecisions?: ConfirmedDecisionForPrompt[];
  /**
   * The ERRORS linked to this work item (Story MOTIR-5975 · Subtask MOTIR-5982)
   * — every monitor link with its stored facts and evidence, as
   * `monitorIssueService.listForWorkItem` returns them: read from Motir's store,
   * never from the monitor. Omitted or EMPTY renders the prompt byte-identical
   * to one without the field, which is every card that is not a monitor bug.
   */
  errorEvidence?: MonitorIssueLinkDto[];
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
   * The RUN TARGET's key when this item is dispatched as part of a run launched
   * against ANOTHER item — a scoped run's scope (Story MOTIR-4906 · MOTIR-5334).
   * Omitted, null, or equal to {@link key} means this item IS its own run target,
   * so its agent publishes How to test on it. Otherwise the run's close-out step
   * publishes on the target and this agent is told not to.
   */
  runTargetKey?: string | null;
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
    `   ⚠️ If this change ${RENDERED_SURFACE_TRIGGER}`,
    '   and NO DESIGN REFERENCE is listed in CONTEXT above, do not draw it from',
    `   imagination: look first with the ${LIST_DESIGNS_TOOL_NAME} tool (\`blockersOf\` this`,
    '   card, then the project’s designs by path). If an approved design draws the',
    '   surface, build to it. If nothing does, STOP through THE CARD IS WRONG below and',
    '   ask for a `type: design` card beside this one, with this card blocked_by it.',
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
    '3. Produce the design asset set for the surface — TWO files, the area’s',
    '   design-notes.md and a <surface>.mock.html — composed from the real design',
    "   system's primitives and tokens, never a raw hex colour or a fixed radius.",
    '   Nothing else: no screenshot export, and no Pencil source.',
    '4. If the surface ALREADY has a design, do not edit its mock. Draw the change',
    '   in a NEW <surface>--<change>.mock.html holding only the panels that change,',
    '   and add a new notes section citing the section and the mock it amends. An',
    '   older mock is a record of its moment, not a specification to keep current.',
    '5. Draw the ACCESS PATH: the affordance in the parent surface that opens this',
    '   one. Naming the route in prose is not enough — the reader must see the door.',
    '6. Stop at the asset. A design is reviewed before anything is built on it.',
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
  // ⚠️ THE PATH, THE COUNT AND THE PULL REQUEST ARE WHAT THE DECISION GATE READS
  // (Story MOTIR-4907 · MOTIR-5682; `approval-gates.md` §8's FIFTH AMENDMENT). The
  // gate asks a person about the ONE `docs/decisions/*.md` file the card's pull
  // request adds or modifies, captured at its head (MOTIR-5674). A document written
  // anywhere else, or two of them, leaves a gate nobody can approve and a merge
  // held — on a run that did everything else right. A `human` decision card never
  // reaches this lane: `isManualReadyItem` sends it to the manual steps.
  //
  // ⚠️ AND THE COUNT IS NOT THE SUBJECT, NOR THE SCOPE (MOTIR-6194). Clause 3 makes
  // the FILE the gate's subject, so WHICH file is what the person is being asked to
  // approve — and steps 3a/3b are the two rules this lane shipped without. The arm
  // *"or modified if the decision amends an existing record"* said an existing
  // record MAY be the target and never said which one, and *"Change no other file"*
  // bounds the COUNT while leaving one file rewritable without limit. Both holes are
  // satisfied completely by a run that does everything else right: MOTIR-6157's
  // decision about MCP-authored plans was written into `approval-gates.md` — the
  // record whose clause it CONTRADICTS — rather than `agent-authored-plans.md`, the
  // record that OWNS its subject, and went on to settle a question the card never
  // asked. Thirteen CI lanes were green and the one-file rule held, because it WAS
  // one file. The runbook's own half of this rule is `motir-meta` `prompts/run.md`
  // step 5b; the two are kept in step because neither side can detect the other's
  // absence.
  decision: [
    '1. Read the card description above for the decision to be made and its',
    '   constraints, and verify each constraint against the shipped code.',
    '2. Lay out the real options with their trade-offs, then DECIDE — a decision card',
    '   ships a decision, not a survey.',
    '3. Record it as EXACTLY ONE markdown file at docs/decisions/<kebab-slug>.md in',
    "   this card's target repository — added, or modified if the decision amends an",
    '   existing record. Follow the shape the records there already use (Status →',
    '   Context → Decision → Consequences), capturing the context, the choice, the',
    '   alternatives rejected, and the consequences. Change no other file under',
    '   docs/decisions/: the gate reads exactly one, and two cannot be approved.',
    '   If this card pins NO repository, STOP and say so in a comment on it: the',
    '   record has no home, and picking one is a planning decision, not yours.',
    '3a. WHICH file — the record goes where its SUBJECT lives, and the file IS what',
    '   the gate asks a person to approve. Name it from the thing being DECIDED, not',
    '   from the text the decision contradicts. DEFAULT to a new',
    '   docs/decisions/<kebab-slug>.md named for the decision; modify an EXISTING',
    '   record only when that record already OWNS this subject — when a reader with',
    '   this question would open that file to answer it — AND only when that file is',
    '   small enough to be READ AS ONE QUESTION. The gate hands the reviewer the',
    '   WHOLE file, not your diff: its subject is <owner/name>:<path>@<blobSha>, and',
    '   a decision document has no publish call, so the pull request head is the',
    '   only lever you have. A decision buried at line 3,495 of an ADR is reported',
    '   as MISSING, because unreadable and absent look the same. A decision that',
    '   contradicts a clause in some OTHER record does not belong in that record: it',
    '   is written where it belongs, and the clause it falsifies is cited by name.',
    "3b. HOW MUCH — the record is BOUNDED by this card's own decision. Write what",
    '   this card decided and nothing else. Do not settle a neighbouring question,',
    '   do not retire copy, keys or clauses the card did not name, and do not repair',
    '   what is merely wrong AROUND the part you came to write. Every one of those',
    '   reads as diligence, none of them was approved, and all of them are invisible',
    '   to the one-file rule. Something else wrong in that file is a bug to log.',
    '3c. End the record with a "What this does NOT decide" section naming the',
    '   questions a reader could think it settled and it does not. That section is',
    "   what makes the record's scope checkable at the gate instead of inferable.",
    '4. Open a pull request carrying that file and link it to this work item, as',
    '   every lane does. The pull request is REQUIRED — it is how the decision reaches',
    '   the person who accepts it.',
    '   It is a pull request of its OWN, off main, and this work item is the ONLY one',
    '   linked to it. Never integrate the file into a session branch, and never link',
    "   a session branch's pull request to this work item: approving the decision",
    '   authorises the merge of every pull request linked to it.',
    '5. The decision is NOT final when your run ends. A person reads the document in',
    '   Motir and approves it; only then does the pull request merge. Stop at the',
    '   pull request.',
  ],
  // A `choice` is a PERSON's pick among options the planner declined to choose
  // between (taxonomy ADR Amendment 3) — its executor defaults to `human`, so
  // `isManualReadyItem` sends it to the manual steps and it is never dispatched.
  // This entry exists because the map is TOTAL and the executor is overridable:
  // an agent handed one anyway is told to stop rather than to pick.
  choice: [
    '1. Stop. This work item is a CHOICE: a person picks one of the options in its',
    '   description, in Motir, and that pick is the whole of the work.',
    '2. Do not choose an option, do not edit the options, and open no pull request.',
    '   If the options look wrong, say so in a comment on the work item.',
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

/**
 * THE DESIGN-RESULT STEP (MOTIR-5495; `docs/decisions/design-result.md`
 * AMENDMENT 4) — appended to a `type: design` card's steps, and it is one of two
 * texts chosen by the SERVER's answer to *"does an open work item wait on this
 * card?"* ({@link DispatchPromptSource.openDependentKeys}).
 *
 * ⚠️ WHY IT STOPPED BEING UNCONDITIONAL. A publish raises an approval gate, and a
 * gate is only worth a person's time when work is held up by its answer. A design
 * nothing waits on — a design defect fixed in place — is reviewed on its pull
 * request, and the server now REFUSES its result. An agent cannot reliably work
 * out on its own whether anything depends on its card; the server can, from the
 * same read the refusal uses, so the prompt never tells an agent to publish what
 * the server will turn back.
 *
 * ⚠️ AND IT NAMES NO RETIRED INPUT, even to forbid it: naming the screenshot kind
 * or the inline-note argument is how an agent learns they exist. It says which
 * two kinds to send and that nothing else goes.
 */
function designResultSteps(openDependentKeys: readonly string[]): string[] {
  if (openDependentKeys.length === 0) {
    return [
      '7. Do NOT publish a design result. No open work item is blocked_by this card,',
      '   so nothing waits on this design: its pull request is its review, and',
      '   publish_design_result would refuse the call.',
    ];
  }
  return [
    `7. PUBLISH the design result — ${openDependentKeys.join(', ')} ${
      openDependentKeys.length === 1 ? 'is' : 'are'
    } blocked_by this card, so`,
    '   work waits on this design. Commit both files, then call the',
    '   publish_design_result tool with this card’s key and exactly these assets:',
    '   each *.mock.html you drew as kind "mock" (for a change, only the new delta',
    '   mock), and the area’s design-notes.md as the one kind "note_file". Send',
    '   nothing else — the result shows the mock, with the note one link away. Do',
    '   this in the SAME iteration that produced the asset, while the files are in',
    '   front of you.',
    '',
    '   THE PUBLISHED RESULT IS THE SOURCE OF TRUTH (design-result.md AMENDMENT 5',
    '   Q1). It is what every later run is handed and what a reviewer decides on.',
    '   Committing the two files to the repository is OPTIONAL — useful where the',
    '   team keeps its designs beside the code, and never the authority. Where a',
    '   committed copy and the published result differ, the published result is',
    '   the design.',
    '',
    '   And nothing else will make this call. A design card whose result never',
    '   arrives looks exactly like one that succeeded — files written, commit',
    '   landed, checks green, card empty — so the publish is a step of this run,',
    '   not something to confirm afterwards. The call returns the evidence id:',
    '   report it, and report that the card now awaits a person’s approval.',
    '',
    '   An area note routinely runs to hundreds of kilobytes, and you cannot emit',
    '   that much base64 as a tool argument. For any file over roughly a megabyte,',
    '   call create_design_upload with this card’s key and one entry per file, PUT',
    '   each file’s bytes to the uploadUrl it returns',
    '   (curl -X PUT --upload-file <file> -H "Content-Type: <type>" "<url>"),',
    '   and then send each grant’s pathname to publish_design_result instead of',
    '   contentBase64. One publish uses one form for all of its assets.',
  ];
}

/**
 * THE ACCEPTANCE-RECEIPT STEPS (bug MOTIR-4704) — appended to a `type: test`
 * card's steps when, and only when, the card is the one that records a story's
 * acceptance video.
 *
 * ⚠️ WHY THIS IS CONDITIONAL. `type: test` is every test card there is, and the overwhelming
 * majority are ordinary regression work that must NOT be told to publish a
 * receipt — an instruction to publish something the run never recorded is worse
 * than silence, because the agent will go looking for a recording to satisfy it.
 * So the steps live here and are appended by {@link recordsAcceptanceReceipt},
 * following the conditional-advisory shape the design-gate and subsumption
 * blocks already use, rather than widening the unconditional list.
 *
 * WHAT THIS FIXES. MOTIR-4096 retired the CI uploader and said "the agent
 * publishes it" — but nothing in the product ever asked the agent to. The
 * instruction reached the run only as prose the planner had written into the
 * card body, so the runner's own dispatch prompt, which is the one thing it
 * cannot skip reading, said nothing about the deliverable the card exists to
 * produce. A design run is told by Motir; an acceptance run was told by
 * whoever wrote the card.
 */
const ACCEPTANCE_PUBLISH_STEPS = [
  '5. PUBLISH the receipt, from THIS run, while the recording is in front of you.',
  '   Two calls, because a video is far larger than a tool argument can carry:',
  '   `create_acceptance_upload` with this card’s key mints a short-lived',
  '   presigned PUT; upload the clip’s bytes straight to that URL with',
  '   `Content-Type: video/webm`; then `publish_acceptance_result` with the',
  '   `pathname` it gave you, the chapters from `chapters.json`, the `commitSha`',
  '   you recorded at, and this card’s key as `producedByKey`. Pass this card’s',
  '   key to both — a receipt belongs to the STORY, and the server resolves up.',
  '6. Confirm it landed. The call returns the receipt’s `id` and a `pending`',
  '   status; report the id, because that is what makes the publish checkable by',
  '   somebody else.',
  '',
  '   NOTHING ELSE MAKES THAT CALL. A story whose receipt never arrives looks',
  '   exactly like one that succeeded — spec green, checks green, pull request',
  '   merged, and a story nobody can watch working. A red run publishes nothing,',
  '   and that is correct: the receipt records a GREEN run or it records nothing.',
];

/**
 * Whether this card is the one that records a story's acceptance video.
 *
 * Read off the card's own text rather than a field, because there is no field:
 * what makes a test card an acceptance card is that its spec calls
 * `acceptanceStory()` and lands in the acceptance lane, and the planner states
 * that in the body it writes (motir-meta `plan-rules/kind-story.md` — every
 * user-facing story carries an E2E subtask that "records + publishes a short
 * acceptance VIDEO"). Both halves of the card are searched, since some cards
 * carry the intent only in the title.
 *
 * Deliberately NARROW. A false negative costs the run a prompt it can still get
 * from the card body it was handed; a false positive tells an ordinary
 * regression card to publish a recording that does not exist.
 */
export function recordsAcceptanceReceipt(src: {
  type: WorkItemTypeDto | null;
  title: string;
  descriptionMd: string | null;
}): boolean {
  if (src.type !== 'test') return false;
  const text = `${src.title}\n${src.descriptionMd ?? ''}`;
  return /acceptanceStory\s*\(|acceptance\s+(video|receipt)/i.test(text);
}

/**
 * The REPRODUCTION preamble for a BUG card (MOTIR-5944) — chosen by `kind`, not
 * `type`, and PREPENDED to whichever steps the type selected.
 *
 * WHY IT EXISTS. A bug card is the one card whose premise can be false while the
 * defect is real: somebody saw something fail. Without this block the only exit
 * a non-reproducing premise meets is THE CARD IS WRONG, whose first step is to
 * REVERT — so a clean probe routed an agent straight to "premise false" without
 * ever asking whether the code moved since the report, or varying a condition
 * the card did not name (MOTIR-2994: the defect was one untried condition away).
 * This is the runbook's *a bug card's FIRST deliverable is the REPRODUCTION*
 * rule (motir-meta `run.md`), in the one document a dispatched agent reads.
 *
 * ⚠️ ORDER IS THE POINT: it renders in WHAT TO DO, which precedes the outcome
 * protocol, so it is read before the exit it gates. After the exit it would
 * never be reached. Lettered, not numbered, so it does not collide with the
 * type's own step 1.
 */
const BUG_REPRODUCTION_STEPS = [
  'THIS IS A BUG CARD. Before step 1, REPRODUCE THE DEFECT — and do it before you',
  'decide the card is wrong. A report that will not reproduce is not yet a false',
  'premise:',
  '',
  'a. Reproduce at the REPORTER’S BASE, not at HEAD: the branch or commit the card',
  '   names (if it names none, the last main commit before the card was filed),',
  '   with the data setup and the screen, endpoint or command the card names.',
  'b. It will not reproduce? One command separates two opposite findings:',
  '   `git log <reporter’s base>..HEAD -- <the paths that serve it>`. Empty means',
  '   nothing changed, so it was NEVER reproduced; non-empty means read those',
  '   commits first — it may have been fixed in between.',
  'c. A non-reproduction obliges the MATRIX, not the verdict. List the conditions',
  '   the card’s premise holds fixed (timing, concurrency, input shape, empty vs',
  '   populated, a missing or unresolvable value, …) and VARY each one. A passing',
  '   condition measures only that condition. Put the results table — passing rows',
  '   included — in the pull request body, and do not report the defect as absent',
  '   while the original observation is unexplained. "Widened to N conditions,',
  '   still unexplained" is an honest result.',
  'd. Only after a–c may a falsified premise go to THE CARD IS WRONG below.',
  '',
];

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
  const bodyAbove = advisories.filter(isBodyAboveFieldMoveAdvisory);
  const blockerCounts = advisories.filter(isBlockerCountAdvisory);
  const lines: string[] = [];

  if (blockerCounts.length > 0) {
    lines.push(
      '',
      "A COUNTED CLAIM ABOUT THIS CARD'S BLOCKERS DISAGREES WITH THE GRAPH:",
      ...blockerCounts.map(
        (a) =>
          `    - "${a.claim}" says ${a.claimedCount}; the graph holds ${a.blockerCount} blocked_by edge${a.blockerCount === 1 ? '' : 's'}.`,
      ),
      '  Check which side is stale before relying on the prose. Update the card body when the',
      '  graph is authoritative; wire the missing edge when the dependency is real.',
    );
  }

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
  // is where the cost lands, and it goes in the prompt rather than only in the
  // tool summary because the prompt is the one surface every harness inherits.
  //
  // ⚠️ IT NEVER STOPS THE RUN (MOTIR-5372, docs/decisions/over-gate-sizing-never-stops-a-run.md).
  // This block used to say "Propose the split and STOP". A size is an estimate,
  // and a card stuck on a sizing reason is a dead end for a non-technical user,
  // while a large pull request is recoverable. So the agent is told the card is
  // over the gate, told to say so in its report, and told to build it.
  if (oversized.length > 0) {
    lines.push(
      '',
      'THIS CARD IS SIZED PAST THE ESTIMATION GATE — build it anyway, and say so in your report:',
      ...oversized.map(
        (a) =>
          `    - ${a.storyPoints ?? '—'} story points / ${a.estimateMinutes ?? '—'} estimated` +
          ` minutes, over ${a.threshold === 'both' ? 'BOTH ceilings' : a.threshold === 'story_points' ? 'the 8-point split signal' : 'the 70-minute estimate threshold'}.`,
      ),
      '  This is a WARNING, never a reason to stop: do NOT halt the run, propose a split',
      '  instead of building, or hand the card back. Build every acceptance criterion as usual.',
      '  In your final report (and the PR description), state that the card was sized over the',
      '  estimation gate, with the numbers above, so a planner can size similar work smaller',
      '  next time. If the numbers are plainly wrong for what the card asks, you may correct',
      '  them on the record as well.',
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

  // THE BODY-EDIT-ABOVE-FIELD-MOVE finding (MOTIR-5399). Addressed to the agent
  // because the agent is the first party that can notice: MOTIR-4513's fields said
  // `content` and its body, rewritten after them, said `decision`, and every
  // channel above reported the card healthy until the run built on it and stopped.
  // A prompt to re-read — the trail cannot tell a revert from a matching rewrite —
  // so it never tells the agent to stop, only where to look.
  if (bodyAbove.length > 0) {
    lines.push(
      '',
      "THIS CARD'S BODY WAS WRITTEN AFTER ITS FIELDS LAST MOVED — read both before you start:",
      ...bodyAbove.map((a) => `    - ${describeBodyAboveFieldMove(a)}.`),
      '  Re-read the description and explanation against the fields that write moved (the',
      '  card header above shows their current values). A body rewritten to MATCH the move is',
      '  the ordinary correction: proceed. If the body instead describes the card as it was',
      "  BEFORE the move — another type, another executor, another repo — the card's fields and",
      '  prose disagree: build to the FIELDS, which are what dispatch, review and the ready set',
      '  read, and name in your report the sentences of the body that contradict them.',
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

/**
 * The DESIGN REFERENCE block (Story MOTIR-5553 · Subtask MOTIR-5563) — what this
 * card is supposed to be built against, and what to do when there is nothing.
 *
 * ⚠️ IT RENDERS FOR EVERY TYPE, not only for UI code. A design decides more than
 * pixels: which element owns which behaviour, what a surface is allowed to
 * assume. A service card whose design blocker moved is as wrong as a component
 * card, and it is the one least likely to go looking.
 *
 * ⚠️ AND AN EMPTY LIST RENDERS NOTHING. Most cards wait on no design, and a
 * block saying so on every one of them is a block agents learn to skip — which
 * is exactly the block that must be read on the cards that do have one. The
 * ABSENCE is handled where it bites instead, in the `code` steps.
 */
function designReferenceSection(verdicts: readonly DesignVerdictDto[]): string[] {
  // ⚠️ A `not_a_design_card` VERDICT IS DROPPED HERE, and the asymmetry with the
  // service is deliberate. `designAccessService` answers for EVERY blocker,
  // including the ones that are not design cards, because an API caller asking
  // *what designs does this card wait on* is entitled to be told that a blocker
  // it expected to be a design is not one. An AGENT is not: almost every card
  // has a non-design blocker, so rendering those would put a DESIGN REFERENCE
  // block on almost every prompt, filled with lines saying nothing — and a block
  // that is usually noise is a block agents learn to skip, which is exactly the
  // block that must be read on the cards that do have a design.
  const relevant = verdicts.filter(
    (v) => v.verdict === 'approved' || v.reason !== 'not_a_design_card',
  );
  if (relevant.length === 0) return [];

  const lines: string[] = ['', 'DESIGN REFERENCE — what this card is built against'];
  const approved = relevant.filter((v) => v.verdict === 'approved');
  const refused = relevant.filter((v) => v.verdict !== 'approved');

  for (const verdict of approved) {
    if (verdict.verdict !== 'approved') continue;
    const { design } = verdict;
    lines.push(
      '',
      `  ${verdict.designCardKey} — ${verdict.designCardTitle}`,
      `    APPROVED, version ${design.evidenceId}`,
    );
    for (const asset of design.assets) {
      lines.push(
        asset.state === 'available'
          ? `      ${asset.kind}  ${asset.sourcePath}`
          : `      ${asset.kind}  ${asset.sourcePath}  (UNAVAILABLE — this approved ` +
              'version’s files were reclaimed; it is still the approved design)',
      );
    }
    lines.push(
      `    WHERE THE FILES ARE: if $${DESIGN_DIR_ENV} is set in your environment, they are`,
      `    already on disk at $${DESIGN_DIR_ENV}/${verdict.designCardKey}/<sourcePath>. If it is`,
      `    NOT set, fetch them NOW with the ${GET_DESIGN_TOOL_NAME} tool on`,
      `    ${verdict.designCardKey} — its links expire within minutes, so download them before`,
      '    you read or plan anything, into a directory OUTSIDE the repository checkout so',
      '    the design never lands in your diff.',
    );
  }

  if (approved.length > 0) {
    lines.push(
      '',
      '  HOW TO READ A MOCK. Open the *.mock.html SOURCE, not a rendering of it, and',
      '  read EVERY panel: a mock is usually a multi-panel board (closed vs open, empty',
      '  vs populated), and a single view hides elements the source names. A file whose',
      '  name carries `--` is a DELTA mock: it holds only what CHANGED about an earlier',
      '  surface, and its note section names the mock it amends — fetch that base with',
      `  ${LIST_DESIGNS_TOOL_NAME} using its path as \`pathPrefix\`, and read both.`,
    );
  }

  for (const verdict of refused) {
    if (verdict.verdict !== 'not_approved') continue;
    lines.push(
      '',
      `  ${verdict.designCardKey} — ${verdict.designCardTitle}`,
      `    NO APPROVED DESIGN (${verdict.reason}). This card waits on that design card,`,
      '    and it has no approved result to build against.',
    );
  }

  lines.push(
    '',
    '  ⚠️ THE DESIGN GATE — CHECK IT BEFORE YOU BUILD ANYTHING VISIBLE.',
    '  Your blockers being done means the design CARD is finished. It does not mean a',
    '  design exists, and it does not mean the design draws what you have to build. So',
    '  look, and STOP in either of these two cases:',
    '',
    '    (a) any design above is NOT approved; or',
    '    (b) you must build an ELEMENT no approved design draws — a whole panel,',
    '        control, section or screen. An unspecified DETAIL is not this: a hover',
    '        tint, a focus ring, an obvious empty-state string are yours to decide from',
    '        the design system. A piece of UI nobody drew is not.',
    '',
    '  In either case do NOT build it and do NOT draw it yourself. Stop through THE CARD',
    '  IS WRONG below, and ask for a NEW `type: design` card placed BESIDE this card —',
    '  the same parent, never a child of it — that `relates_to` the design card(s) named',
    '  above, with this card `blocked_by` it. The old design card stays done: it is the',
    '  record of what was decided, not a slot to overwrite.',
  );
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
  // Named as REASONING, not size, so an agent does not read `high` as "big".
  if (src.difficulty !== null) {
    facts.push(`- Difficulty: ${src.difficulty} — the reasoning this work demands, not its size`);
  }

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

  // The DESIGN this card is built against (MOTIR-5563) — beside the advisories
  // and for the same reason: something the agent must know BEFORE it starts,
  // not something it would find by reading the card body.
  facts.push(...designReferenceSection(src.designReference ?? []));

  // The epic's CONFIRMED DECISIONS and the calendar rule (MOTIR-5959) — beside the
  // design reference and for the same reason: the direction the work was agreed to
  // take is something the agent must know BEFORE it starts.
  facts.push(...confirmedDecisionsSection(src.confirmedDecisions ?? []));

  facts.push('', 'CARD DESCRIPTION');
  facts.push('', narrative.length > 0 ? narrative : '(The card carries no description body.)');
  return facts;
}

/**
 * THE EPIC'S CONFIRMED DECISIONS, and the CALENDAR RULE that says how to read them
 * (Story MOTIR-5871 · Subtask MOTIR-5959; ADR `approval-gates.md` §1's MOTIR-5952
 * amendment, point 10).
 *
 * ⚠️ A confirmed decision is auditable INTENT, not enforcement. The instruction
 * exists because the other reading — treat the decision as law — would have an
 * agent "fix" code a person changed later on purpose, turning a record into a
 * regression. So the section tells the agent to DATE the contradiction before it
 * acts, and to REPORT a newer contradicting code path rather than change it.
 *
 * EMPTY renders nothing: most epics carry no decision.
 */
function confirmedDecisionsSection(decisions: readonly ConfirmedDecisionForPrompt[]): string[] {
  if (decisions.length === 0) return [];
  const lines: string[] = [
    '',
    'CONFIRMED DECISIONS ON THIS EPIC — the direction a person agreed, oldest first',
  ];
  for (const decision of decisions) {
    lines.push(
      '',
      `  ${decision.key} — ${decision.title}`,
      `    confirmed ${decision.decidedAt}`,
      '    Decision:',
      ...indent(decision.decisionMd, '      '),
      '    Resulting direction:',
      ...indent(decision.resultingDirectionMd, '      '),
    );
  }
  lines.push(
    '',
    'HOW TO READ THEM — the calendar rule:',
    '  - A confirmed decision is the direction agreed for work NOT YET DONE. Where a',
    '    decision is NEWER than the code it describes, the decision governs your work.',
    '  - Where the code you are reading CONTRADICTS a decision, date that code first:',
    '    `git log -1 --format=%cI -- <path>`. If it was committed AFTER the decision was',
    '    confirmed, the code is what IS — a person changed it later. DO NOT change it to',
    '    match the decision. REPORT the contradiction instead: the decision key, the path',
    '    and the commit date, in your pull request body AND in a comment on this card —',
    '    then carry on with the card’s own scope.',
    '  - The latest decision restates the whole direction; an earlier one explains why',
    '    something shipped. Read them in order, and never undo shipped work on the',
    '    strength of an older decision alone.',
  );
  return lines;
}

function indent(markdown: string, prefix: string): string[] {
  const body = markdown.trim();
  return (body.length > 0 ? body : '(empty)').split('\n').map((line) => `${prefix}${line}`);
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
 * commit, push, open a pull request — and then LINK it.
 *
 * ⚠️ CORRECTED (Story MOTIR-3525 · MOTIR-3529). This docstring used to end
 * *"open a pull request whose TITLE carries the key. The key in the title is the
 * load-bearing part and the one an agent would most plausibly drop — the
 * completion gate counts merges against the item's LINKED pull requests, so a
 * pull request without it is invisible to the gate and the card is held forever
 * by work that has actually shipped."*
 *
 * That account of the STAKES was right and is kept: the completion gate does
 * count merges against the item's LINKED pull requests, a pull request the gate
 * cannot see does hold a card open on work that shipped, and it is exactly the
 * thing an agent would most plausibly drop. What was wrong was the MECHANISM. A
 * title is a string somebody typed, and hoping `resolveChangeRequestWorkItem`
 * parses it back out fails in both directions — a dropped key is invisible, and
 * a merely MENTIONED key closes a card the pull request never delivered.
 *
 * `link_pull_request` (MOTIR-3526) is the mechanism now: the agent DECLARES the
 * link at the one moment it knows the answer with certainty. The key stays in
 * the branch and the title as a LABEL, for a human reading a list. Do not
 * restore the title rule from the paragraph above — its reasoning is preserved
 * here precisely so the next reader does not re-derive it.
 *
 * ⚠️ AND `resolveChangeRequestWorkItem` NO LONGER EXISTS (MOTIR-3674): the parse
 * is retired at both its call sites, so the title is not even a fallback now.
 * An unlinked pull request associates with nothing at all.
 *
 * ⚠️ EXTENDED, NOT REPLACED (MOTIR-3678), and the instruction above holds with
 * MORE force than when it was written. The paragraph the older rule is quoted in
 * exists so that a reader who meets `link_pull_request` and thinks *"surely the
 * title still works as a backstop"* finds the answer here instead of re-deriving
 * it. Retiring the parse makes that re-derivation newly tempting — a mechanism
 * that is gone leaves no error message behind, so the only trace of it is this
 * paragraph. **Do not restore the title rule, and do not delete the record of
 * it.** What replaces the fallback is not silence but a RED CHECK: an unlinked
 * pull request fails `Motir / work item link` (MOTIR-3675), which is where a
 * person now learns what the title used to do for them.
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
      `  6. Push the branch and open a pull request against ${repo.defaultBranch ?? 'main'}.`,
      `     Put ${src.key} in the TITLE as well, as a label for a human reading a`,
      '     list — it is not what links the pull request.',
      ...linkingStep(src, branch, 7, {
        indent: '  ',
        baseRef: repo.defaultBranch ?? 'main',
        trailer: [
          'ONCE PER REPOSITORY — each repository has its own pull request, so each',
          'needs its own call; the item completes only when they have all merged.',
        ],
      }),
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
    'Do NOT open a pull request OF YOUR OWN in any repository. The session branch has',
    'one review surface per repository, and the run opens it at the first item that',
    'reaches Implemented there — so it usually already exists by the time you get',
    `here (\`gh pr list --head ${sessionBranch}\`). If a repository you touched has`,
    'none yet, you are the first: open it from that branch, targeting its default',
    'branch.',
    '',
    'Then, in EACH repository whose session pull request you found or opened:',
    ...linkingStep(src, sessionBranch, 1, {
      trailer: [
        'ONCE PER REPOSITORY, and once per item — several items link the same session',
        'pull request, which is exactly what the delivery table records.',
      ],
    }),
  );
  return lines;
}

/**
 * THE LINKING SENTENCE — one text, every grammar (Story MOTIR-3672 · MOTIR-3678).
 *
 * `docs/decisions/work-item-delivery-links.md` settled that `link_pull_request`
 * stays SINGLE-KEY and is called ONCE PER ITERATION in every lane, and it wrote
 * the agent instruction out in full precisely so there would be nothing to infer:
 *
 *   > **When your work is committed and the pull request exists, call
 *   > `link_pull_request` with your card and that pull request.**
 *
 * ⚠️ NO GRAMMAR BRANCH, and that is the point rather than an economy. A per-lane
 * variant asks the agent to work out which lane it is in before it can follow an
 * instruction, and an agent that has to infer its lane infers other things too.
 * `motir auto` opens its pull request at the first implemented card and reuses
 * it, so there is no lane in which the association is deferred or guessed — which
 * is what makes one sentence sufficient.
 *
 * {@link LINKING_RATIONALE} is the part that carries the MEANING and it is a
 * constant with no interpolation, so it renders byte-identically wherever it
 * appears; only the step number, the branch and the base ref differ. A test
 * asserts every grammar contains it verbatim, so an edit to one cannot drift
 * from the others (MOTIR-3678 AC 5).
 */
export const LINKING_RATIONALE = [
  'The link is the ONLY thing that associates a pull request with a card.',
  'There is no fallback: the key in the branch and in the title is a LABEL for a',
  'human reading a list, and Motir does not parse it. An unlinked pull request',
  'moves no card when it merges, AND fails a check named "Motir / work item link"',
  'whose text repeats this call. If you see that check red, this step is what',
  'clears it — it goes green on the link itself, so you do not need to push again.',
];

/** The linking STEP, in the shape the surrounding list needs: `indent` for the
 *  per-repository blocks, which are nested one level. */
export function linkingStep(
  src: DispatchPromptSource,
  branch: string,
  stepNumber: number,
  opts: { indent?: string; baseRef?: string; trailer?: string[] } = {},
): string[] {
  const pad = opts.indent ?? '';
  const body = pad + '   ';
  return [
    `${pad}${stepNumber}. LINK it: call the link_pull_request tool with key ${src.key} and the`,
    `${body}pull request (its URL, or repository + number), plus headRef ${branch}`,
    `${body}and baseRef ${opts.baseRef ?? 'main'}. Do this in the SAME iteration that did`,
    `${body}the work, while the pull request is in front of you — not at the end of`,
    `${body}the run.`,
    ...(opts.trailer ?? []).map((l) => `${body}${l}`),
    '',
    ...LINKING_RATIONALE.map((l) => `${body}${l}`),
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
    '5. Push the branch and open a pull request against main. Put',
    `   ${src.key} in the TITLE as well — a human scanning a pull-request list`,
    '   reads it there — but the title is a LABEL, not what links the pull',
    '   request. Step 6 is what links it.',
    ...linkingStep(src, branch, 6),
    '7. STOP at the open pull request. Do not merge it and do not delete the branch.',
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
    '7. Do NOT open a pull request of your own. The session branch has ONE review',
    `   surface: a pull request from ${sessionBranch}, which the run opens at the`,
    '   first item that reaches Implemented in this repository. So by the time you',
    '   are reading this it USUALLY ALREADY EXISTS — find it with',
    `   \`gh pr list --head ${sessionBranch}\`. If it does not exist yet, you are the`,
    '   first: open it, from that branch, targeting main.',
    ...linkingStep(src, sessionBranch, 8),
    '9. STOP. Do not merge that pull request and do not delete the branch.',
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
function outcomeProtocol(src: DispatchPromptSource, sessionBranch: string | null): string[] {
  const policy = src.findingsPolicy ?? FULL_FINDINGS_POLICY;
  // ⚠️ THIS BLOCK USED TO CONTRADICT THE SESSION-LINEAGE GRAMMAR, IN ONE PROMPT
  // (found while running MOTIR-3655, fixed here by MOTIR-3678). It renders for
  // BOTH grammars and took only `src`, so it could not vary — and it said
  // *"3. open the pull request"* to an agent whose git workflow three sections
  // earlier said *"do NOT open a pull request for this item"*. An agent handed
  // both has no coherent instruction, and what it does then is not predictable.
  //
  // The fix is the parameter, not a second protocol: the ORDER is the same in
  // both lanes and the order is what this section is for. What differs is one
  // line — whether the pull request is something you open or something the run
  // has already opened — so that line varies and nothing else does.
  const finished = sessionBranch
    ? [
        '    3. find the session pull request for this repository',
        `       (\`gh pr list --head ${sessionBranch}\`), or open it from that branch if`,
        '       you are the first item to reach this point in it',
      ]
    : openPullRequestStep(src);
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
    sessionBranch
      ? `    2. integrate into ${sessionBranch} and push that branch`
      : '    2. push the branch',
    ...finished,
    `    4. link it with the link_pull_request tool (key ${src.key}, and that`,
    '       pull request) — once per repository if this item ships in more than',
    '       one. The link is the only association a pull request has; the key in',
    '       the branch and the title is a label Motir does not parse.',
    ...howToTestStep(src),
    `    5. move ${src.key} to Implemented with the transition_status tool`,
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
 * Step 4b of the FINISHED order — publish the RUN's HOW TO TEST onto the RUN
 * TARGET (Story MOTIR-4906 · MOTIR-5334; `docs/decisions/approval-gates.md` §9
 * and its 2026-09-13 amendment: per RUN, on the run target, before the run
 * finishes; the pull-request body keeps its own section).
 *
 * ⚠️ WHO PUBLISHES DEPENDS ON WHAT THE RUN WAS LAUNCHED AGAINST. A card dispatched
 * on its own — or as one card of an unscoped batch — IS its run target, so its
 * agent publishes on its own key. A card dispatched inside a SCOPED run is one
 * child of a target this agent cannot see whole, so it does NOT publish: the run's
 * close-out step does, once, for the target (MOTIR-5357). Asking every child as
 * well would produce fragments on the wrong cards.
 *
 * ⚠️ THE STEP IS UNCONDITIONAL ON A RUN TARGET THAT OPENS A PULL REQUEST; ONLY THE
 * CLICK-PATH IS GATED by {@link RENDERED_SURFACE_TRIGGER}. "Run it locally" and
 * "what CI proved" apply to every change; only a visible change has a click-path.
 *
 * ⚠️ BEFORE `implemented`, AND A REFUSAL DOES NOT BLOCK IT. The reviewer's
 * evidence should exist when the card says it is ready for them; but a card stuck
 * in progress over a missing note is worse than the honest *record missing* state
 * the item page renders, naming this run.
 *
 * ⚠️ "ONCE" IS PER VERSION OF THE STEPS, NOT PER RUN (MOTIR-6065). How to test is
 * written for the WORK ITEM, not for a commit, so a later commit that changes a
 * step it describes owes a re-publish, and one that changes none owes nothing.
 * The item page no longer flags a record whose commit the pull request has moved
 * past — the agent that made the commit is the only party that knows whether the
 * steps moved. The CLI's CI-fix prompt (`renderFixPrompt`) carries the same duty
 * for the commits a fixing agent pushes after this run hands over.
 *
 * Rendered only where the outcome protocol renders — a MANUAL item opens no pull
 * request and gets no protocol at all, so it gets no step.
 */
function howToTestStep(src: DispatchPromptSource): string[] {
  if (src.runTargetKey && src.runTargetKey !== src.key) {
    return [
      `    4b. do NOT publish How to test for ${src.key}. This item is part of a run`,
      `        launched against ${src.runTargetKey}; How to test for that run is written`,
      `        once, onto ${src.runTargetKey}, by the run's close-out step.`,
    ];
  }
  // ⚠️ A DECISION CARD HAS NOTHING TO RUN (Story MOTIR-4907; design review 2026-09-19,
  // `design/github/design-notes.md` § 27 *Revised on review*). Its deliverable is the
  // document, and the decision gate's port draws the document with the pull request
  // beneath it and NO How-to-test part — so a record written here would be one nobody
  // is ever shown.
  if (src.type === 'decision') {
    return [
      `    4b. do NOT publish How to test for ${src.key}. A decision card ships a document,`,
      '        not something to run: the person approving reads the decision document',
      '        itself, and the decision gate shows no How to test.',
    ];
  }
  return [
    `    4b. publish this run's HOW TO TEST with the ${HOW_TO_TEST_TOOL_NAME} tool —`,
    `        ONCE, on ${src.key} (this item is the run's target). "bodyMd" is RICH TEXT`,
    '        (Markdown) with sections: the precondition (the sign-in, role, or data',
    '        the surface needs), local setup after checking out the branch (install,',
    '        migrate, seed, run), and the click-path. Put EVERY command in its own',
    '        fenced code block — the reviewer copies it with one click. Motir fills in',
    '        the branch fetch itself — do not include it. Give one "repos" entry per',
    '        repository you pushed to (that repository, commitSha = its pushed head),',
    '        and a previewPath when there is one.',
    `        If this change ${RENDERED_SURFACE_TRIGGER},`,
    '        include the click-path section. Otherwise say in the body why there is',
    '        none, e.g. "no rendered surface changed: a service and its tests".',
    '        If the publish is refused, say so in your FINISHED report and still do',
    '        step 5 — a refused publish does not prevent the transition.',
    `        How to test belongs to ${src.key}, not to a commit. If a later commit`,
    '        in this run changes anything it describes — a precondition, a setup,',
    '        migrate or seed command, a click-path step — publish it again with',
    '        the whole corrected text (the new version supersedes; the old one',
    '        stays as history). A commit that changes none of them needs no new',
    '        publish.',
  ];
}

/**
 * Step 3 in the per-item lane — the pull request this agent OPENS carries a
 * `## How to test` section in its body (Story MOTIR-4906 · MOTIR-5334). The
 * record on the work item is what Motir renders; the body is what a reviewer on
 * the host reads, and §9's amendment keeps both.
 */
function openPullRequestStep(src: DispatchPromptSource): string[] {
  // A decision card's pull request carries the document and nothing to run (see
  // `howToTestStep`), so its body names the document instead of a How to test.
  if (src.type === 'decision') {
    return [
      "    3. open the pull request. Its body names the decision document's path and",
      '       says in one line what it decides. It carries NO "## How to test" section:',
      '       there is nothing to run.',
    ];
  }
  return [
    '    3. open the pull request. Its body carries a "## How to test" section with',
    '       the SAME Markdown step 4b publishes on the run target — its sections and',
    '       its fenced commands. Write both.',
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
 *
 * ── THE AGENT COMPOSES THE WHAT (Story MOTIR-3942 · MOTIR-4083) ─────────────
 *
 * The submit used to be ONE shell command — `motir plan --detach <KEY>` — and it
 * sent a key and nothing else. The evidence went into a comment a person reads;
 * the planning job got an identifier, and the first thing a triggered re-plan
 * then did was open a conversation to ask what was wrong — a question whose
 * answer existed and was discarded when the agent exited.
 *
 * Three things about the replacement, each decided rather than incidental:
 *
 *   1. THE DOOR IS THE MCP TOOL. Every other instruction in this branch is a tool
 *      call (`transition_status` four lines up); the one shell-out was the odd
 *      one, and the agent could always have called `submit_plan_session` — it
 *      asserts `ai:plan`, which `CLI_TOKEN_GRANT` carries. Two calls replace one
 *      command line: `append_plan_turn` puts the prose on the thread the web
 *      panel shows, `submit_plan_session` sends it — and carries the WHAT.
 *   2. THE WHAT IS A STRUCT, NOT PROSE. motir-ai's `SettledRequirement` is six
 *      named fields (`REQUIREMENT_FIELDS`, in canonical order) of which three
 *      must be non-empty for the planner to enter at its second phase instead of
 *      opening a conversation. A field a run must fill enforces what an
 *      instruction can only ask for — *"see my comment"* satisfies "pass your
 *      evidence" and supplies nothing, and it cannot satisfy `behaviour`. So the
 *      prompt teaches the FIELDS, by name and by what each is for, in the order
 *      the far side declares them. The names below are asserted against a
 *      fixture mirroring motir-ai's own list (`tests/fixtures/settledRequirement.ts`),
 *      because this seam already failed once with both halves green (MOTIR-4168).
 *   3. THE AGENT GETS ONE SHOT, AND SAYS SO. Nothing goes back and asks it — it
 *      has exited — so the prompt frames the turn as a brief rather than a note.
 *      And "run it once" now has TWO parts: appending starts no job, submitting
 *      is what spends the owner's credits. Both are said, because an agent that
 *      thinks its append submitted stops having done nothing, and one that
 *      retries the submit pays twice for one finding. The single legitimate
 *      retry — a schema-rejected `requirement`, which spent nothing — is its own
 *      sentence, kept apart from "never retry" so the two cannot collapse into
 *      "retry freely".
 *
 * What the prompt does NOT ask for: a diagnosis of the planning rules. That is
 * the fix phase's work, and an agent asked to classify invents. And a refusal
 * never becomes conditional on composing the WHAT well: an agent that cannot
 * articulate the problem is told to submit anyway, without it, and the planner
 * falls back to asking.
 *
 * One composition, every dispatching path: `run`, `batch`, `auto` and `next` all
 * fetch this same server-assembled prompt, so the instruction is written here
 * and nowhere per command.
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
    ...twoLanes(src, policy),
    '  5. Put the finding on the planning thread with the append_plan_turn tool:',
    '',
    `         projectKey: ${src.projectKey}`,
    `         targetKeys: [${src.key}]`,
    '         body:       what you found — the SAME text as your step-3 comment',
    '',
    '     targetKeys anchors the thread to this card. Without it you open the',
    "     PROJECT-WIDE thread and file a plan about one card's defect against the",
    '     whole project. APPENDING IS NOT SUBMITTING: this call costs nothing and',
    '     starts no job. Nothing has reached the planner until step 6.',
    '  6. Compose the WHAT and send it with the submit_plan_session tool:',
    '',
    `         projectKey:  ${src.projectKey}`,
    `         targetKeys:  [${src.key}]   — the same anchor, again`,
    '         requirement: six named fields, in this order —',
    ...requirementBrief(),
    '',
    '     Both calls carry targetKeys, because two calls are two chances to drop',
    '     it. This is your ONLY contribution: nothing will come back and ask you',
    '     — you have exited by the time the planner reads it, and these six fields',
    '     are the whole of what it will ever know from you. Write a brief, not a',
    '     note. Every field is SELF-CONTAINED: "see my comment on the card", "the',
    '     card is wrong" or a bare stack trace supplies nothing, because the',
    '     planner does not open your comment — put the content in the field. The',
    '     three REQUIRED fields must be non-empty; the other three may be "",',
    '     which is an answer, not a blank to skip. Describe what is wrong with the',
    '     CARD, not why it was planned that way: you are not asked to classify the',
    '     mistake, and a guess would be filed as a fact.',
    '     If you genuinely cannot articulate the problem, submit anyway, WITHOUT',
    '     requirement — refusing the card must never wait on writing well. The',
    '     planner opens a conversation with the operator instead.',
    "  7. SUBMITTING IS THE ACT THAT SPENDS the token owner's AI credits, and you",
    '     do it exactly ONCE. Never retry it, even on a timeout — a blind retry in',
    '     an unattended run costs them twice for one finding. The one exception:',
    '     if submit_plan_session REJECTS your arguments (a malformed requirement),',
    '     nothing happened — no job was created and no credits were spent — so',
    '     re-submit once, WITHOUT the requirement. That is the only retry there is.',
    '  8. Stop. Do not pick up other work.',
  ];
}

/**
 * THE TWO LANES a re-plan can go down, when this run has one (MOTIR-4085).
 *
 * Renders NOTHING without `--auto-approve-replan`, which is what keeps the
 * default prompt byte-identical to the one that shipped: a run with no loop to
 * continue into has one lane, and describing two would be describing a choice
 * that does not exist.
 *
 * ── IT IS INFORMATION, NOT PRESSURE, and the difference is the whole design ──
 * An agent that is FORCED down the fast lane has an incentive to invent a local
 * fix it does not believe in — papering over a mis-planned story so the run can
 * continue — which buys continuity by spending plan quality. So the block says
 * both lanes are legitimate, says the normal one is always available, and says
 * out loud that stopping is a correct outcome. The one thing it must never
 * suggest is that a wider finding should be narrowed to fit.
 *
 * ── IT IS NOT THE BOUND EITHER ──────────────────────────────────────────────
 * Nothing here is trusted. The LOOP reads the plan that comes back, checks the
 * lane itself, and approves or does not — so an agent that ignores every word of
 * this cannot cause an approval, and one that misjudges the lane is stopped by
 * name rather than obeyed. What the block buys is that the agent knows which
 * choice it is making, and that a deliberate reach beyond the lane is a decision
 * rather than an accident.
 *
 * ── THE ANCHOR IS THE ELECTION ──────────────────────────────────────────────
 * `approveWorkItemPlan` resolves the plan through the conversation anchored at
 * THIS card's key and nothing else, so a plan anchored anywhere else is
 * structurally out of the loop's reach: the run stops and a person decides. That
 * is a property of the shipped resolution rather than a rule this text invents,
 * which is why the block can state it as a fact.
 */
function twoLanes(src: DispatchPromptSource, policy: FindingsPolicy): string[] {
  if (!policy.autoApproveReplan) return [];
  const parent = src.parent?.key ?? null;
  const siblingLevel = parent
    ? `${src.key} and its siblings under ${parent}`
    : `${src.key} itself — it has no parent, so it has no sibling level either`;
  return [
    '',
    '  ── TWO LANES, and WHICH ONE is yours to choose ─────────────────────────',
    '',
    '  This run was launched with --auto-approve-replan: its loop may approve a',
    '  re-plan itself and carry on, instead of stopping for a person. It approves',
    '  inside ONE lane, and it checks that lane over the plan that comes back — so',
    '  you cannot ask for automatic approval and you cannot be given it by',
    '  accident. Nothing below changes what you may do; it tells you what happens',
    '  to what you submit, which you have no other way to find out.',
    '',
    `    THE CARD'S OWN LANE — the correction is ${siblingLevel}:`,
    '    a rewrite, a split into two siblings, an added sibling, a sibling that',
    '    should not exist. Keep targetKeys at the value steps 5 and 6 show and the',
    '    loop may approve it, then carry on with the corrected work.',
    '',
    '    THE NORMAL LANE — everything wider, and it is ALWAYS available, including',
    '    right now. Put the CONTAINER’s key in targetKeys instead — in BOTH calls,',
    parent
      ? `    steps 5 and 6, e.g. [${parent}] — when the mis-planning is bigger than`
      : '    steps 5 and 6 — when the mis-planning is bigger than',
    '    this one card; or omit targetKeys entirely when what is missing is a',
    '    precondition no card names yet, and the planner will settle a new one.',
    '    A person reviews the plan, and this run stops.',
    '',
    '  CHOOSE THE LANE THAT IS TRUE. If the whole story is mis-planned, say so and',
    '  let the run stop — a stop a person can act on beats a local fix you do not',
    '  believe in. You are not being asked to keep the run going.',
    '',
    `  And if you anchor here but propose beyond ${parent ? `${parent}'s children` : "this card's own level"},`,
    '  the loop does not approve it: it names what fell outside and stops, and the',
    '  plan waits for a person. That is a correct outcome — it is',
    '  not a rejection of your finding, and nothing you wrote is lost.',
    '',
  ];
}

/**
 * The six fields of the WHAT, as the prompt teaches them — NAME, whether the far
 * side requires it non-empty, and what the agent is being asked for.
 *
 * ⚠️ THE NAMES AND THE ORDER ARE motir-ai's, NOT THIS FILE's. `REQUIREMENT_FIELDS`
 * in `src/jobs/conversation.ts` declares them in this order and
 * `REQUIREMENT_REQUIRED_NON_EMPTY` names the three; `submit_plan_session`'s
 * schema (`lib/mcp/tools/planSession.ts`) declares them in the same order. A
 * rename on any of the three sides fails `tests/dispatch/promptTemplate.test.ts`,
 * which reads the composed prompt against the fixture that mirrors motir-ai's
 * list — a prompt asserted only against itself is what let MOTIR-4168 through.
 *
 * `assumptions` is translated for THIS actor. Its own definition reads *"what the
 * planner recommended and nobody corrected"* — written from a conversation's
 * point of view, where a person is present to not-correct it. A dispatched agent
 * has neither, so here it means what the agent concluded that nobody confirmed.
 */
function requirementBrief(): string[] {
  const fields: { name: string; required: boolean; ask: string[] }[] = [
    {
      name: 'outcome',
      required: true,
      ask: ['what the corrected card should make possible', 'that it does not today'],
    },
    {
      name: 'behaviour',
      required: true,
      ask: [
        'what you expected versus what you actually',
        'found, observably: the file, the command, what it said',
      ],
    },
    {
      name: 'scopeEdge',
      required: false,
      ask: [
        'what you are deliberately NOT asking for; "" says you',
        'considered it and there is none',
      ],
    },
    {
      name: 'constraints',
      required: false,
      ask: [
        'what already binds the shape — a shipped decision, a',
        'boundary the corrected card must respect; "" if none',
      ],
    },
    {
      name: 'acceptance',
      required: true,
      ask: [
        'how the planner will know the corrected card',
        'is right, as something a reader can observe',
      ],
    },
    {
      name: 'assumptions',
      required: false,
      ask: ['what you concluded that nobody has confirmed; "" if', 'nothing'],
    },
  ];
  const lines: string[] = [];
  for (const f of fields) {
    const [first, ...rest] = f.ask;
    const head = f.required ? `REQUIRED — ${first}` : first;
    lines.push(`           ${f.name.padEnd(12)} ${head}`);
    for (const line of rest) lines.push(`                        ${line}`);
  }
  return lines;
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
    '  3. Its description OPENS with this exact line — copy it, do not reword it:',
    '',
    `         **Found while:** running ${src.key}`,
    '',
    '     and on that same line, or the one right after it, the branch or commit',
    '     you were on. A number measured on an unmerged branch is not a number',
    '     about main, and saying which is the difference between a report and a',
    '     rumour. Then, in this order:',
    '        - THE REPRODUCTION — what to do to make it happen.',
    '        - THE EVIDENCE — the command you ran and its output verbatim, or the',
    '          file and line you read.',
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

/** Indent every line of a possibly multi-line value, so a long message stays
 *  inside its block instead of reading as the prompt's own text. */
function indentBlock(text: string, pad: string): string[] {
  return text.split(/\r?\n/).map((line) => `${pad}${line}`);
}

/**
 * The ERROR EVIDENCE section (Story MOTIR-5975 · Subtask MOTIR-5982): what the
 * monitor recorded for each error linked to this work item, so an agent handed a
 * monitor-filed bug starts from the exception, the stack and the request rather
 * than from a one-line title. A dispatched agent reads THIS prompt and nothing
 * else — it never opens the item page.
 *
 * ⚠️ IT IS A RENDERING OF STORED FACTS, like the design reference. It fetches
 * nothing, never re-derives `evidence.state`, and cuts nothing below the store's
 * own bounds. The tags were filtered at the provider seam, so there is no second
 * filter here — a second home for the denylist is one that drifts.
 *
 * ⚠️ AN EMPTY LIST RENDERS NOTHING — not a heading, not a blank line — so a work
 * item with no link gets the prompt it always got.
 */
export function renderErrorEvidence(links: readonly MonitorIssueLinkDto[]): string[] {
  if (links.length === 0) return [];
  const lines: string[] = [
    'What the error monitor recorded for the errors linked to this work item — read',
    'from Motir, never live from the monitor. Start your diagnosis here. Tags have had',
    'every user-identifying key removed; the request is a method and a path only.',
  ];
  links.forEach((link, index) => {
    const { evidence } = link;
    const where = [link.connection.orgSlug, link.connection.projectSlug].filter(Boolean).join('/');
    lines.push(
      '',
      `Error ${index + 1} of ${links.length}: ${link.title}`,
      `  ${[
        link.level ?? 'unknown level',
        `seen ${link.eventCount} time${link.eventCount === 1 ? '' : 's'}`,
        link.environment ? `environment ${link.environment}` : null,
        link.release ? `release ${link.release}` : null,
        where ? `monitor ${where}` : null,
      ]
        .filter(Boolean)
        .join(' · ')}`,
    );
    if (evidence.state === 'never_read') {
      lines.push(
        '  The latest event has not been read yet, so there is no evidence to show — it',
        '  arrives on a later check. Do not read its absence as "the error has no stack".',
      );
      return;
    }
    if (evidence.stale) {
      lines.push(
        `  OUT OF DATE: the last check of this error failed at ${evidence.lastFailedAt}.`,
        `  What follows was read at ${evidence.readAt} and may be older than the error now is.`,
      );
    }
    if (evidence.exception) {
      const head = evidence.exception.type ?? 'Exception';
      if (evidence.exception.message) {
        lines.push(`  Exception: ${head}`, ...indentBlock(evidence.exception.message, '    '));
      } else {
        lines.push(`  Exception: ${head}`);
      }
    } else {
      lines.push('  No exception: the latest event carried no exception and no stack.');
    }
    if (evidence.frames.length > 0) {
      lines.push('  Stack frames (the application’s own first, then most recent call first):');
      for (const frame of evidence.frames) {
        const at =
          frame.lineNumber === null ? frame.filePath : `${frame.filePath}:${frame.lineNumber}`;
        const fn = frame.function ? ` ${frame.function}` : '';
        lines.push(`    ${frame.inApp === true ? '[app] ' : '      '}${at}${fn}`);
      }
    }
    if (evidence.tags.length > 0) {
      lines.push('  Tags:');
      for (const tag of evidence.tags) lines.push(`    ${tag.key} = ${tag.value}`);
    }
    if (evidence.request) {
      lines.push(
        `  Request: ${[evidence.request.method, evidence.request.path].filter(Boolean).join(' ')}`,
      );
    }
    lines.push(
      `  Event: ${evidence.eventId ?? 'id not recorded'}${evidence.eventAt ? ` at ${evidence.eventAt}` : ''}`,
    );
  });
  return lines;
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
  const own = repos ? multiRepoPerItemPrWorkflow(src, repos) : perItemPrWorkflow(src);
  // A decision card taken OFF the lineage it was offered (MOTIR-6094) is told
  // why, and told the branch it must not touch — without the note, the agent
  // sees a run integrating everything else and reads its own prompt as a slip.
  return isAgentDecisionItem(src) && src.sessionBranch !== null
    ? [...decisionOffLineageNote(src.sessionBranch), '', ...own]
    : own;
}

/**
 * Why a DECISION card ships on its own pull request while the run it belongs to
 * integrates into a session branch (MOTIR-6094). See {@link isAgentDecisionItem}.
 */
function decisionOffLineageNote(sessionBranch: string): string[] {
  return [
    `This run integrates its other work items into ${sessionBranch}, but a DECISION`,
    'work item never joins it. Approving a decision also authorises the merge of the',
    'pull request linked to it, and the session pull request carries every other work',
    'item of the run, so one approval would merge code nobody reviewed. Do NOT branch',
    `from ${sessionBranch}, do NOT integrate into it, do NOT call mark_integrated, and`,
    'do NOT link its pull request to this work item.',
  ];
}

/** The ERROR EVIDENCE section with its trailing separator, or nothing at all. */
function errorEvidenceBlock(links: readonly MonitorIssueLinkDto[]): string[] {
  const body = renderErrorEvidence(links);
  return body.length === 0
    ? []
    : [...section('ERROR EVIDENCE — what the monitor recorded for this work item', body), ''];
}

export function assembleDispatchPrompt(src: DispatchPromptSource): AssembledDispatchPrompt {
  const injections = src.injections ?? NO_INJECTIONS;
  const { body, acceptanceCriteria, contextRefs } = splitPlanBody(src.descriptionMd);
  const manual = isManualReadyItem({ type: src.type, executor: src.executor });
  // The lineage the prompt instructs. A manual item is forced to `per_item_pr`
  // with no branch — it renders no GIT WORKFLOW at all (see the interface doc).
  // So is an agent's DECISION card, which renders the per-item workflow: its
  // approval is a merge, so it must never be linked to a session pull request
  // (MOTIR-6094, {@link isAgentDecisionItem}). Decided HERE, not by the CLI,
  // because a lineage can be inherited from a blocker as well as seeded, and
  // every lane that dispatches reads this answer.
  const sessionBranch = manual || isAgentDecisionItem(src) ? null : src.sessionBranch;
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
  // The acceptance-receipt steps (MOTIR-4704) — appended, never substituted: an
  // acceptance card still writes and greens its spec, and the publish is the
  // step AFTER that. A manual item is excluded by construction (it took
  // MANUAL_WHAT_TO_DO above and has no run to record anything in).
  if (!manual && recordsAcceptanceReceipt(src)) {
    whatToDo = [...whatToDo, ...ACCEPTANCE_PUBLISH_STEPS];
  }
  // The design-result step (MOTIR-5495) — appended, and chosen by the server's
  // answer rather than by the card: publish when work waits, say not to when none
  // does. A manual item never reaches it.
  if (!manual && src.type === 'design') {
    whatToDo = [...whatToDo, ...designResultSteps(src.openDependentKeys)];
  }
  // The bug-card reproduction preamble (MOTIR-5944) — keyed on KIND, for any
  // type, and prepended so it is read before the type's steps and before THE
  // CARD IS WRONG. A manual item is excluded: it has no pull request body for
  // the matrix and no outcome protocol for step d to point at.
  if (!manual && src.kind === 'bug') {
    whatToDo = [...BUG_REPRODUCTION_STEPS, ...whatToDo];
  }

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
      ...section(
        'REPORTING THE OUTCOME — say which one happened',
        outcomeProtocol(src, sessionBranch),
      ),
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
    // The ERROR EVIDENCE (MOTIR-5982) sits with the card's own WHAT — after its
    // criteria, before the git workflow — and renders NOTHING for a card with no
    // monitor link, so every other prompt is byte-identical to before.
    ...errorEvidenceBlock(src.errorEvidence ?? []),
    ...closing,
  ];

  return { prompt: lines.join('\n') + '\n', workflowMode, sessionBranch };
}
