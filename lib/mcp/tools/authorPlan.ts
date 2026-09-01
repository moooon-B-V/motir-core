import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectsService } from '@/lib/services/projectsService';
import { plansService } from '@/lib/services/plansService';
import type {
  PlanDto,
  PlanItemProposedFields,
  PlanWithItemsDto,
  PlanItemPatch,
  ProposalInput,
  UpdateProposalInput,
  CorrectProposalInput,
  UpdateProposalKey,
  CorrectProposalKey,
} from '@/lib/dto/plans';
import { InvalidProposalError, PlanRefGraphError } from '@/lib/plans/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import {
  planAppendPayload,
  planPayload,
  presentMcpPlan,
  presentMcpPlanAppend,
} from '../payloads/workLoop';
import { WORK_ITEM_TYPES } from '@/lib/issues/executorDefaults';
import { isTempRef } from '@/lib/plans/refs';
import { resolveWorkItemIdsByKeys } from './workItemRef';
import { projectKeyField } from './readyFilters';
import { GET_PLAN_TOOL_NAME } from './getPlan';

// `create_plan` + `add_plan_items` (Story MOTIR-2982 · Subtask MOTIR-2988) —
// the PAT-authed door onto the plan substrate, so an agent can AUTHOR the
// proposals a person then reviews.
//
// ── Why they exist ─────────────────────────────────────────────────────────
// Every planner Motir ships produces into the plan substrate: a `Plan` of
// `PlanItem` proposals somebody reviews and approves, where nothing becomes a
// work item until they decide. Every planner except an external agent on the
// MCP, which had exactly two write paths and neither authored a proposal —
// `create_work_item` writes a real row immediately (no proposal, no diff, no
// approval), and the plan-session tools reach a `Plan` only by handing a PROMPT
// to motir-ai, spending the owner's credits so Motir's generator can do the
// thinking. So the planner best placed to decompose the work — one already
// sitting in the repository with the code in front of it — could bypass the gate
// or delegate the thinking, and nothing else.
//
// ── These are TRANSPORTS, not a second write path ──────────────────────────
// Every gate, validation and transaction already lives in `plansService`:
// `createPlan` asserts edit access; `addProposals` locks the plan row, re-reads
// its status, refuses an append once the plan has left `generating`, validates
// each proposal's op/grammar/sizing, and rejects an intra-plan temp-ref cycle at
// the boundary. This module is zod argument schemas, three adapters and error
// mapping — the shape `planSession.ts` and `getPlan.ts` are built to.
//
// ── The TWO AUTHORING tools, and why not one (ADR Q1) ──────────────────────
// (A THIRD tool, `update_plan_item`, joined them in 2026-08-19's AMENDMENT 4 —
// see its own header below. Q1 is about how a tree is APPENDED; the deepen is a
// different act on a proposal that already landed, so it does not reopen this.)
// The shipped producer contract is `createPlan` → repeated `addProposals` →
// `markPlanned`, composed by `aiGenerationService.appendProposals` behind
// `POST /api/internal/ai/plan-proposals` — where `markPlanned` is reached by a
// `final: true` FLAG on the last append rather than by a second endpoint (that
// route's header says so in as many words). Two tools mirror that exactly.
//
// One `propose_plan(tree)` cannot work: `addProposals` returns the created
// PlanItem ids IN APPEND ORDER, and those ids ARE the intra-plan temp-refs a
// later batch passes as `parentRef` / `blockedByRefs` (`planItem:<id>`,
// `lib/plans/refs.ts`). A tree deeper than one level therefore needs a
// round-trip per layer, and a whole-tree call would have to invent a second ref
// vocabulary materialize does not understand.
//
// ── AUTHORSHIP is stamped, never accepted (ADR Q3/Q4) ──────────────────────
// `create_plan` fixes `authorSource: 'mcp'` SERVER-SIDE — the discipline
// `create_work_item` applies to `source: 'mcp'`, "so an agent cannot claim
// `manual`/`native`" — and takes only the harness/model as self-reported free
// text. `add_plan_items` then STAMPS each `add`'s `planningProvenance` from the
// plan's own triple and does not offer the field as an argument at all.
//
// That is what lets `docs/decisions/work-item-provenance.md` Decision 5's
// materialize PIN be lifted (MOTIR-2990) without weakening what it protected:
// materialize reads a value a Motir write seam wrote, never one a caller sent.
// It also means a plan's attribution and its items' attribution cannot disagree,
// because there is exactly one place either is written.
//
// ── ONE PROPOSAL PER EXISTING TARGET (MOTIR-3194) ──────────────────────
// `PlanItem @@unique([planId, workItemId])` admits at most one `modify`/`remove`
// per target work item, and MOTIR-3194 KEPT that rule after re-opening it —
// `DuplicatePlanTargetError` (`lib/plans/errors.ts`) argues the three upstream
// reasons on the record, the load-bearing one being that a plan stores only the
// NEW values and the review surface reads each diff's OLD side LIVE from the
// target, so two patches on one card cannot be rendered honestly.
//
// What that card actually FIXED is this file's contract: the rule used to
// announce itself as Prisma's own ``Invalid `prisma.planItem.create()`
// invocation: Unique constraint failed on the (not available)``, because
// `toToolError` re-throws what it does not recognise and the SDK renders a
// re-thrown message verbatim. The refusal is now typed, names the work item, and
// names both alternatives — and the whole append transaction is contained, so no
// OTHER ORM failure can take the route this one took.
//
// ── NEITHER TOOL IS BILLABLE ───────────────────────────────────────────────
// `MCP_BILLABLE_TOOLS` (`lib/mcp/rateLimitGate.ts`) holds exactly the tools that
// make motir-ai run a model job. These spend no provider tokens and start no
// job — they are database writes, covered by the transport's own `mcp:call`
// limit like every other write tool. Adding them would cap plan authoring
// against the owner's GENERATION allowance for no reason.

// ── AND `update_plan_item` (Story MOTIR-3088 · Subtask MOTIR-3090) ─────────
// The THIRD tool, added 2026-08-19. `add_plan_items` is append-only, so a
// proposal was frozen the moment it landed — which forbade the one authoring
// strategy Motir's own generator uses. `motir-ai`'s issue-tree handler runs
// TITLES-FIRST (MOTIR-845): append title-only `add`s so the SHAPE of the tree is
// settled and reviewable early, then PATCH each card's bodies, type, priority
// and sizing one at a time, all before `markPlanned` closes the frontier.
//
// That deepen op has been shipped since MOTIR-1441 (`plansService.deepenProposal`)
// and was reachable ONLY over the §4 job token, so an external agent on the MCP
// was held to a strategy Motir abandoned for its own planner. This tool is the
// PAT-authed door onto it — and, like its two siblings, a TRANSPORT: the lock,
// the status gate, the add-only rule, the sparse merge and the sizing
// re-validation all already live in `editAddProposal`.
//
// ⚠️ IT RESOLVES BY `planId`, NOT BY `sourceJobId`. The internal seam's
// `aiGenerationService.patchProposal` finds its plan through the plan repository's
// `sourceJobId` lookup; an MCP-authored plan has NO generation job, so that
// lookup would throw `NoPlanForJobError` for every plan `create_plan` opened.
// This tool calls `plansService.deepenProposal(planId, …)` directly and adds no
// second resolution path to `aiGenerationService`. (MOTIR-3090's acceptance is a
// grep: nothing under `lib/mcp/` names that repository method, and this comment
// is deliberately written not to.)
//
// The CONTRACT is `docs/decisions/agent-authored-plans.md` AMENDMENT 4:
// D1 `generating` only (a plan in the review queue must hold still while a person
// reads it), D2 `ai:view_plan` (the key `editAddProposal` itself asserts),
// D3 the editable set gains `executor` and NOTHING else, D4 withdrawing a
// proposal is still unreachable and deferred.

