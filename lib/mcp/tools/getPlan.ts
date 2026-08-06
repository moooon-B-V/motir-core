import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { plansService } from '@/lib/services/plansService';
import type { PlanItemDto, PlanItemOpDto, PlanWithItemsDto } from '@/lib/dto/plans';
import { isTempRef, tempRefId } from '@/lib/plans/refs';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { unmigrated } from '../payloads/define';
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
// items. They are not. `plansService.approvePlan` — a human decision made in
// Motir — is the only path from a proposal to a `work_item` row, and an `add`'s
// `workItemId` stays `null` until then.

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

/** One proposal as a single line — the op, what it targets, and its sizing. */
function describeItem(item: PlanItemDto): string {
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
  const target = item.workItemId ?? '(no target)';
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

/**
 * The proposals as an indented tree, so a terminal client that ignores
 * `structuredContent` can still SEE the shape that was proposed.
 *
 * Nesting follows `parentRef`, but ONLY the intra-plan temp-ref form
 * (`planItem:<id>`): a `parentRef` naming a REAL work item places the proposal
 * under something that already exists — outside this plan — so it renders at the
 * top level, where the reader's eye expects a new branch hanging off the live
 * tree. `modify` / `remove` carry no `parentRef` at all and sit at the top level
 * for the same reason.
 */
function renderProposals(items: PlanItemDto[]): string[] {
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
    lines.push(`${'  '.repeat(depth + 1)}${describeItem(item)}`);
    for (const child of childrenOf.get(item.id) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  // Anything a cycle kept out of the root set is still the caller's data — print
  // it rather than silently dropping proposals from a list the client trusts.
  for (const item of items) walk(item, 0);
  return lines;
}

/** The human-readable block: the plan's own line, then its proposal tree. */
export function summarizePlan(plan: PlanWithItemsDto): string {
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
    lines.push('Proposals (indented under their proposed parent):', ...renderProposals(plan.items));
  }

  lines.push(
    '',
    plan.status === 'approved'
      ? 'This plan was approved — its proposals were materialized into work items.'
      : 'These are PROPOSALS, not work items. Approving the plan in Motir is the only thing ' +
          "that creates one, and an `add`'s workItemId stays null until then.",
  );
  return lines.join('\n');
}

/** The adapter: read the plan through the service, summarize, return. */
export async function runGetPlan(
  args: { planId: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const plan = await plansService.getPlan(args.planId, ctx);
  return toolOk(
    summarizePlan(plan),
    unmigrated('get_plan', plan as unknown as Record<string, unknown>),
  );
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
