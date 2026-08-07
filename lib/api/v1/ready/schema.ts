import { z } from 'zod/v4';
import { WorkItemKind, WorkItemPriority } from '@/generated/prisma/client';
import { InvalidRequestError } from '@/lib/api/v1/errors';
import {
  dependencyEdgesSchema,
  presentDependencyEdges,
  workItemKeySchema,
} from '@/lib/api/v1/workItems/schema';
import type { ReadyItemDto } from '@/lib/dto/ready';
import type {
  ExecutorDto,
  WorkItemDependencyEdgesDto,
  WorkItemKindDto,
  WorkItemPriorityDto,
  WorkItemTypeDto,
} from '@/lib/dto/workItems';
import type { ReadyListFilter } from '@/lib/workItems/readyFilter';

// The v1 READY-SET row (Story 11.3 · Subtask 11.3.9 — MOTIR-2066) — the shape
// an external agent loop reads to answer "what can I pick up right now, and what
// does finishing it unblock?".
//
// ── The ORDER is part of the contract ───────────────────────────────────────
// Rows arrive in the DISPATCH rank `(type asc, priority desc, key asc)` —
// leaf-most kinds first, priority breaking the type tie, `key` breaking the
// final tie — so `items[0]` is what an agent should take next. Nothing here
// re-sorts, filters or post-processes the service's result: the endpoint's whole
// value is that an agent loop and the product's own /ready page can never
// disagree about what is ready.
//
// ── What is deliberately NOT on the row ─────────────────────────────────────
//   • `descriptionMd` — populated ONLY for manual rows (the shipped 7.0.3
//     payload-size split: a 50-row page must not ship 50 Markdown bodies). A
//     field that is null for most rows for a reason no client can see is worse
//     than an absent one; `descriptionExcerpt` carries what a list needs, and a
//     client wanting the body reads the item through 11.2's detail endpoint.
//   • `id` — the internal cuid. §7; `key` is the item's public name.
//   • `assignee.avatarUrl` — an avatar URL is a web-app concern; no terminal or
//     script renders one, and neither mirror's minimal shape is needed for it.
//     A client that wants richer user data is asking for a user resource, which
//     v1 deliberately does not have.
//   • `runCommand` / `contextRefs` / `sessionBranch` / `targetRepo` — those live
//     on `ReadyItemDispatchDto`, the payload for Motir's OWN CLI dispatch path.
//     They encode assumptions about a local checkout that a third-party
//     integration does not share, and `runCommand` in particular would freeze
//     the CLI's invocation string as public API. **Reaffirmed by Amendment 10
//     Q2**: a client that needs `targetRepo` reads it from
//     `GET /api/v1/work-items/{key}/dispatch-prompt`, which 11.7 ships.
//
// ⚠️ `assignee.name` USED TO BE ON THIS LIST, and Amendment 10 Q1 removed it.
// The reason given was "a public API must not acquire a second, accidental user
// resource" — right about what it feared, wrong about what counts as one. An
// EMBEDDED, minimal, read-only actor has no endpoint, no collection, no
// expansion and cannot be queried; it is a field, not a resource. And with
// `assigneeId` alone NO client can render a work-item list showing who owns
// what, because v1 has no user endpoint to resolve an id against — which is
// every integration that draws a table, not one CLI. Both mirrors embed one
// (GitHub `assignees[].login`/`name`, GitLab `assignees[].name`/`username`).
// The rule now applies to every v1 collection row, not just this one.

/** `true` only when `Union` is fully covered by `Covered`; otherwise `never`. */
type AssertTotal<Union, Covered> = [Exclude<Union, Covered>] extends [never] ? true : never;

const READY_KINDS = [
  'epic',
  'story',
  'task',
  'subtask',
  'bug',
] as const satisfies readonly WorkItemKindDto[];
const _kindsTotal: AssertTotal<WorkItemKindDto, (typeof READY_KINDS)[number]> = true;

const READY_PRIORITIES = [
  'lowest',
  'low',
  'medium',
  'high',
  'highest',
] as const satisfies readonly WorkItemPriorityDto[];
const _prioritiesTotal: AssertTotal<WorkItemPriorityDto, (typeof READY_PRIORITIES)[number]> = true;

const READY_TYPES = [
  'code',
  'design',
  'test',
  'content',
  'research',
  'review',
  'decision',
  'deploy',
  'manual',
  'chore',
] as const satisfies readonly WorkItemTypeDto[];
const _typesTotal: AssertTotal<WorkItemTypeDto, (typeof READY_TYPES)[number]> = true;

const READY_EXECUTORS = ['coding_agent', 'human'] as const satisfies readonly ExecutorDto[];
const _executorsTotal: AssertTotal<ExecutorDto, (typeof READY_EXECUTORS)[number]> = true;

void [_kindsTotal, _prioritiesTotal, _typesTotal, _executorsTotal];

// The edge block is DECLARED ONCE, in `lib/api/v1/workItems/schema.ts`, and
// imported here (MOTIR-2236). It used to be a structurally identical private
// copy; when 11.7 put the same block on the work-item collection row and on the
// detail's children, a third copy would have been three places for one shape to
// drift — the same reasoning `workItemLinkSchema` records for `GET …/links` and
// the detail aggregate. For a ready row `blockedBy` is terminal by definition —
// that is what makes it ready — and `blocks` is the payload that matters: what
// finishing this item unblocks, i.e. why it is worth doing first.

