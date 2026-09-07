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
    '6. PUBLISH the design result: commit the three files, then call the',
    '   publish_design_result tool with this card’s key and the assets — the',
    '   *.mock.html as kind "mock", the .png as kind "image", and the note file as',
    '   kind "note_file" — plus noteMd carrying the note SECTIONS this card wrote.',
    '   Send the sections describing the surface you drew, never the whole note',
    '   file: an area note runs to hundreds of kilobytes, and a reviewer opening',
    '   the card wants what changed. Do this in the SAME iteration that produced',
    '   the asset, while the files are in front of you.',
    '',
    '   The REPOSITORY stays the source of truth: the published result is the',
    '   card’s view of the asset and is',
    '   never a replacement for committing the three files.',
    '',
    '   And nothing else will make this call. A design card whose result never',
    '   arrives looks exactly like one that succeeded — files written, commit',
    '   landed, checks green, card empty — so the publish is a step of this run,',
    '   not something to confirm afterwards.',
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

/**
 * THE ACCEPTANCE-RECEIPT STEPS (bug MOTIR-4704) — appended to a `type: test`
 * card's steps when, and only when, the card is the one that records a story's
 * acceptance video.
 *
 * ⚠️ WHY THIS IS CONDITIONAL WHERE THE DESIGN PUBLISH IS NOT. `type: design` IS
 * the design card, so `WHAT_TO_DO.design`'s publish step is unconditional and
 * correct. `type: test` is every test card there is, and the overwhelming
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
          ` minutes, over ${a.threshold === 'both' ? 'BOTH ceilings' : a.threshold === 'story_points' ? 'the 13-point split signal' : 'the 70-minute estimate threshold'}.`,
      ),
      '  13+ points is the split signal read literally, and a coding_agent run must fit inside',
      '  an hour. The MINUTES half is a PROXY for that hour, not the rule itself: the gate',
      '  ceilings the AGENT RUN excluding CI, while the estimate column sums agent time AND CI',
      '  time — so past 70 total minutes the run is PROBABLY over the hour, and a card with a',
      '  short run behind a heavy CI leg can be inside it. Check the split before the number.',
      '  READ THE CARD FIRST: every prior instance of this had already done the',
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
    : ['    3. open the pull request'];
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
  // The acceptance-receipt steps (MOTIR-4704) — appended, never substituted: an
  // acceptance card still writes and greens its spec, and the publish is the
  // step AFTER that. A manual item is excluded by construction (it took
  // MANUAL_WHAT_TO_DO above and has no run to record anything in).
  if (!manual && recordsAcceptanceReceipt(src)) {
    whatToDo = [...whatToDo, ...ACCEPTANCE_PUBLISH_STEPS];
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
    ...closing,
  ];

  return { prompt: lines.join('\n') + '\n', workflowMode, sessionBranch };
}
