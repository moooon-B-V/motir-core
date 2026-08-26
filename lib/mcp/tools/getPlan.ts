import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import type { PlanItemDto, PlanItemOpDto, PlanWithItemsDto } from '@/lib/dto/plans';
import { isTempRef, tempRefId } from '@/lib/plans/refs';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import { planPayload, presentMcpPlan } from '../payloads/workLoop';
import { GET_PLAN_STATUS_TOOL_NAME } from './expandItem';

// `get_plan` (Story 7.9 · MOTIR-1837) — the plan read that returns WHAT was
// proposed, not just how many.
//
// Why it exists: `get_plan_status` (MOTIR-1825) answers "what became of the job
// I fired?" with a `PlanOutcomeDto` — a status and an `itemCount`. That is
// enough to know a planning pass landed, and nothing at all about whether it
// landed WELL. The items themselves have shipped as a DTO since the 7.21
// substrate (`PlanWithItemsDto`), but the only way to reach them was
// `GET /api/plans/[id]` — cookie-authed, so unreachable from an MCP client. A
// headless caller could therefore print a count and a URL, and then had to send
// its user to a browser at exactly the moment they needed to judge the output.
//
// This is a TRANSPORT, not a second read path: `plansService.getPlan` is the
// same method the cookie route's review model reads through, and it already
// applies the workspace scoping + `canBrowse` gate, so the 404-not-403
// cross-tenant contract carries here unchanged. No new DTO, no re-mapping, no
// pagination invented at this layer (the service exposes none).
//
// The same PROPOSAL GATE its siblings carry applies, and for a sharper reason:
// this tool hands back titles, kinds and sizing that read exactly like work
// items. They are not. `plansService.approvePlan` is the only path from a
// proposal to a `work_item` row, and an `add`'s `workItemId` stays `null` until
// then.
//
// ⚠️ AMENDED 2026-08-19 (MOTIR-3021). This used to read "a human decision made
// in Motir", and the ONLY-PATH half is still exactly true — approve remains the
// single proposal→row write. What is no longer true is that it happens only in
// the app: `POST /api/v1/plans/{planId}/approval` is a bounded public entrance
// an operator's `motir auto --auto-approve-replan` drives
// (`docs/decisions/run-findings-protocol.md` Q2). It is deliberately NOT an MCP
// tool — MCP is the AGENT's surface, and an agent must never approve its own
// re-plan — so nothing about THIS tool's reach changed.

export const GET_PLAN_TOOL_NAME = 'get_plan';

const getPlanInputSchema = {
  planId: z
    .string()
    .trim()
    .min(1)
    .describe(
      'The plan id — as returned by an `expand_item` submit, by `get_plan_status`, or shown ' +
        'on the plan in Motir.',
    ),
};

/** The op markers the review surface uses: add / modify / remove. */
const OP_MARKER: Record<PlanItemOpDto, string> = { add: '+', modify: '~', remove: '-' };

/** ` (3 pts · 40m)` — the leaf sizing, when the proposal carries any. */
function sizing(
  storyPoints: number | null | undefined,
  estimateMinutes: number | null | undefined,
) {
  const parts: string[] = [];
  if (storyPoints != null) parts.push(`${storyPoints} pts`);
  if (estimateMinutes != null) parts.push(`${estimateMinutes}m`);
  return parts.length > 0 ? ` (${parts.join(' · ')})` : '';
}

/** ` · repo: <name>` — WHICH REPO the proposal pins the item to (MOTIR-1884).
 *  Omitted when unpinned, so a single-repo project's plan reads exactly as it
 *  did before pins existed. */
function repoPin(targetRepo: string | null | undefined): string {
  return targetRepo ? ` · repo: ${targetRepo}` : '';
}

/** ` · blocked_by: <ref>, <ref>` — the proposed dependency edges, verbatim (a
 *  real work-item id or an intra-plan `planItem:` temp-ref). */
function blockers(refs: string[]): string {
  return refs.length > 0 ? ` · blocked_by: ${refs.join(', ')}` : '';
}

/**
 * Where a proposal sits in the COMMITTED tree, and what its target is CALLED —
 * the half of the rendering that cannot be read off a `PlanItemDto` (bug
 * MOTIR-3191). Supplied by the caller from `planReviewService.getPlanReview`,
 * keyed by `planItemId`; absent for a client that has no tree to resolve against,
 * and the rendering then degrades to the flat list it was.
 */
export interface ProposalPlacement {
  /** The target's own key (`MOTIR-3181`), when the proposal has a live target. */
  identifier: string | null;
  /** The committed parent's id — the grouping key. */
  parentNodeId: string | null;
  /** The committed ancestor path down to that parent, ROOT FIRST. */
  parentTrail: { identifier: string; title: string }[];
}

export type PlacementByPlanItemId = ReadonlyMap<string, ProposalPlacement>;

