import type { WorkItem } from '@/generated/prisma/client';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workflowsService } from '@/lib/services/workflowsService';
import { toWorkItemRefSummaryDto } from '@/lib/mappers/workItemMappers';
import type { WorkItemRefs } from '@/lib/mentions/workItemRefs';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import type { VisitorReadContext } from '@/lib/visitor/context';
import { isVisitorContext } from '@/lib/visitor/readScope';

// Read-side resolution for work-item references (Story 5.8 · Subtask 5.8.6) —
// the parallel of the write-side `autoRelateWorkItemMentions` (5.8.3). Given the
// references parsed out of a body / title (token ids ∪ bare project keys), it
// resolves each to the LIVE summary the internal-link chip / title-linkify
// renders: current key · title · status · archived / accessible state. It
// REUSES the exact `projectAccessService.filterBrowsable` view gate `quickSearch`
// and auto-relate ride — NOT a new permission check:
//
//  - a token id that resolves to nothing (deleted / cross-workspace) is simply
//    ABSENT from the map → the chip degrades to a struck-through bare key;
//  - a target in a project the caller can't browse is marked
//    `{ accessible: false }` → the chip shows only the bare key (no title/status
//    leak), matching the picker's permission scope;
//  - an accessible target carries its current identifier · title · kind ·
//    archived flag + resolved status meta (label + category for the dot).
//
// Pure read (no `tx`): a read-only service path, so the repo reads use the `db`
// singleton. Keyed by BOTH the work-item id (the `motir:<id>` token the render
// layer looks up) and, for accessible targets, the current identifier (the bare
// `KEY-N` title path).
export async function resolveWorkItemRefSummaries(
  refs: WorkItemRefs,
  activeProjectId: string,
  ctx: ServiceContext | VisitorReadContext,
): Promise<WorkItemRefMap> {
  if (refs.ids.length === 0 && refs.keys.length === 0) return {};
  if (isVisitorContext(ctx)) return resolveVisitorRefSummaries(refs, ctx);

  // Same-project bare keys → rows (the key parser only matches the active
  // project's prefix, so resolution is project-scoped — like auto-relate); token
  // ids → rows within the workspace (includes archived; a cross-workspace /
  // deleted id simply doesn't come back).
  const [keyRows, idRows] = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    Promise.all([
      refs.keys.length
        ? workItemRepository.findByIdentifiers(activeProjectId, refs.keys, tx)
        : Promise.resolve<WorkItem[]>([]),
      refs.ids.length
        ? workItemRepository.findByIdsInWorkspace(refs.ids, ctx.workspaceId, tx)
        : Promise.resolve<WorkItem[]>([]),
    ]),
  );

  // Dedupe by id — a token id and a bare key can name the same item.
  const rowById = new Map<string, WorkItem>();
  for (const r of [...idRows, ...keyRows]) rowById.set(r.id, r);
  if (rowById.size === 0) return {};

  // View scope: the exact `filterBrowsable` gate `quickSearch` / auto-relate
  // ride (reused, not reinvented) — title/status only leak for browsable targets.
  const projects = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    projectRepository.findByWorkspace(ctx.workspaceId, tx),
  );
  const browsable = await projectAccessService.filterBrowsable(projects, ctx);
  const browsableProjectIds = new Set(browsable.map((p) => p.id));

  // Resolve the status meta (label + category for the dot) of the accessible
  // targets, batched across their projects (each project owns its workflow).
  const accessibleRows = [...rowById.values()].filter((r) => browsableProjectIds.has(r.projectId));
  const statusMeta = await workflowsService.getStatusMetaByProjects(
    accessibleRows.map((r) => r.projectId),
    ctx.workspaceId,
  );

  const map: WorkItemRefMap = {};
  for (const row of rowById.values()) {
    if (!browsableProjectIds.has(row.projectId)) {
      // In-workspace but not viewable → bare key only (no title/status leak).
      map[row.id] = { accessible: false, id: row.id };
      continue;
    }
    const status = statusMeta.get(row.projectId)?.get(row.status) ?? null;
    const summary = toWorkItemRefSummaryDto(row, status);
    // Keyed by id (token href) AND current identifier (bare-key / title path).
    map[row.id] = summary;
    map[row.identifier] = summary;
  }
  return map;
}

/**
 * A VISITOR's chip resolution (MOTIR-6652, `epic-privacy.md` §3). The only
 * project a Visitor can read is `ctx.project`, so a target anywhere else — or in
 * the private-epic hidden set — resolves to NOTHING: it is left out of the map
 * altogether, id and key alike, so the chip names neither. (The Visitor's
 * Markdown bodies have their withheld tokens redacted before they are sent;
 * this keeps a bare key typed in prose from resolving to a title.)
 */
async function resolveVisitorRefSummaries(
  refs: WorkItemRefs,
  ctx: VisitorReadContext,
): Promise<WorkItemRefMap> {
  const { id: projectId, workspaceId } = ctx.project;
  const [keyRows, idRows] = await withWorkspaceServiceContext(workspaceId, (tx) =>
    Promise.all([
      refs.keys.length
        ? workItemRepository.findByIdentifiers(projectId, refs.keys, tx)
        : Promise.resolve<WorkItem[]>([]),
      refs.ids.length
        ? workItemRepository.findByIdsInWorkspace(refs.ids, workspaceId, tx)
        : Promise.resolve<WorkItem[]>([]),
    ]),
  );
  const visible = [...idRows, ...keyRows].filter(
    (r) => r.projectId === projectId && !ctx.hiddenIds.has(r.id),
  );
  if (visible.length === 0) return {};
  const statusMeta = await workflowsService.getStatusMetaByProjects([projectId], workspaceId);
  const map: WorkItemRefMap = {};
  for (const row of visible) {
    const summary = toWorkItemRefSummaryDto(
      row,
      statusMeta.get(row.projectId)?.get(row.status) ?? null,
    );
    map[row.id] = summary;
    map[row.identifier] = summary;
  }
  return map;
}
