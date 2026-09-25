import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { APPROVED_SHAPE_VERDICT_MAX_IDS, plansService } from '@/lib/services/plansService';
import { ApprovedShapeChildKeyNotAChildError } from '@/lib/plans/errors';
import type { WorkItemApprovedShapeVerdictDto, WorkItemPlanHistoryPageDto } from '@/lib/dto/plans';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { GET_PLAN_TOOL_NAME } from './getPlan';
import { resolveWorkItemByKey, workItemKeyField } from './workItemRef';

// `get_approved_shape_verdict` (Story MOTIR-5544 · Subtask MOTIR-6227) — the
// RUNBOOK's door onto the approved-shape verdict: before a person-driven
// `motir run` files a planning bug about a card it cannot build, it asks whether
// that card is still what the last approved plan approved.
//
// This is a TRANSPORT, not a second read path — the posture `get_plan` states
// for itself. The keys are resolved through the same services every key-
// addressed tool uses (so the 404-not-403 contract carries unchanged), and then
// exactly two service calls answer: `plansService.listPlanHistoryForWorkItem`
// for the card's plan history, and `plansService.resolveApprovedShapeVerdict`
// for the verdicts. The CHANGE PREDICATE lives in
// `lib/plans/approvedShapeChange.ts` and the verdict in the service; nothing
// here re-decides either. The history page is the service's own, cursor and
// all — no pagination invented at this layer.
//
// ⚠️ `ai:view_plan`, NOT `project:browse`, and therefore UNREACHABLE from
// `CLI_TOKEN_GRANT` on purpose. Both services assert that key themselves; the
// map entry states the same gate. A dispatched agent is not this tool's caller
// (`docs/decisions/run-findings-protocol.md` Q3): on the dispatched path the
// SERVER reads the verdict itself when the runner reports an unbuildable target,
// and never hands it back (`docs/decisions/run-found-trigger-dispatched-path.md`).
//
// ORDER OF THE REFUSALS, and why. The card key is resolved first (not-found,
// no existence leak); the history read then asserts `ai:view_plan` — so a
// caller without the key is refused on the PERMISSION before any `childKeys`
// entry is looked at, and can learn nothing about the container's children from
// the order its errors arrive in. Only then are the child keys resolved and
// checked, each refused BY NAME when it is not a child of `key`.

export const GET_APPROVED_SHAPE_VERDICT_TOOL_NAME = 'get_approved_shape_verdict';

/** One read answers the container plus this many children. */
const CHILD_KEYS_MAX = APPROVED_SHAPE_VERDICT_MAX_IDS - 1;

const inputSchema = {
  key: workItemKeyField,
  childKeys: z
    .array(z.string().trim().min(1))
    .max(CHILD_KEYS_MAX)
    .optional()
    .describe(
      `OPTIONAL — the keys of \`key\`'s CHILDREN you want a verdict on too (at most ` +
        `${CHILD_KEYS_MAX}), typically the ones a parent-run found wrong. Each must be a direct ` +
        'child of `key`: one that is not is REFUSED with `APPROVED_SHAPE_NOT_A_CHILD` naming ' +
        'it, never silently dropped or answered.',
    ),
  historyCursor: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'OPTIONAL — the `planHistory.nextCursor` a previous call returned, for the next page of ' +
        "the card's plan history. The verdict does not depend on it: it is always computed over " +
        'the WHOLE history.',
    ),
};

interface GetApprovedShapeVerdictArgs {
  key: string;
  childKeys?: string[];
  historyCursor?: string;
}

/** A verdict as the door returns it: the service's DTO, addressed by KEY too. */
type KeyedVerdict = WorkItemApprovedShapeVerdictDto & { key: string };

/** The one-line reading of a verdict, for the text block. */
function describeVerdict(v: KeyedVerdict): string {
  if (v.verdict === 'no_plan') {
    return `${v.key}: no_plan — no approved plan ever shaped this card.`;
  }
  const plan = `plan ${v.planId}${v.planTitle ? ` ("${v.planTitle}")` : ''}, approved ${v.decidedAt}`;
  if (v.verdict === 'unchanged') {
    return `${v.key}: unchanged since ${plan}.`;
  }
  const why: string[] = [];
  if (v.divergingRevision) {
    why.push(
      `revision ${v.divergingRevision.id} at ${v.divergingRevision.changedAt} ` +
        `(${v.divergingRevision.changeKind}: ${v.divergingRevision.changedKeys.join(', ')})`,
    );
  }
  if (v.childSet?.verdict === 'changed') {
    why.push(
      `child set — ${v.childSet.added.length} added, ${v.childSet.removed.length} removed ` +
        'since approval',
    );
  }
  return `${v.key}: changed since ${plan} — ${why.join('; ')}.`;
}