/** One proposal as a single line — the op, what it targets, and its sizing. */
function describeItem(item: PlanItemDto, placement?: ProposalPlacement): string {
  const marker = OP_MARKER[item.op];
  if (item.op === 'add') {
    const fields = item.proposedFields;
    const kind = fields?.kind ?? 'task';
    const type = fields?.type ? `/${fields.type}` : '';
    const title = fields?.title ?? '(untitled)';
    return (
      `${marker} [${kind}${type}] ${title}` +
      sizing(fields?.storyPoints, fields?.estimateMinutes) +
      repoPin(fields?.targetRepo) +
      blockers(item.blockedByRefs)
    );
  }
  // The target by its KEY when the tree could be read (MOTIR-3191). `MOTIR-3181`
  // is what the reviewer knows the card as; the cuid this used to print is an
  // identifier for the database and for nobody reading a plan.
  const target = placement?.identifier ?? item.workItemId ?? '(no target)';
  if (item.op === 'remove') return `${marker} remove ${target}`;
  const patch = item.patch ?? {};
  const changed = Object.keys(patch).filter(
    (key) => patch[key as keyof typeof patch] !== undefined,
  );
  return (
    `${marker} modify ${target}` +
    (changed.length > 0 ? ` — ${changed.join(', ')}` : '') +
    blockers(item.blockedByRefs)
  );
}

/** `under MOTIR-2200 ▸ MOTIR-3154 — A DECIDED plan's cards vanish:` — the live
 *  branch a group of proposals hangs off, named the way the canvas breadcrumb
 *  names it. */
function groupHeading(trail: { identifier: string; title: string }[]): string {
  const chain = trail.map((c) => c.identifier).join(' ▸ ');
  const parent = trail.at(-1)!;
  return `under ${chain} — ${parent.title}:`;
}

/**
 * The proposals as an indented tree, so a terminal client that ignores
 * `structuredContent` can still SEE the shape that was proposed.
 *
 * Nesting inside the PLAN follows `parentRef`'s intra-plan temp-ref form
 * (`planItem:<id>`) — an `add` under another `add` in this same plan.
 *
 * Everything else hangs off a branch of the LIVE tree, and is grouped under a
 * heading that names it (bug MOTIR-3191). That covers a `parentRef` pointing at a
 * real work item, and — the case this fixes — a `modify` / `remove`, which
 * carries no `parentRef` at all and inherits its target's position. Un-indented,
 * the two were indistinguishable from an `add` at the PROJECT ROOT, which the
 * plan rules reserve for epics: a plan of two amendments read as two new
 * root-level cards, and was correctly declined on that reading.
 *
 * With no `placements` (a caller that could not resolve the tree) this degrades
 * to exactly the flat rendering it had — the same contract every other
 * tree-resolution failure on this surface takes.
 */
function renderProposals(items: PlanItemDto[], placements?: PlacementByPlanItemId): string[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const childrenOf = new Map<string, PlanItemDto[]>();
  const roots: PlanItemDto[] = [];
  for (const item of items) {
    const parentId = item.parentRef && isTempRef(item.parentRef) ? tempRefId(item.parentRef) : null;
    if (parentId != null && byId.has(parentId)) {
      const siblings = childrenOf.get(parentId);
      if (siblings) siblings.push(item);
      else childrenOf.set(parentId, [item]);
    } else {
      roots.push(item);
    }
  }

  const lines: string[] = [];
  const rendered = new Set<string>();
  const walk = (item: PlanItemDto, depth: number): void => {
    // Defensive: a temp-ref CYCLE has no root, and would otherwise recurse until
    // the stack blows. `addProposals` rejects one at the boundary, so this is a
    // backstop for rows that reached the table some other way — never a normal
    // path.
    if (rendered.has(item.id)) return;
    rendered.add(item.id);
    lines.push(`${'  '.repeat(depth + 1)}${describeItem(item, placements?.get(item.id))}`);
    for (const child of childrenOf.get(item.id) ?? []) walk(child, depth + 1);
  };

  // The live-tree branches, in the order they first appear, so a plan's own
  // ordering survives the grouping.
  const groups = new Map<string, { heading: string; items: PlanItemDto[] }>();
  const ungrouped: PlanItemDto[] = [];
  for (const root of roots) {
    const placement = placements?.get(root.id);
    const trail = placement?.parentTrail ?? [];
    if (!placement?.parentNodeId || trail.length === 0) {
      ungrouped.push(root);
      continue;
    }
    const group = groups.get(placement.parentNodeId);
    if (group) group.items.push(root);
    else groups.set(placement.parentNodeId, { heading: groupHeading(trail), items: [root] });
  }

  for (const root of ungrouped) walk(root, 0);
  for (const { heading, items: grouped } of groups.values()) {
    lines.push(`  ${heading}`);
    for (const item of grouped) walk(item, 1);
  }
  // Anything a cycle kept out of the root set is still the caller's data — print
  // it rather than silently dropping proposals from a list the client trusts.
  for (const item of items) walk(item, 0);
  return lines;
}