export const CREATE_PLAN_TOOL_NAME = 'create_plan';
export const ADD_PLAN_ITEMS_TOOL_NAME = 'add_plan_items';
export const UPDATE_PLAN_ITEM_TOOL_NAME = 'update_plan_item';
export const UPDATE_PLAN_PROPOSAL_TOOL_NAME = 'update_plan_proposal';
export const WITHDRAW_PLAN_PROPOSAL_TOOL_NAME = 'withdraw_plan_proposal';

// ─────────────────────────────────────────────────────────────────────────────
// Arguments
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The self-reported half of the authorship triple.
 *
 * Named `plannedWithHarness` / `plannedWithModel` to match `create_work_item`,
 * which already publishes those two argument names for the identical fact
 * (`work-item-provenance.md` Decision 4). `create_plan` is that tool's
 * reviewable twin; an agent wiring both should pass the same values under the
 * same names (ADR Q1).
 */
const plannedWithHarnessField = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(
    'Optional: the harness/tool you are running as (e.g. "Claude Code", "Codex"). Shown to ' +
      'the person reviewing this plan, so they can see it was written by an agent rather ' +
      'than generated by Motir.',
  );

const plannedWithModelField = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(
    'Optional: the model you are running (e.g. "claude-opus-5"). Shown beside the harness.',
  );

const createPlanInputSchema = {
  projectKey: projectKeyField,
  title: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Optional short label for the plan — what it is proposing, in a line.'),
  summary: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Optional longer summary (Markdown) of what this plan proposes and why, shown to the ' +
        'reviewer above the tree.',
    ),
  plannedWithHarness: plannedWithHarnessField,
  plannedWithModel: plannedWithModelField,
};

/**
 * One proposed operation.
 *
 * A deliberate NARROWING of `ProposalInput`: `planningProvenance` is absent from
 * `proposedFields` because this tool stamps it (see the header), and everything
 * else mirrors the shipped internal seam field for field so the two producers
 * cannot mean different things by the same proposal.
 */
const proposedFieldsSchema = z
  .object({
    title: z.string().trim().min(1).describe('The proposed item’s title. Required on an `add`.'),
    kind: z
      .enum(['epic', 'story', 'task', 'bug', 'subtask'])
      .optional()
      .describe('The proposed kind. Defaults to `task` (a standalone leaf) when omitted.'),
    descriptionMd: z.string().optional().describe('Markdown body — WHAT to do.'),
    explanationMd: z.string().optional().describe('Markdown body — WHY it matters.'),
    type: z
      .enum(WORK_ITEM_TYPES)
      .optional()
      .describe(
        'Leaf work type. A CLOSED set: these fourteen members ARE the schema enum, so ' +
          'anything else is refused here rather than 500ing at approve.',
      ),
    priority: z.enum(['lowest', 'low', 'medium', 'high', 'highest']).optional(),
    executor: z.enum(['coding_agent', 'human']).optional(),
    storyPoints: z
      .number()
      .optional()
      .describe('Agile sizing. Validated at the boundary exactly as the create path validates it.'),
    estimateMinutes: z.number().int().optional().describe('Estimated minutes of work.'),
    targetRepo: z
      .string()
      .optional()
      .describe('WHICH REPO the item ships in — validated against the project’s set at approve.'),
    targetRepoRole: z
      .string()
      .optional()
      .describe('The PORTABLE repo pin — a role of the project’s repository set.'),
  })
  .describe('The proposed item’s fields. Required on an `add`, ignored otherwise.');

/**
 * The `modify` patch — the keys `PlanItemPatch` (`lib/dto/plans.ts`) declares,
 * named here rather than left to an opaque record (MOTIR-3111).
 *
 * This used to be `z.record(z.string(), z.unknown())`, which accepted everything
 * and DOCUMENTED nothing: an agent reading the tool could not tell that a patch
 * may carry a body at all, let alone which one. That mattered the moment the
 * runbook's REPLAN ACTION started routing through this door — it mandates
 * rewriting the survivor's `explanationMd`, and the only listing of what a patch
 * can hold was a sentence saying "the sparse patch".
 *
 * `.passthrough()` is load-bearing, not tidiness: an unrecognised key is passed
 * to the service UNCHANGED rather than stripped, so this schema can never become
 * the reason a field the service already understands stops arriving. Every key
 * below is typed no more narrowly than the boundary the service already enforces
 * (`validateStoryPoints` / `validateEstimateMinutes` reject a non-number today),
 * so nothing that used to reach `applyModify` is turned away here.
 */
const patchSchema = z
  .object({
    title: z.string().optional().describe('Re-title the target.'),
    descriptionMd: z
      .string()
      .nullable()
      .optional()
      .describe('Markdown body — WHAT to do. An explicit `null` clears it.'),
    explanationMd: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Markdown body — WHY it matters. An explicit `null` clears it. Patch it whenever a ' +
          're-scope moves the card’s rationale: a survivor keeps its OLD explanation unless you ' +
          'rewrite it, and a stale WHY is worse than a null one.',
      ),
    priority: z.enum(['lowest', 'low', 'medium', 'high', 'highest']).nullable().optional(),
    type: z
      .enum(WORK_ITEM_TYPES)
      .nullable()
      .optional()
      .describe(
        'Leaf work type. A CLOSED set: these fourteen members ARE the schema enum. An ' +
          'explicit `null` clears it.',
      ),
    storyPoints: z
      .number()
      .nullable()
      .optional()
      .describe('Re-scope the agile sizing. An explicit `null` clears it.'),
    estimateMinutes: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe('Re-scope the time estimate. An explicit `null` clears it.'),
    targetRepo: z
      .string()
      .nullable()
      .optional()
      .describe('RE-PIN which repo the item ships in. An explicit `null` unpins it.'),
    targetRepoRole: z
      .string()
      .nullable()
      .optional()
      .describe('RE-PIN the portable repo role. An explicit `null` unpins it.'),
    parentRef: z
      .string()
      .nullable()
      .optional()
      .describe(
        'RE-PARENT the target: a work-item KEY ("ACME-7") or a real work-item id — the card ' +
          'this one should hang under instead. An explicit `null` moves it to the PROJECT ROOT. ' +
          'Omit the key to leave the parent where it is. ⚠️ It must name a work item that ' +
          'ALREADY EXISTS — a `planItem:<id>` ref is refused, because every check a re-parent ' +
          'owes (the kind-parent matrix, same-project, no cycle, the depth cap, and a refusal ' +
          'to hang new work under a FINISHED parent) is a question about a live row. To land a ' +
          'card under one this plan is adding, `add` it with that `parentRef` instead.',
      ),
    blockedByAdd: z
      .array(z.string())
      .optional()
      .describe(
        'Dependency edges to ADD — work-item keys ("ACME-7"), real work-item ids, or ' +
          '`planItem:<id>` refs.',
      ),
    blockedByRemove: z
      .array(z.string())
      .optional()
      .describe(
        'Dependency edges to REMOVE — work-item keys ("ACME-7"), real work-item ids, or ' +
          '`planItem:<id>` refs.',
      ),
  })
  .passthrough()
  .describe(
    '`modify` only: the SPARSE patch to apply to the target at approve. A key you omit is left ' +
      'untouched; an explicit `null` CLEARS a nullable field. Nothing is applied until someone ' +
      'approves the plan in Motir.',
  );

