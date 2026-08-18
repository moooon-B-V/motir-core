import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectsService } from '@/lib/services/projectsService';
import { plansService } from '@/lib/services/plansService';
import type {
  PlanDto,
  PlanItemProposedFields,
  PlanWithItemsDto,
  ProposalInput,
} from '@/lib/dto/plans';
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
// the boundary. This module is zod argument schemas, two adapters and error
// mapping — the shape `planSession.ts` and `getPlan.ts` are built to.
//
// ── The TWO tools, and why not one or three (ADR Q1) ───────────────────────
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
// ── NEITHER TOOL IS BILLABLE ───────────────────────────────────────────────
// `MCP_BILLABLE_TOOLS` (`lib/mcp/rateLimitGate.ts`) holds exactly the tools that
// make motir-ai run a model job. These spend no provider tokens and start no
// job — they are database writes, covered by the transport's own `mcp:call`
// limit like every other write tool. Adding them would cap plan authoring
// against the owner's GENERATION allowance for no reason.

export const CREATE_PLAN_TOOL_NAME = 'create_plan';
export const ADD_PLAN_ITEMS_TOOL_NAME = 'add_plan_items';

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
      .string()
      .optional()
      .describe('Leaf work type (code / design / test / decision / manual / …).'),
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

const proposalSchema = z.object({
  op: z.enum(['add', 'modify', 'remove']).describe('add a new item, modify one, or remove one.'),
  workItemId: z
    .string()
    .optional()
    .describe('`modify` / `remove` only: the existing target work item’s id.'),
  proposedFields: proposedFieldsSchema.optional(),
  patch: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('`modify` only: the sparse patch to apply to the target at approve.'),
  parentRef: z
    .string()
    .optional()
    .describe(
      'Where the proposed item hangs: a REAL work-item id (to parent it under something that ' +
        'already exists), or `planItem:<id>` naming another `add` in THIS plan — an id this ' +
        'tool returned in `planItemIds` on an earlier call.',
    ),
  blockedByRefs: z
    .array(z.string())
    .optional()
    .describe(
      'Dependency edges, in the same two forms as `parentRef`: real work-item ids, or ' +
        '`planItem:<id>` refs into this plan.',
    ),
  baseRevision: z
    .string()
    .optional()
    .describe('`modify` / `remove` only: the target revision the change was computed against.'),
});

const addPlanItemsInputSchema = {
  planId: z.string().trim().min(1).describe('The plan id `create_plan` returned.'),
  proposals: z
    .array(proposalSchema)
    .min(1)
    .describe('The batch to append, in the order you want their ids back.'),
  final: z
    .boolean()
    .optional()
    .describe(
      'Set true on the LAST batch to close the plan (`generating` → `planned`), which is what ' +
        'puts it in front of a person for review. Appending after that is refused.',
    ),
};

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
export async function runAddPlanItems(
  args: AddPlanItemsArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
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

  const appended = await plansService.addProposals(args.planId, proposals, ctx);
  const planItemIds = appended.items
    .slice(appended.items.length - proposals.length)
    .map((i) => i.id);

  // `final` composes exactly as the internal seam composes it: append, then
  // close. `markPlanned` re-locks and re-reads, so a racing append is refused
  // rather than silently landing on a `planned` plan.
  const plan = args.final
    ? { ...(await plansService.markPlanned(args.planId, ctx)), items: appended.items }
    : appended;

  return toolOk(
    summarizeAppend(plan, planItemIds),
    derived(planAppendPayload, presentMcpPlanAppend(plan, planItemIds)),
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
        'IMPORTANT: this creates NO work item. Approving the plan in Motir is the only path ' +
        'from a proposal to a work item, and approval does not happen on this surface — do ' +
        'not report proposed work as created. Costs nothing and starts no job.',
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
}
