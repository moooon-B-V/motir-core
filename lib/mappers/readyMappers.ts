import type { User, WorkItem } from '@prisma/client';
import type { ReadyItemDispatchDto, ReadyItemDto } from '@/lib/dto/ready';
import { isManualReadyItem } from '@/lib/dto/ready';
import { markdownToExcerpt } from '@/lib/markdown/excerpt';

// Prisma → DTO converters for the Ready surface (Subtask 7.0.3). PURE — no DB
// calls, no I/O. The service (7.0.2) fetches the rows + resolves the status
// category + the blockers, then calls these just before returning, so no Prisma
// row shape leaks across the API boundary. Mirrors `lib/mappers/workItemMappers.ts`.

/** The assignee fields the Ready row renders. A `Pick` so callers can pass the
 *  full `User` row (or a narrowed select) without an extra projection step. */
export type ReadyAssignee = Pick<User, 'id' | 'name' | 'email' | 'image'>;

/** The resolved bits the base `ReadyItemDto` needs beyond the `WorkItem` row:
 *  the status's workflow `category` (the row's `status` is only the key) and the
 *  assignee user (or null). Supplied by the service — kept out of the row so the
 *  mapper stays a pure function of its inputs. */
export interface ReadyItemContext {
  /** The status key's category in the project workflow: `todo` | `in_progress` |
   *  `done`. (A ready item is never `done`, but the field is always carried.) */
  statusCategory: string;
  assignee: ReadyAssignee | null;
}

/** The extra resolved bits the dispatch DTO needs on top of {@link ReadyItemContext}. */
export interface ReadyDispatchContext extends ReadyItemContext {
  /** The parent item, narrowed to its identifier — or null for a top-level item. */
  parent: Pick<WorkItem, 'identifier'> | null;
  /**
   * File paths the agent should read. Passed in (not read from the row) because
   * `work_item` has NO `contextRefs` column yet — see the DTO doc + the logged
   * finding. The service supplies `[]` until that schema field lands.
   */
  contextRefs: string[];
  /**
   * The inherited session branch (Subtask 7.8.11) — the single branch this
   * item's integrated-awaiting-review deps live on, or null when it has none.
   * Resolved by the service (`getReadiness`), not read from the row (the row's
   * OWN `sessionBranch` is null for a not-yet-integrated ready item). See the
   * DTO doc.
   */
  sessionBranch: string | null;
}

function toAssigneeDto(assignee: ReadyAssignee | null): ReadyItemDto['assignee'] {
  if (!assignee) return null;
  return {
    id: assignee.id,
    // Same email-localpart fallback the workspace-member mapper uses for
    // name-less (OAuth / pre-name-collection) users.
    name: assignee.name || assignee.email.split('@')[0]!,
    avatarUrl: assignee.image,
  };
}

/**
 * The cheap card-row DTO for `GET /api/ready` / the page list. `key` is the
 * `PROD-<n>` identifier (the agent-contract naming — see the DTO doc), NOT the
 * numeric `key`. The Markdown body is reduced to a short plain-text excerpt so
 * a 50-row page never ships full descriptions.
 */
export function toReadyItemDto(row: WorkItem, ctx: ReadyItemContext): ReadyItemDto {
  return {
    id: row.id,
    key: row.identifier,
    kind: row.kind,
    title: row.title,
    priority: row.priority,
    status: { key: row.status, category: ctx.statusCategory },
    assignee: toAssigneeDto(ctx.assignee),
    descriptionExcerpt: markdownToExcerpt(row.descriptionMd),
    type: row.type,
    executor: row.executor,
    // Ship the full body ONLY for a manual row (the *Show instruction* modal's
    // source — 8.8.5/8.8.10); an agent-runnable row carries `null` so the list
    // payload stays lean (the 7.0.3 split decision). One predicate with the
    // row's render-side variant choice, via `isManualReadyItem`.
    descriptionMd: isManualReadyItem(row) ? row.descriptionMd : null,
  };
}

/**
 * The full dispatch DTO for `POST /api/ready/next`. Composes the base row DTO
 * and adds the agent payload: the full `descriptionMd`, the `contextRefs`, the
 * resolved blocker keys, the parent key, and the ready-to-paste `runCommand`.
 *
 * `blockerRows` are the work items this item WAS blocked by (all now terminal,
 * since the item is ready); narrowed to their identifier. The service resolves
 * them via the existing `workItemRepository.findByIds` and passes them here.
 */
export function toReadyItemDispatchDto(
  row: WorkItem,
  blockerRows: Pick<WorkItem, 'identifier'>[],
  ctx: ReadyDispatchContext,
): ReadyItemDispatchDto {
  return {
    ...toReadyItemDto(row, ctx),
    descriptionMd: row.descriptionMd,
    contextRefs: ctx.contextRefs,
    blockerKeys: blockerRows.map((b) => b.identifier),
    parentKey: ctx.parent?.identifier ?? null,
    runCommand: `motir run ${row.identifier}`,
    sessionBranch: ctx.sessionBranch,
  };
}