/**
 * The MINIMAL ACTOR a v1 collection row embeds (Amendment 10 Q1).
 *
 * Two fields and no more: the id a client acts on (it is what 11.2's PATCH takes
 * back) and the name a client displays. Deliberately NOT a user resource — it
 * has no endpoint, no collection, no expansion and cannot be queried — which is
 * the distinction the pre-Amendment-8 rationale collapsed.
 *
 * Declared here because the ready row is the first collection to carry one;
 * Amendment 10 states the rule for every v1 collection row, so a second consumer
 * imports THIS rather than restating it.
 */
export const actorRefSchema = z.object({
  id: z.string(),
  name: z.string(),
});

/** The v1 ready row. */
export const readyItemSchema = z.object({
  key: workItemKeySchema,
  kind: z.enum(READY_KINDS),
  title: z.string(),
  priority: z.enum(READY_PRIORITIES),
  status: z.object({ key: z.string(), category: z.string() }),
  type: z.enum(READY_TYPES).nullable(),
  executor: z.enum(READY_EXECUTORS).nullable(),
  /**
   * The assignee's id — KEPT alongside `assignee` rather than replaced by it.
   *
   * Removing it would be a §8 violation (a field taken away), and it is the
   * cheaper read for a client that only routes on identity. `assignee.id` and
   * `assigneeId` are the same value; a test asserts they cannot diverge.
   */
  assigneeId: z.string().nullable(),
  /** Who it is assigned to, for a client that renders a name (Amendment 10 Q1). */
  assignee: actorRefSchema.nullable(),
  /** ~200 chars of the description, Markdown stripped to plain text. */
  descriptionExcerpt: z.string().nullable(),
  dependencies: dependencyEdgesSchema,
});
export type V1ReadyItem = z.infer<typeof readyItemSchema>;

/**
 * Map one ready row plus its edges to the wire — field by field, never a spread.
 *
 * `edges` comes from the page's BATCHED projection, and is defaulted here only
 * because `noUncheckedIndexedAccess` demands it: `getDependencyEdgesForItems`
 * pre-seeds every requested id, so a miss is unreachable.
 */
export function presentReadyItem(
  item: ReadyItemDto,
  edges: WorkItemDependencyEdgesDto | undefined,
): V1ReadyItem {
  return {
    key: item.key,
    kind: item.kind,
    title: item.title,
    priority: item.priority,
    status: { key: item.status.key, category: item.status.category },
    type: item.type,
    executor: item.executor,
    assigneeId: item.assignee?.id ?? null,
    // From the SAME `item.assignee` the id comes from — the service already
    // read it, so this is a mapper widening and not a second query. `avatarUrl`
    // is dropped here rather than in the service (see the header note).
    assignee: item.assignee === null ? null : { id: item.assignee.id, name: item.assignee.name },
    descriptionExcerpt: item.descriptionExcerpt,
    dependencies: presentDependencyEdges(edges),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The query filters
// ─────────────────────────────────────────────────────────────────────────────
//
// The three shipped ready facets, exposed as repeatable query parameters rather
// than a FilterAST: this is not the work-item collection, and `ReadyListFilter`
// is a fixed three-axis shape, not the registry's open field set. Bending the
// AST onto it would promise fields (`lbl`, `cmp`, `text`, dates) the ready read
// cannot narrow by.

const KIND_VALUES = new Set<string>(Object.values(WorkItemKind));
const PRIORITY_VALUES = new Set<string>(Object.values(WorkItemPriority));

/** The literal a caller sends to mean "the UNASSIGNED bucket". */
export const UNASSIGNED = 'none';

/**
 * Read `?kind=&priority=&assigneeId=` into the shipped `ReadyListFilter`.
 *
 * `assigneeId` is TRI-STATE and the wire form has to preserve all three:
 * ABSENT means any assignee, the literal `none` means the unassigned bucket, and
 * a user id means that user's items. Without the explicit literal a client could
 * not ask for unassigned work at all — an empty `?assigneeId=` is
 * indistinguishable from omitting it.
 *
 * An unknown kind or priority is a 422 rather than being silently dropped: a
 * filter that quietly matches everything is how a client ends up dispatching
 * work it meant to exclude.
 */
export function parseReadyFilters(req: Request): ReadyListFilter {
  const params = new URL(req.url).searchParams;

  const kinds = params.getAll('kind');
  for (const kind of kinds) {
    if (!KIND_VALUES.has(kind)) {
      throw new InvalidRequestError('INVALID_READY_FILTER', `Unknown \`kind\`: ${kind}.`);
    }
  }

  const priorities = params.getAll('priority');
  for (const priority of priorities) {
    if (!PRIORITY_VALUES.has(priority)) {
      throw new InvalidRequestError('INVALID_READY_FILTER', `Unknown \`priority\`: ${priority}.`);
    }
  }

  const rawAssignee = params.get('assigneeId');

  return {
    ...(kinds.length > 0 ? { kinds: kinds as WorkItemKind[] } : {}),
    ...(priorities.length > 0 ? { priority: priorities as WorkItemPriority[] } : {}),
    ...(rawAssignee !== null && rawAssignee !== ''
      ? { assigneeId: rawAssignee === UNASSIGNED ? null : rawAssignee }
      : {}),
  };
}