/** The human-readable block: the plan's own line, then its proposal tree.
 *  `placements` (MOTIR-3191) is what lets a proposal about an EXISTING card be
 *  drawn where that card lives; without it the tree renders flat, as it did. */
export function summarizePlan(plan: PlanWithItemsDto, placements?: PlacementByPlanItemId): string {
  const lines = [
    `Plan ${plan.id} — ${plan.status}, ${plan.itemCount} proposal(s).`,
    `Project ${plan.projectId} · origin ${plan.origin}` +
      (plan.sourceJobId ? ` · job ${plan.sourceJobId}` : ''),
  ];
  if (plan.title) lines.push(`Title: ${plan.title}`);
  if (plan.summary) lines.push(`Summary: ${plan.summary}`);

  lines.push('');
  if (plan.items.length === 0) {
    lines.push(
      plan.status === 'generating'
        ? 'No proposals have arrived yet — the planner is still generating this plan.'
        : 'This plan bundles no proposals.',
    );
  } else {
    lines.push(
      'Proposals (indented under their proposed parent):',
      ...renderProposals(plan.items, placements),
    );
  }

  lines.push(
    '',
    plan.status === 'approved'
      ? 'This plan was approved — its proposals were materialized into work items.'
      : 'These are PROPOSALS, not work items. Approving the plan in Motir is the only thing ' +
          "that creates one, and an `add`'s workItemId stays null until then.",
  );

  // ⚠️ `stale` NEEDS SAYING, because the bare status word above does not carry
  // it (MOTIR-3578). An agent reading `stale` off line 1 has no way to know the
  // plan is unapprovable-but-live rather than a variant of `declined`, and the
  // wrong reading costs it the same wasted repair MOTIR-3560 was filed about:
  // authoring a whole replacement plan for one that may simply come back.
  if (plan.status === 'stale') {
    lines.push(
      '',
      'STALE: this plan reached a reviewer and can no longer be approved, because work it ' +
        'proposes to change has since been finished. It is NOT decided and NOT declined — the ' +
        'plan is live, and if the drift reverses (a target leaves its terminal status) it ' +
        'returns to `planned` on its own. Do NOT author a replacement plan on seeing this; ' +
        'the reviewer decides whether to wait or decline.',
    );
  }
  return lines.join('\n');
}

/**
 * Where each proposal sits in the live tree — the SAME resolution the plan-review
 * canvas draws from, so the two surfaces cannot disagree about what a plan
 * proposes (bug MOTIR-3191). Read separately because `PlanWithItemsDto` carries
 * refs and ids, and placement is a question about the WORK ITEMS those ids name.
 *
 * BEST-EFFORT on purpose: this enriches a rendering that already worked without
 * it, and the tool's job — hand back what was proposed — must not start failing
 * because a tree read did. A failure degrades to the flat list.
 */
async function resolvePlacements(
  planId: string,
  ctx: ServiceContext,
): Promise<PlacementByPlanItemId | undefined> {
  try {
    const review = await planReviewService.getPlanReview(planId, ctx);
    return new Map(
      review.items.map((item) => [
        item.planItemId,
        {
          identifier: item.identifier,
          parentNodeId: item.parentNodeId,
          parentTrail: item.parentTrail.map((c) => ({
            identifier: c.identifier,
            title: c.title,
          })),
        },
      ]),
    );
  } catch {
    return undefined;
  }
}

/** The adapter: read the plan through the service, summarize, return. */
export async function runGetPlan(
  args: { planId: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const plan = await plansService.getPlan(args.planId, ctx);
  const placements = await resolvePlacements(args.planId, ctx);
  return toolOk(summarizePlan(plan, placements), derived(planPayload, presentMcpPlan(plan)));
}

export function registerGetPlan(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    GET_PLAN_TOOL_NAME,
    {
      title: 'Read plan proposals',
      description:
        'Read a plan WITH the proposals it bundles — what an AI planning pass actually ' +
        'proposed, not just how many items it produced. Returns the plan plus `items[]`: each ' +
        "proposal's `op` (add / modify / remove), the `proposedFields` of an `add` (title, " +
        'kind, type, priority, executor, storyPoints, estimateMinutes, description, and ' +
        "targetRepo — which repo of the project's set the item ships in), the " +
        '`patch` of a `modify`, and the `parentRef` / `blockedByRefs` that let you rebuild the ' +
        `proposed tree and its dependency edges. Reach for \`${GET_PLAN_STATUS_TOOL_NAME}\` ` +
        'instead when you only need the status of a submitted job (and whether that job died); ' +
        'reach for this one to SHOW or judge the content. A plan still generating returns the ' +
        'proposals that have arrived so far. ' +
        'IMPORTANT: these are PROPOSALS, NOT work items. Nothing here exists in the tree: ' +
        'approving the plan in Motir is the only path from a proposal to a work item, and an ' +
        "`add`'s `workItemId` stays null until then. Do not report proposed items as created. " +
        'A pure read.',
      inputSchema: getPlanInputSchema,
    },
    async (args, extra) => {
      try {
        return await runGetPlan(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