const proposalSchema = z.object({
  op: z.enum(['add', 'modify', 'remove']).describe('add a new item, modify one, or remove one.'),
  workItemId: z
    .string()
    .optional()
    .describe('`modify` / `remove` only: the existing target work item’s id.'),
  proposedFields: proposedFieldsSchema.optional(),
  patch: patchSchema.optional(),
  parentRef: z
    .string()
    .optional()
    .describe(
      'Where the proposed item hangs, in any of THREE forms: a work-item KEY ' +
        '("ACME-7", the identifier every other tool takes, case-insensitive); a real ' +
        'work-item id; or `planItem:<id>` naming another `add` in THIS plan — an id this ' +
        'tool returned in `planItemIds` on an earlier call. A key is resolved to its id when ' +
        'the proposal is appended, so the three are interchangeable; a key that names no work ' +
        'item in this workspace is refused HERE, not at approve.',
    ),
  blockedByRefs: z
    .array(z.string())
    .optional()
    .describe(
      'Dependency edges, in the same three forms as `parentRef`: work-item keys ("ACME-7"), ' +
        'real work-item ids, or `planItem:<id>` refs into this plan.',
    ),
  baseRevision: z
    .string()
    .optional()
    .describe('`modify` / `remove` only: the target revision the change was computed against.'),
});

/**
 * ⚠️ `proposals` MAY BE EMPTY, and only when `final: true` (MOTIR-3193).
 *
 * It used to be `.min(1)`, which made the two-phase authoring path
 * `update_plan_item` shipped (MOTIR-3088) impossible to finish: the SKELETON
 * batches carry the structure, the DEEPEN turns write the cards, and the CLOSE
 * then has NOTHING left to append — while `final` is a flag on an append and the
 * only way to say "I am done". The two outs were both bad (hold one card back
 * out of the deepen phase, or invent a proposal a reviewer never meant), and
 * doing neither leaves the plan `generating`, where nothing can decide it
 * (MOTIR-3189).
 *
 * The internal producer seam has always accepted this shape —
 * `aiGenerationService.appendProposals` skips the append when the batch is empty
 * and calls `markPlanned` regardless — so this is the MCP door catching up with
 * the contract Motir's own generator already uses, not a new one.
 *
 * The EMPTY-and-not-final pair stays refused, in {@link runAddPlanItems}: a
 * cross-field rule cannot live in a `ZodRawShape` (which is what `registerTool`
 * takes), and it must not be answered with a silent success — an empty batch
 * with no `final` is a forgotten flag or a batch built from an empty list, and
 * both are worth telling the caller about.
 */
const addPlanItemsInputSchema = {
  planId: z.string().trim().min(1).describe('The plan id `create_plan` returned.'),
  proposals: z
    .array(proposalSchema)
    .describe(
      'The batch to append, in the order you want their ids back. MAY be empty — but ONLY ' +
        'together with `final: true`, which is how a titles-first pass CLOSES a plan it has ' +
        'finished writing.',
    ),
  final: z
    .boolean()
    .optional()
    .describe(
      'Set true on the LAST batch to close the plan (`generating` → `planned`), which is what ' +
        'puts it in front of a person for review. Appending after that is refused. Send it with ' +
        'an EMPTY `proposals` array to close a plan you have nothing left to append to.',
    ),
};

/**
 * `update_plan_item`'s arguments — the plan, the proposal, and a SPARSE patch.
 *
 * ⚠️ ABSENT ≠ NULL, and the schema must not blur them. `editAddProposal`'s whole
 * contract is that an absent key leaves the field untouched while an explicit
 * `null` clears it (`mergeProposedFields` tests `!== undefined`, key by key). A
 * zod `.default(null)` — or any coercion of `undefined` to `null` — would turn
 * every partial patch into a destructive one, silently. So every field below is
 * `.optional()` (may be missing) AND, where the underlying field is nullable,
 * `.nullable()` (may be explicitly cleared), and the adapter rebuilds the input
 * with `in` presence checks, the way the shipped review route
 * (`app/api/plans/[id]/items/[itemId]/route.ts`) does.
 *
 * `title` is `.trim().min(1)` to match `proposedFieldsSchema` above rather than
 * to substitute for the service's non-empty-title guard — the two doors must not
 * disagree about what a title is. It is the ONE non-nullable member: a proposal
 * with no title is not a proposal.
 *
 * `executor` is here because AMENDMENT 4 D3a put it in the editable set, and it
 * is constrained by the SAME enum `proposedFieldsSchema` uses. `targetRepo` /
 * `targetRepoRole`, `parentRef` and `blockedByRefs` are deliberately absent —
 * D3b and D3c argue both refusals on the record.
 */
const updatePlanItemInputSchema = {
  planId: z.string().trim().min(1).describe('The plan id `create_plan` returned.'),
  planItemId: z
    .string()
    .trim()
    .min(1)
    .describe(
      'The proposal to deepen — one of the ids `add_plan_items` returned in `planItemIds`, ' +
        'in the order you sent them.',
    ),
  title: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Replace the proposed title. Cannot be blanked — a proposal needs a title.'),
  kind: z
    .enum(['epic', 'story', 'task', 'bug', 'subtask'])
    .optional()
    .describe('Replace the proposed kind.'),
  descriptionMd: z
    .string()
    .nullable()
    .optional()
    .describe('Markdown body — WHAT to do. Send `null` to clear it; omit to leave it as it is.'),
  explanationMd: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Markdown body — WHY it matters. Send `null` to clear it; omit to leave it as it is.',
    ),
  type: z
    .enum(WORK_ITEM_TYPES)
    .nullable()
    .optional()
    .describe(
      'Leaf work type. A CLOSED set: these fourteen members ARE the schema enum; `null` ' +
        'clears it.',
    ),
  priority: z
    .enum(['lowest', 'low', 'medium', 'high', 'highest'])
    .nullable()
    .optional()
    .describe('Priority; `null` clears it.'),
  executor: z
    .enum(['coding_agent', 'human'])
    .nullable()
    .optional()
    .describe(
      'WHO executes this leaf. Worth setting whenever you set `type`: approving a plan does ' +
        'NOT derive an executor from the type, so a proposal that never carried one ' +
        'materializes unassigned. `null` clears it.',
    ),
  storyPoints: z
    .number()
    .nullable()
    .optional()
    .describe(
      'Agile sizing, re-validated on the merged result exactly as at append; `null` clears it.',
    ),
  estimateMinutes: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe('Estimated minutes of work; `null` clears it.'),
};

// ── The CORRECTION door (Story MOTIR-3533 · Subtask MOTIR-3541) ────────────
// `update_plan_item` above is the DEEPEN turn and stays exactly as AMENDMENT 4
// fixed it. These two are a different act on a different set, and the ADR that
// separates them is AMENDMENT 8.
//
// ⚠️ WHY A SECOND TOOL RATHER THAN MORE ARGUMENTS ON THE FIRST. The deepen's
// contract — *a deepen may change what a card SAYS and who ACTS on it, never
// where it SITS or SHIPS* — is a rule an agent reads off the tool description
// and plans against. Growing `update_plan_item` a `parentRef` would make that
// sentence false for every caller, including motir-ai's own titles-first
// generator, in order to serve a caller correcting a mistake. Two tools keep
// both contracts sayable in one line each.
//
// Both are THIN: no logic lives here. The lock, the frozen-status gate, the ref
// re-validation, the sparse merge, the referrer check and the trail write are all
// `plansService.correctProposal` / `.withdrawProposal`.