/**
 * The adapter: resolve the keys, read the history and the verdicts through the
 * service, return both. It computes nothing of its own.
 */
export async function runGetApprovedShapeVerdict(
  args: GetApprovedShapeVerdictArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const item = await resolveWorkItemByKey(args.key, ctx);

  // Asserts `ai:view_plan` — BEFORE any child key is resolved (see the header).
  const planHistory: WorkItemPlanHistoryPageDto = await plansService.listPlanHistoryForWorkItem(
    item.projectId,
    item.id,
    { cursor: args.historyCursor ?? null },
    ctx,
  );

  const children: { key: string; id: string }[] = [];
  const seen = new Set<string>();
  for (const raw of args.childKeys ?? []) {
    const child = await resolveWorkItemByKey(raw, ctx);
    if (child.parentId !== item.id) {
      throw new ApprovedShapeChildKeyNotAChildError(child.identifier, item.identifier);
    }
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    children.push({ key: child.identifier, id: child.id });
  }

  const page = await plansService.resolveApprovedShapeVerdict(
    item.projectId,
    [item.id, ...children.map((c) => c.id)],
    ctx,
  );
  const [own, ...childVerdicts] = page.items;
  const self: KeyedVerdict = { key: item.identifier, ...own! };
  const keyedChildren: KeyedVerdict[] = childVerdicts.map((v, i) => ({
    key: children[i]!.key,
    ...v,
  }));

  const lines = [
    describeVerdict(self),
    ...keyedChildren.map((v) => `  ${describeVerdict(v)}`),
    '',
    `Plan history: ${planHistory.items.length} plan(s) on this page` +
      (planHistory.nextCursor ? ' — more on the next page (pass `historyCursor`).' : '.'),
    ...planHistory.items.map(
      (e) =>
        `  ${e.planId} — ${e.planStatus}` +
        (e.planTitle ? ` · "${e.planTitle}"` : '') +
        (e.relation.op ? ` · ${e.relation.op}` : '') +
        (e.relation.childCount > 0 ? ` · ${e.relation.childCount} child add(s)` : ''),
    ),
    '',
    'A pure read: nothing was filed, transitioned or created. What to do with the verdict is ' +
      `yours; read the approving plan's proposals with \`${GET_PLAN_TOOL_NAME}\`.`,
  ];

  return toolOk(
    lines.join('\n'),
    exempt(GET_APPROVED_SHAPE_VERDICT_TOOL_NAME, {
      ...self,
      planHistory,
      children: keyedChildren,
    }),
  );
}

export function registerGetApprovedShapeVerdict(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    GET_APPROVED_SHAPE_VERDICT_TOOL_NAME,
    {
      title: 'Is this card still what its plan approved?',
      description:
        'Ask whether a work item is STILL WHAT THE LAST APPROVED PLAN APPROVED — the question to ' +
        'answer BEFORE blaming the planner for a card you cannot build. Returns the card’s PLAN ' +
        'HISTORY (every plan that created, changed, archived or added children under it, oldest ' +
        'first), the LAST `approved` plan that shaped it (`planId`, `planTitle`, `decidedAt`), ' +
        'and a server-computed `verdict`: `unchanged` (nothing that plan approved has moved ' +
        'since), `changed` (it has — `divergingRevision` names the FIRST edit after approval ' +
        'that departed from it, and for a container `childSet` lists children `added` / ' +
        '`removed` since; a container can be changed by its child set alone, with ' +
        '`divergingRevision` null), or `no_plan` (no approved plan ever shaped it; `planId` is ' +
        'null). `no_plan` IS AN ANSWER, not an error. WHAT COUNTS AS A CHANGE: an edit to the ' +
        'title, description, explanation, kind, type, executor, story points, estimate, ' +
        'difficulty, priority or target repository; a move to another parent or folder; a ' +
        'blocked-by edge added or removed; an archive (an unarchive, when the plan removed the ' +
        'card); and, for a container, a child added or removed. WHAT DOES NOT: status ' +
        'transitions, sprint and rank moves, assignee, reporter, due date, labels, components, ' +
        'to-dos, attachments, comments, custom fields and relates-to links. Pass `childKeys` to ' +
        'get one verdict per child as well as the ' +
        "container's own; a key that is not a child of `key` is REFUSED by name " +
        '(`APPROVED_SHAPE_NOT_A_CHILD`). An unknown or other-workspace key is the same ' +
        'not-found either way. Requires `ai:view_plan`. A PURE READ, safe to repeat: it files ' +
        'nothing, transitions nothing and creates nothing — what to do with the verdict is yours.',
      inputSchema,
    },
    async (args, extra) => {
      try {
        return await runGetApprovedShapeVerdict(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