const correctionRefField = z
  .string()
  .describe(
    'A work-item KEY ("ACME-7", the identifier every other tool takes, case-insensitive); a ' +
      'real work-item id; or a `planItem:<id>` ref naming another `add` on THIS plan. A key is ' +
      'resolved to its id by this call, exactly as `add_plan_items` resolves one, so the three ' +
      'are interchangeable (MOTIR-3934).',
  );

const updatePlanProposalInputSchema = {
  ...updatePlanItemInputSchema,
  planItemId: z
    .string()
    .trim()
    .min(1)
    .describe(
      'The proposal to correct — one of the ids `add_plan_items` returned in `planItemIds`, ' +
        'in the order you sent them.',
    ),
  parentRef: correctionRefField
    .nullable()
    .optional()
    .describe(
      '`add` only: re-parent the proposal. A work-item KEY ("ACME-7"), a real work-item id, or ' +
        'a `planItem:<id>` ref naming another `add` on THIS plan; `null` makes it top-level. ' +
        'Re-validated by the same checks the append runs, so a key or a ref naming nothing is ' +
        'refused here rather than at approve — and a ref to the proposal ITSELF is refused too.',
    ),
  blockedByRefs: z
    .array(correctionRefField)
    .optional()
    .describe(
      'REPLACES the dependency edges wholesale — a list has no sparse edit, so send the set you ' +
        'want and `[]` to clear it. Same ref rules and same re-validation as `parentRef`.',
    ),
  targetRepo: z
    .string()
    .nullable()
    .optional()
    .describe(
      '`add` only: re-pin WHICH REPO this proposal ships in, validated against the project’s ' +
        'connected repositories; `null` unpins it.',
    ),
  targetRepoRole: z
    .string()
    .nullable()
    .optional()
    .describe(
      '`add` only: re-pin the PORTABLE half of the pin — a ROLE of the project’s repository set, ' +
        'validated against the closed role vocabulary rather than the project’s rows; `null` unpins ' +
        'it. This is the pin an ONBOARDING plan actually carries, because its repositories do not ' +
        'exist yet.',
    ),
  patch: patchSchema
    .nullable()
    .optional()
    .describe(
      '`modify` only: REPLACES that proposal’s patch. This is the op no door could touch at ' +
        'all before — and the one that carries a dependency edit, so it is usually what a ' +
        'mistyped `planItem:` ref is sitting on.',
    ),
};

const withdrawPlanProposalInputSchema = {
  planId: z.string().trim().min(1).describe('The plan id `create_plan` returned.'),
  planItemId: z
    .string()
    .trim()
    .min(1)
    .describe('The proposal to take off the plan — one of the ids `add_plan_items` returned.'),
};

interface UpdatePlanProposalArgs extends UpdatePlanItemArgs {
  parentRef?: string | null;
  blockedByRefs?: string[];
  targetRepo?: string | null;
  targetRepoRole?: string | null;
  patch?: Record<string, unknown> | null;
}

interface WithdrawPlanProposalArgs {
  planId: string;
  planItemId: string;
}

interface CreatePlanArgs {
  projectKey: string;
  title?: string;
  summary?: string;
  plannedWithHarness?: string;
  plannedWithModel?: string;
}

interface AddPlanItemsArgs {
  planId: string;
  proposals: z.infer<typeof proposalSchema>[];
  final?: boolean;
}

interface UpdatePlanItemArgs {
  planId: string;
  planItemId: string;
  title?: string;
  kind?: string;
  descriptionMd?: string | null;
  explanationMd?: string | null;
  type?: string | null;
  priority?: string | null;
  executor?: string | null;
  storyPoints?: number | null;
  estimateMinutes?: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Summaries
// ─────────────────────────────────────────────────────────────────────────────

/** ` · written by <harness> · <model>` — the agent half, when self-reported.
 *  The requester half is an id here and a NAME on the surfaces; a tool result
 *  hands back the id its caller can act on, not a display string. */
function attribution(plan: PlanDto): string {
  if (!plan.authorHarness && !plan.authorModel) return '';
  const parts = [plan.authorHarness, plan.authorModel].filter(Boolean);
  return ` · written by ${parts.join(' · ')}`;
}

/** The PROPOSAL GATE, in the words its siblings already use. */
const PROPOSAL_GATE =
  'These are PROPOSALS, not work items. Nothing exists in the tree yet: approving the plan ' +
  'in Motir is the only path from a proposal to a work item, and approval does not happen ' +
  'on this surface. Do not report proposed work as created.';

function summarizeCreate(plan: PlanDto, projectKey: string): string {
  return [
    `Opened plan ${plan.id} on ${projectKey} — ${plan.status}${attribution(plan)}.`,
    plan.title ? `Title: ${plan.title}` : null,
    '',
    `Append proposals with \`${ADD_PLAN_ITEMS_TOOL_NAME}\`, parents before children, and set ` +
      '`final: true` on the last batch to put the plan in front of a reviewer.',
    '',
    PROPOSAL_GATE,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/**
 * The CLOSE-ONLY summary (MOTIR-3193): a final batch that appended nothing.
 *
 * {@link summarizeAppend} would answer it with "Appended 0 proposal(s)" and an
 * empty id list — a description of the CALL, when the thing that happened to the
 * PLAN is that it closed. The text block is the half a human watching the
 * session reads, so it says what changed.
 */
function summarizeClose(plan: PlanWithItemsDto): string {
  // ⚠️ A CLOSE OVER NOTHING DOES NOT REACH THE REVIEW QUEUE (MOTIR-4124), so
  // this note must not say it did. `markPlanned` DISCARDS a plan holding zero
  // proposals — `declined` / `discarded` — because `planned` means somebody is
  // being asked to decide, and there is nothing here to decide. An agent
  // reading "it is in the review queue now" would report a plan as submitted
  // that nobody will ever be shown.
  if (plan.status !== 'planned') {
    return [
      `Closed plan ${plan.id} — ${plan.status}, and it proposed NOTHING. Nothing was appended ` +
        'by this call, and the plan held no proposals to close over.',
      '',
      'It was DISCARDED rather than queued for review: a plan with no proposals asks for a ' +
        'decision there is nothing to make, so it is recorded as ended instead of waiting on ' +
        'somebody. Nobody will be shown it. If you meant to propose something, open a NEW plan ' +
        `with \`${CREATE_PLAN_TOOL_NAME}\` and append before you close it.`,
      '',
      PROPOSAL_GATE,
    ].join('\n');
  }
  return [
    `Closed plan ${plan.id} — ${plan.status}, ${plan.itemCount} proposal(s) in total. ` +
      'Nothing was appended by this call.',
    '',
    'It is in the review queue now and accepts no further proposals: `add_plan_items` and ' +
      `\`${UPDATE_PLAN_ITEM_TOOL_NAME}\` are both refused from here. Read it back with ` +
      `\`${GET_PLAN_TOOL_NAME}\`.`,
    '',
    PROPOSAL_GATE,
  ].join('\n');
}

function summarizeAppend(plan: PlanWithItemsDto, planItemIds: string[]): string {
  return [
    `Appended ${planItemIds.length} proposal(s) to plan ${plan.id} — ${plan.status}, ` +
      `${plan.itemCount} proposal(s) in total.`,
    '',
    'Ids of the proposals THIS call created, in the order you sent them:',
    ...planItemIds.map((id, index) => `  ${index}. ${id}`),
    '',
    'Use `planItem:<id>` with any of those as a `parentRef` or `blockedByRefs` entry on a ' +
      'LATER batch, to hang children off these proposals before they exist as work items.',
    '',
    plan.status === 'planned'
      ? 'This plan is now `planned` — it is in the review queue and accepts no further ' +
        `proposals. Read it back with \`${GET_PLAN_TOOL_NAME}\`.`
      : `Still \`generating\` — send \`final: true\` on your last batch when the tree is complete.`,
    '',
    PROPOSAL_GATE,
  ].join('\n');
}

/**
 * `update_plan_item`'s summary — say WHICH fields this call changed.
 *
 * The list is the ARGUMENT keys the caller sent, not a diff of the stored
 * proposal: an agent that patches `descriptionMd` to the value it already had has
 * still made that call, and a summary claiming otherwise would be answering a
 * question nobody asked. What it does buy is the absent-vs-null distinction being
 * VISIBLE in the transcript — a human watching a deepen pass can see that a call
 * touched two fields and not eight.
 */
function summarizeDeepen(
  plan: PlanWithItemsDto,
  planItemId: string,
  changed: readonly string[],
): string {
  return [
    `Deepened proposal ${planItemId} on plan ${plan.id} — ${plan.status}, ` +
      `${plan.itemCount} proposal(s) in total.`,
    changed.length > 0
      ? `Fields set by this call: ${changed.join(', ')}. Every other field was left as it was.`
      : 'No fields were sent, so nothing changed.',
    '',
    `Still \`generating\` — deepen the rest, then send \`final: true\` on a last ` +
      `\`${ADD_PLAN_ITEMS_TOOL_NAME}\` batch to put the plan in front of a reviewer. ` +
      'After that this tool is refused: a plan somebody is reading does not move.',
    '',
    PROPOSAL_GATE,
  ].join('\n');
}

/**
 * The CORRECTION summary (MOTIR-3541). Deliberately NOT `summarizeDeepen`: the
 * two acts are legal in different statuses and their next steps differ, so the
 * line a caller reads after each has to differ too. A correction on a `planned`
 * plan is the case the whole story exists for, and the summary says what that
 * means — the plan is in front of a reviewer and the change is on its timeline.
 */
function summarizeCorrection(
  plan: PlanWithItemsDto,
  planItemId: string,
  changed: readonly string[],
): string {
  const structural = changed.filter((f) =>
    ['parentRef', 'blockedByRefs', 'targetRepo', 'targetRepoRole', 'patch'].includes(f),
  );
  return [
    `Corrected proposal ${planItemId} on plan ${plan.id} — ${plan.status}, ` +
      `${plan.itemCount} proposal(s) in total.`,
    changed.length > 0
      ? `Fields set by this call: ${changed.join(', ')}. Every other field was left as it was.`
      : 'No fields were sent, so nothing changed.',
    structural.length > 0
      ? `Structural fields (${structural.join(', ')}) were re-validated against this plan's own ` +
        'proposals and against the workspace, so every ref you sent resolves — a `MOTIR-<n>` key ' +
        "was stored as the work item's id, exactly as `add_plan_items` stores one."
      : '',
    '',
    plan.status === 'planned'
      ? 'This plan is `planned` — it is in front of a reviewer, and your correction is on its ' +
        'timeline with the harness and model that made it, so they can see what changed after ' +
        'they started reading.'
      : `Still \`generating\` — send \`final: true\` on a last \`${ADD_PLAN_ITEMS_TOOL_NAME}\` ` +
        'batch to put the plan in front of a reviewer.',
    '',
    PROPOSAL_GATE,
  ]
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapters
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The adapter: resolve the project, open a `generating` plan, stamp the author.
 *
 * `projectsService.getByKey` applies the same browse gate the cookie routes'
 * `getActiveProject` does, so the 404-not-403 cross-tenant contract carries here
 * unchanged (`planSession.ts` documents the same resolution).
 */
export async function runCreatePlan(
  args: CreatePlanArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const projectKey = args.projectKey.trim().toUpperCase();
  const project = await projectsService.getByKey(projectKey, ctx);
  const plan = await plansService.createPlan(
    project.id,
    {
      title: args.title ?? null,
      summary: args.summary ?? null,
      // WHO ASKED (MOTIR-2986) — the TOKEN OWNER. An agent has no standing of
      // its own here: it acts on a credential a person minted and pointed at
      // this project, so that person is the requester, exactly as the person who
      // clicks Generate is on the browser path. Recording it is what stops an
      // agent-authored plan from reading as though nobody is accountable for it.
      createdById: ctx.userId,
      // SERVER-SET. Not an argument, not read from any caller field — the
      // property `materialize` now leans on (ADR Q4).
      authorSource: 'mcp',
      authorHarness: args.plannedWithHarness ?? null,
      authorModel: args.plannedWithModel ?? null,
    },
    ctx,
  );
  return toolOk(
    summarizeCreate(plan, projectKey),
    derived(planPayload, presentMcpPlan({ ...plan, items: [] })),
  );
}

/**
 * Stamp one proposal's planning provenance from the plan's own authorship.
 *
 * Applied to every `add`, unconditionally: the tool's argument schema has no
 * `planningProvenance` member, so there is nothing a caller could have set and
 * nothing to preserve. `plansService.addProposals` still honours a provenance
 * the INTERNAL generator route supplies — that path is untouched.
 */
function stampProvenance(
  proposedFields: PlanItemProposedFields,
  plan: PlanDto,
): PlanItemProposedFields {
  return {
    ...proposedFields,
    planningProvenance: {
      source: plan.authorSource ?? 'mcp',
      harness: plan.authorHarness,
      model: plan.authorModel,
    },
  };
}

/**
 * The adapter: append the batch, optionally close the plan, return the ids the
 * caller needs for the next layer.
 *
 * `planItemIds` is computed the way `aiGenerationService.appendProposals`
 * computes it, and for the same reason it is sound: `addProposals` returns every
 * item in append order under the plan's ROW LOCK, so two concurrent appends to
 * one plan serialize and neither can interleave into the other's slice.
 */
/**
 * `<PREFIX>-<n>` — the identifier EVERY OTHER MCP tool takes (`get_work_item`,
 * `transition_status`, `link_work_items`, `move_to_parent`,
 * `validate_work_item`). MOTIR-3576.
 *
 * ⚠️ IT CANNOT COLLIDE WITH THE TWO FORMS A REF ALREADY CARRIES, and that is
 * what makes accepting it safe rather than ambiguous. A work-item id is a cuid
 * (`cmta2n4os003li3phlyounsxm`) — no dash at all — and an intra-plan temp-ref is
 * `planItem:<cuid>`, which is excluded outright below. So a ref matching this
 * pattern is a key and nothing else.
 */
const WORK_ITEM_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

function isWorkItemKey(ref: string): boolean {
  return !isTempRef(ref) && WORK_ITEM_KEY_PATTERN.test(ref.trim());
}

/**
 * The FIVE sites a ref can travel on — shared by BOTH authoring doors, because
 * they write the same columns (MOTIR-3934).
 *
 * ⚠️ IT IS A SHAPE, NOT A UNION OF THE TWO INPUT TYPES, and that is the point.
 * `ProposalInput` (the append) and `CorrectProposalInput` (the correction)
 * declare these three members identically; naming the shape once is what makes
 * "resolve the key" a property of the FIELD rather than of the door somebody
 * happened to reach for. The defect this closes was exactly that asymmetry: one
 * door honoured all three documented ref forms and the other honoured two.
 */
interface RefCarrierInput {
  parentRef?: string | null;
  blockedByRefs?: string[];
  patch?: PlanItemPatch | null;
}

/** Every ref one proposal (or one correction) carries, across all five sites. */
function refsOfCarrier(p: RefCarrierInput): string[] {
  return [
    ...(p.parentRef ? [p.parentRef] : []),
    ...(p.blockedByRefs ?? []),
    // The RE-PARENT ref (MOTIR-3859) takes a key exactly like the other four
    // sites — an agent that has just called `get_work_item { key: 'MOTIR-656' }`
    // has no reason to believe the argument changed meaning three lines later,
    // which is this function's whole argument.
    ...(p.patch?.parentRef ? [p.patch.parentRef] : []),
    ...(p.patch?.blockedByAdd ?? []),
    ...(p.patch?.blockedByRemove ?? []),
  ];
}

/**
 * ONE batched resolution for a whole call: every KEY-form ref across every
 * carrier, de-duplicated, through the same permission-scoped service every
 * key-addressed tool uses — so the 404-not-403 cross-tenant contract holds
 * unchanged. Returns the swap to apply per ref; a non-key ref (a cuid, a
 * `planItem:` temp-ref) maps to itself.
 */
async function keyRefSwapper(
  carriers: RefCarrierInput[],
  ctx: ServiceContext,
): Promise<(ref: string) => string> {
  const keys = [...new Set(carriers.flatMap(refsOfCarrier).filter(isWorkItemKey))];
  if (keys.length === 0) return (ref) => ref;

  let ids: string[];
  try {
    ids = await resolveWorkItemIdsByKeys(keys, ctx);
  } catch {
    // A key that resolves to nothing is the SAME failure as a dangling id, and
    // it is reported as one: one failure mode for "this ref names no work
    // item", not two that a caller has to tell apart. The offending key is
    // named; which of a batch's keys failed is recoverable from the message.
    throw new PlanRefGraphError(
      'dangling',
      'incoming',
      `A proposal's ref names no work item in this workspace. One of ${keys
        .map((k) => `"${k}"`)
        .join(', ')} could not be resolved — check the key, or pass the work item's id.`,
    );
  }

  const byKey = new Map(keys.map((k, i) => [k, ids[i]!]));
  return (ref) => byKey.get(ref) ?? ref;
}

/**
 * Swap the KEY-form refs inside a `modify`'s patch, PRESERVING absence.
 *
 * A `null` patch (the correction door's "clear it") and an absent one are both
 * returned untouched — the sparse contract is the caller's, not this
 * function's.
 */
function swapPatchRefs(
  patch: PlanItemPatch | null | undefined,
  swap: (ref: string) => string,
): PlanItemPatch | null | undefined {
  if (!patch) return patch;
  return {
    ...patch,
    ...(patch.parentRef ? { parentRef: swap(patch.parentRef) } : {}),
    ...(patch.blockedByAdd ? { blockedByAdd: patch.blockedByAdd.map(swap) } : {}),
    ...(patch.blockedByRemove ? { blockedByRemove: patch.blockedByRemove.map(swap) } : {}),
  };
}

/**
 * Rewrite every `MOTIR-<n>`-form ref to the work-item ID the plan substrate
 * stores (MOTIR-3576).
 *
 * ⚠️ WHY THIS EXISTS AT ALL. `parentRef` / `blockedByRefs` are documented as
 * "a REAL work-item id", and the KEY form was neither resolved nor refused — it
 * was ACCEPTED, stored, passed `validate_plan`, closed to `planned`, and then
 * failed at the approve button with `dangling`, where the plan is immutable and
 * the only repair is to author a new one. An agent that has just called
 * `get_work_item { key: 'MOTIR-3440' }` has no reason to believe the argument
 * changed meaning three lines later, so the plan tools now agree with the rest
 * of the surface instead of asking the caller to remember an exception.
 *
 * ⚠️ AND IT RESOLVES ON THE WAY IN, never on the way out. A ref is not just an
 * argument: it is a value stored on the row and re-read at approve, by the
 * projection, and by `planStalenessService.isRealRef`. Translating here leaves
 * every one of those readers untouched and the column meaning exactly what it
 * meant; translating at read time would give it two possible contents for ever.
 *
 * ONE batched resolution per call, keys de-duplicated first, through the same
 * permission-scoped services every other key-addressed tool uses — so the
 * 404-not-403 cross-tenant contract holds unchanged.
 */
async function resolveKeyRefs(
  proposals: ProposalInput[],
  ctx: ServiceContext,
): Promise<ProposalInput[]> {
  const swap = await keyRefSwapper(proposals, ctx);
  return proposals.map((p) => ({
    ...p,
    parentRef: p.parentRef ? swap(p.parentRef) : p.parentRef,
    blockedByRefs: (p.blockedByRefs ?? []).map(swap),
    patch: swapPatchRefs(p.patch, swap),
  }));
}

/**
 * The SAME resolution, on the CORRECTION door (MOTIR-3934).
 *
 * ⚠️ WHY IT IS A SECOND FUNCTION AND NOT A SECOND CALLER OF THE ONE ABOVE. The
 * two inputs differ in exactly one way that matters here, and it is the way that
 * loses data: an append's `blockedByRefs` DEFAULTS to `[]`, so `?? []` is free,
 * while a correction's `blockedByRefs` is SPARSE — `undefined` leaves the set
 * alone and `[]` CLEARS it. Materialising the default would turn every
 * correction of some other field into a silent edge wipe. So the swap is written
 * against this input's own contract: absent stays absent, `null` stays `null`.
 *
 * Everything else is shared with the append — the same five sites, the same
 * batched lookup, the same `dangling` refusal — which is the whole fix. The
 * defect was one door resolving and the other storing the key verbatim, so a
 * `MOTIR-<n>` written through the correction door reached approve as a string
 * nothing could match.
 */
async function resolveCorrectionKeyRefs(
  input: CorrectProposalInput,
  ctx: ServiceContext,
): Promise<CorrectProposalInput> {
  const swap = await keyRefSwapper([input], ctx);
  const resolved: CorrectProposalInput = { ...input };
  if (input.parentRef) resolved.parentRef = swap(input.parentRef);
  if (input.blockedByRefs !== undefined) resolved.blockedByRefs = input.blockedByRefs.map(swap);
  if (input.patch) resolved.patch = swapPatchRefs(input.patch, swap) as PlanItemPatch;
  return resolved;
}

export async function runAddPlanItems(
  args: AddPlanItemsArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  // The cross-field half of the argument grammar (MOTIR-3193). An EMPTY batch is
  // legal ONLY as a CLOSE; empty with no `final` would do nothing at all, and a
  // call that does nothing is a mistake the caller wants to hear about — a
  // forgotten flag, or a batch mapped from a list that turned out to be empty.
  // It lives here rather than in the zod shape because `registerTool` takes a
  // `ZodRawShape`, which has no place to hang a refinement across two keys.
  if (args.proposals.length === 0 && !args.final) {
    throw new InvalidProposalError(
      '`proposals` is empty and `final` is not set, so this call would append nothing and ' +
        'leave the plan `generating`. Send `final: true` with an empty batch to CLOSE the plan ' +
        '(`generating` → `planned`, the review queue), or send at least one proposal to append.',
    );
  }

  // Read the plan FIRST — its authorship is what each proposal is stamped with,
  // and the read applies the same browse gate every plan path applies (a
  // cross-tenant id 404s rather than 403s).
  const existing = await plansService.getPlan(args.planId, ctx);

  const proposals: ProposalInput[] = args.proposals.map((p) => ({
    op: p.op,
    workItemId: p.workItemId ?? null,
    proposedFields:
      p.op === 'add' && p.proposedFields
        ? stampProvenance(p.proposedFields as PlanItemProposedFields, existing)
        : null,
    patch: (p.patch ?? null) as ProposalInput['patch'],
    parentRef: p.parentRef ?? null,
    blockedByRefs: p.blockedByRefs ?? [],
    baseRevision: p.baseRevision ?? null,
  }));

  // KEY → ID, before the service sees them (MOTIR-3576). The plan substrate's
  // contract is unchanged: what reaches `addProposals`, and what lands in the
  // column, is an id or a `planItem:` temp-ref exactly as before.
  const resolved = await resolveKeyRefs(proposals, ctx);

  // An EMPTY batch still goes through `addProposals`: it creates nothing, and it
  // is what re-reads the plan under its row lock and refuses a plan that has
  // already left `generating` — the same refusal a non-empty close would get.
  const appended = await plansService.addProposals(args.planId, resolved, ctx);
  const planItemIds = appended.items
    .slice(appended.items.length - resolved.length)
    .map((i) => i.id);

  // `final` composes exactly as the internal seam composes it: append, then
  // close. `markPlanned` re-locks and re-reads, so a racing append is refused
  // rather than silently landing on a `planned` plan.
  const plan = args.final
    ? { ...(await plansService.markPlanned(args.planId, ctx)), items: appended.items }
    : appended;

  return toolOk(
    args.proposals.length === 0 ? summarizeClose(plan) : summarizeAppend(plan, planItemIds),
    derived(planAppendPayload, presentMcpPlanAppend(plan, planItemIds)),
  );
}

/**
 * The adapter: deepen ONE proposal on a `generating` plan.
 *
 * Three things it does and one it deliberately does not:
 *
 * 1. **Rebuild the patch with PRESENCE checks, never defaults.** `'key' in args`
 *    is the whole absent-vs-null contract — `mergeProposedFields` tests each key
 *    `!== undefined`, so a key this adapter invents as `null` CLEARS a field the
 *    caller never mentioned. This is the same shape the shipped review route
 *    (`app/api/plans/[id]/items/[itemId]/route.ts`) uses, for the same reason.
 * 2. **Resolve by `planId`.** `plansService.deepenProposal` takes the plan id
 *    directly; the internal seam's `sourceJobId` lookup is not reusable here
 *    because an MCP-authored plan has no generation job (module header).
 * 3. **Report which fields the CALL set** — see {@link summarizeDeepen}.
 *
 * It does NOT pre-read the plan. `add_plan_items` does, because it stamps each
 * `add`'s provenance from the plan's own authorship; a deepen stamps nothing, and
 * `editAddProposal` resolves, gates (`ai:view_plan`), locks and re-reads the plan
 * itself. A read here would add a round trip and a second, weaker existence check
 * in front of the real one.
 */
export async function runUpdatePlanItem(
  args: UpdatePlanItemArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const patchable = [
    'title',
    'kind',
    'descriptionMd',
    'explanationMd',
    'type',
    'priority',
    'executor',
    'storyPoints',
    'estimateMinutes',
  ] as const satisfies readonly UpdateProposalKey[];

  const input: UpdateProposalInput = {};
  const changed: string[] = [];
  for (const key of patchable) {
    // PRESENCE, then a belt-and-braces `undefined` skip. `mergeProposedFields`
    // tests each key `!== undefined`, so an `undefined` that slipped through
    // would merge as absent anyway — but it would still be COUNTED as changed,
    // and the summary would tell a reader this call touched a field it did not.
    // (`undefined` cannot arrive over JSON; this survives a zod version that
    // materializes missing optional keys.)
    if (!(key in args) || args[key] === undefined) continue;
    // The value is already narrowed by the zod schema to the member's own type;
    // the assignment is per-key so no `any` widens the input.
    (input as Record<string, unknown>)[key] = args[key];
    changed.push(key);
  }

  const plan = await plansService.deepenProposal(args.planId, args.planItemId, input, ctx);

  return toolOk(
    summarizeDeepen(plan, args.planItemId, changed),
    derived(planPayload, presentMcpPlan(plan)),
  );
}

/**
 * CORRECT a proposal on a `generating` or `planned` plan (MOTIR-3541) — a
 * transport over `plansService.correctProposal`, adding no logic of its own.
 *
 * The key gap between this and `runUpdatePlanItem` is the patchable list: it
 * carries the four STRUCTURAL members AMENDMENT 8 opened, and the same
 * presence-then-`undefined` discipline applies to every one of them so the
 * summary cannot claim a field this call did not touch.
 */
export async function runUpdatePlanProposal(
  args: UpdatePlanProposalArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const patchable = [
    'title',
    'kind',
    'descriptionMd',
    'explanationMd',
    'type',
    'priority',
    'executor',
    'storyPoints',
    'estimateMinutes',
    'parentRef',
    'blockedByRefs',
    'targetRepo',
    'targetRepoRole',
    'patch',
  ] as const satisfies readonly CorrectProposalKey[];

  const input: CorrectProposalInput = {};
  const changed: string[] = [];
  for (const key of patchable) {
    if (!(key in args) || args[key] === undefined) continue;
    (input as Record<string, unknown>)[key] = args[key];
    changed.push(key);
  }

  // KEY → ID, before the service sees them (MOTIR-3934) — the same rewrite
  // `add_plan_items` applies, at the same layer, so the two doors cannot store
  // different things in one column. A key that names nothing is refused HERE,
  // where it is written, rather than at the approve button on a plan a reviewer
  // has already read.
  const resolved = await resolveCorrectionKeyRefs(input, ctx);

  const plan = await plansService.correctProposal(args.planId, args.planItemId, resolved, ctx);

  return toolOk(
    summarizeCorrection(plan, args.planItemId, changed),
    derived(planPayload, presentMcpPlan(plan)),
  );
}

/**
 * WITHDRAW a proposal from a `generating` or `planned` plan (MOTIR-3541) — a
 * transport over `plansService.withdrawProposal`.
 */
export async function runWithdrawPlanProposal(
  args: WithdrawPlanProposalArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const plan = await plansService.withdrawProposal(args.planId, args.planItemId, ctx);

  return toolOk(
    `Withdrew proposal ${args.planItemId} from plan ${plan.id}${attribution(plan)}. ` +
      `${plan.items.length} proposal${plan.items.length === 1 ? '' : 's'} left on the plan. ` +
      PROPOSAL_GATE,
    derived(planPayload, presentMcpPlan(plan)),
  );
}

export function registerAuthorPlan(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    CREATE_PLAN_TOOL_NAME,
    {
      title: 'Open a plan to propose into',
      description:
        'Open a PLAN on a project — the reviewable container you then fill with proposals ' +
        `using \`${ADD_PLAN_ITEMS_TOOL_NAME}\`. This is how an agent proposes work in Motir ` +
        'instead of writing it: `create_work_item` puts a real item in the tree immediately, ' +
        'whereas a plan is read, diffed and APPROVED by a person first. Reach for this one ' +
        'when you have decomposed work yourself and want somebody to sign off on the shape ' +
        'before it becomes real. Pass `plannedWithHarness` / `plannedWithModel` to say who ' +
        'is writing it — the reviewer sees that, and every work item the plan eventually ' +
        'creates records it too. ' +
        'IMPORTANT: this creates NO work item. Approving the plan in Motir is the only path ' +
        'from a proposal to a work item, and approval does not happen on this surface. Costs ' +
        'nothing and starts no job — no AI credits are spent.',
      inputSchema: createPlanInputSchema,
    },
    async (args, extra) => {
      try {
        return await runCreatePlan(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    ADD_PLAN_ITEMS_TOOL_NAME,
    {
      title: 'Append proposals to a plan',
      description:
        'Append a batch of proposals — `add` a new item, `modify` an existing one, `remove` ' +
        'one — to a plan you opened with ' +
        `\`${CREATE_PLAN_TOOL_NAME}\`. Returns \`planItemIds\`: the ids of the proposals THIS ` +
        'call created, IN THE ORDER YOU SENT THEM. That order is the contract you build a ' +
        'tree with: pass `planItem:<id>` as a later proposal’s `parentRef` or ' +
        '`blockedByRefs` entry to hang it under one of these, before any of them exists as a ' +
        'work item. So send a tree LAYER BY LAYER, parents before children, and set ' +
        '`final: true` on the last batch — that closes the plan (`generating` → `planned`) ' +
        'and puts it in the review queue. Appending to an already-closed plan is refused. ' +
        'A TITLES-FIRST pass — append the shape, then fill each card in with ' +
        `\`${UPDATE_PLAN_ITEM_TOOL_NAME}\` — has nothing left to append when it is done, so ` +
        'CLOSE it by calling this with `proposals: []` and `final: true`. An empty batch is ' +
        'legal only that way: without `final` it would do nothing, and is refused. ' +
        'IMPORTANT: this creates NO work item. Approving the plan in Motir is the only path ' +
        'from a proposal to a work item, and approval does not happen on this surface — do ' +
        'not report proposed work as created. Costs nothing and starts no job. ' +
        'ONE PROPOSAL PER EXISTING TARGET: a plan holds at most one `modify` or ' +
        '`remove` for any given `workItemId`, so a second one is refused with ' +
        '`DUPLICATE_PLAN_TARGET` naming the item. The rule is deliberate — a ' +
        'proposal stores only the NEW values and the review surface reads each ' +
        'diff’s OLD side live from the target, so two patches on one card would ' +
        'render as two diffs from the same committed state and the reviewer would ' +
        'approve something neither of them says. When you need a second change to ' +
        'a card you have already patched, fold it into that one `modify`; and when ' +
        'what you are recording is a dependency edge between two work items that ' +
        'ALREADY exist, use `link_work_items` instead — an edge between ' +
        'committed items needs no proposal at all.',
      inputSchema: addPlanItemsInputSchema,
    },
    async (args, extra) => {
      try {
        return await runAddPlanItems(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    UPDATE_PLAN_ITEM_TOOL_NAME,
    {
      title: 'Deepen a proposal you appended',
      description:
        'Fill in a proposal you already appended to a plan that is still being written — the ' +
        'SECOND phase of a titles-first author. Phase one: append title-only proposals with ' +
        `\`${ADD_PLAN_ITEMS_TOOL_NAME}\` so the SHAPE of the tree is settled and its parent / ` +
        'dependency edges are wired. Phase two: call this once per proposal to write its ' +
        'description and explanation, its work type, priority, executor and sizing — now that ' +
        'you can see every sibling you proposed. The patch is SPARSE: a field you omit is left ' +
        'exactly as it was, and an explicit `null` clears it. Address the proposal by the id ' +
        `\`${ADD_PLAN_ITEMS_TOOL_NAME}\` returned for it in \`planItemIds\`. Legal only while ` +
        'the plan is still `generating` — once you send `final: true` it is in front of a ' +
        'reviewer and stops moving, and this tool refuses, naming the status. It cannot ' +
        're-parent a proposal, change its dependency edges or re-pin its repo: those are the ' +
        'shape you settled in phase one. ' +
        'IMPORTANT: this creates NO work item and changes nothing in the tree. Approving the ' +
        'plan in Motir is the only path from a proposal to a work item, and approval does not ' +
        'happen on this surface. Costs nothing and starts no job.',
      inputSchema: updatePlanItemInputSchema,
    },
    async (args, extra) => {
      try {
        return await runUpdatePlanItem(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    UPDATE_PLAN_PROPOSAL_TOOL_NAME,
    {
      title: 'Correct a proposal, including its structure',
      description:
        'Correct a proposal you already appended — the repair for a mistake you can see but ' +
        `could not fix. Unlike \`${UPDATE_PLAN_ITEM_TOOL_NAME}\`, this reaches the STRUCTURAL ` +
        'fields: `parentRef`, `blockedByRefs`, `targetRepo`, `targetRepoRole`, and a `modify` ' +
        'proposal’s `patch` — which is where a mistyped dependency edge usually sits. Legal ' +
        'while the plan is ' +
        '`generating` AND after you have closed it with `final: true`, while it is `planned` ' +
        'and waiting for a reviewer. It is REFUSED once the plan is `approved` (its proposals ' +
        'have become work items, so `update_work_item` is the door — the refusal says so) or ' +
        '`declined` (a closed decision). The patch is SPARSE: a field you omit is left exactly ' +
        'as it was and an explicit `null` clears it — EXCEPT `blockedByRefs`, which is a list ' +
        'and REPLACES the set, so send the edges you want and `[]` to clear them. Every ' +
        'structural correction re-runs the append’s own ref check, so you cannot correct your ' +
        'way into a `planItem:` ref that names nothing, and a ref to the proposal itself is ' +
        'refused rather than stored. The correction appears on the plan’s timeline with the ' +
        'harness and model that made it, so a reviewer can see the tree changed under them. ' +
        'IMPORTANT: this creates NO work item and changes nothing in the tree. Approving the ' +
        'plan in Motir is the only path from a proposal to a work item, and approval does not ' +
        'happen on this surface. Costs nothing and starts no job.',
      inputSchema: updatePlanProposalInputSchema,
    },
    async (args, extra) => {
      try {
        return await runUpdatePlanProposal(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    WITHDRAW_PLAN_PROPOSAL_TOOL_NAME,
    {
      title: 'Take a proposal off a plan',
      description:
        'Remove one proposal from a plan you are writing, or one you have already closed for ' +
        'review — so a proposal you should not have appended does not have to be declined by a ' +
        'person along with everything around it. Legal while the plan is `generating` or ' +
        '`planned`; REFUSED once it is `approved` (its proposals have become work items — ' +
        'archive the work item instead) or `declined`. If another proposal on the plan still ' +
        'references this one through a `planItem:` ref, the call is REFUSED and names every ' +
        'referrer rather than leaving their refs pointing at nothing: correct or withdraw ' +
        'those first, then retry. Withdrawing a `modify` RELEASES its target work item, so you ' +
        'can append a corrected `modify` for that item where a second one was previously ' +
        'refused as a duplicate target. This is NOT the `remove` op, which PROPOSES deleting an ' +
        'existing work item from the tree at approve — this takes a proposal off the plan and ' +
        'nothing in the tree is touched either way. Costs nothing and starts no job.',
      inputSchema: withdrawPlanProposalInputSchema,
    },
    async (args, extra) => {
      try {
        return await runWithdrawPlanProposal(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
