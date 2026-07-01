import { resolveServiceProjectByKey } from '@/lib/ai/serviceAuth';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  isPlannerBugHomeMarker,
  PLANNER_BUG_HOME_MARKER,
  PLANNER_BUG_HOME_STORY_TITLE,
} from '@/lib/ai/plannerBugHome';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemDto } from '@/lib/dto/workItems';

// The AI bug-filing write path (MOTIR-1450) — the ONE service method the
// internal `POST /api/internal/ai/work-items` route calls. The AI self-learning
// loop (965 inward / 967 outward, via the 1438 `log_planning_bug` engine tool)
// files a `kind: bug` into a NAMED project as the Motir SYSTEM principal.
//
// Thin by design: it RESOLVES the project + optional parent KEYS to ids and
// delegates to `workItemsService.createWorkItem`, so every guard — the
// kind-parent matrix, the 6.4 project-edit gate, the 404-not-403 tenant gate,
// the key allocation, the initial-status seed — runs in the create service
// UNCHANGED (no bypassed validation). This is the immediate-create analogue of
// the MCP `create_work_item` tool, but driven by the service-bearer principal
// (MOTIR-1451's `resolveServiceProjectByKey` + `ServiceContext`) rather than a
// cookie session or a PAT.

export interface FileServiceBugInput {
  /** The `PROD`-style key of the TARGET project (resolved within the system
   *  principal's workspace — 404-not-403 if it isn't there). */
  projectKey: string;
  title: string;
  descriptionMd?: string | null;
  /** Optional parent work-item key (e.g. `MOTIR-819`) in the SAME project, OR the
   *  drift-proof `PLANNER_BUG_HOME_MARKER` sentinel (`@planner-bug-home`), which
   *  resolves to the seeded planner-bug home story by TITLE — the reseed-durable
   *  handle the self-learning loop targets instead of a volatile numeric key
   *  (MOTIR-1466). When omitted, the bug is filed at project-root (a top-level
   *  `bug` is matrix-legal). */
  parentKey?: string | null;
}

export const aiWorkItemsService = {
  async fileBug(input: FileServiceBugInput, ctx: ServiceContext): Promise<WorkItemDto> {
    const project = await resolveServiceProjectByKey(input.projectKey, ctx);

    let parentId: string | null = null;
    const rawParentKey = input.parentKey?.trim() ?? '';
    if (rawParentKey !== '') {
      if (isPlannerBugHomeMarker(rawParentKey)) {
        // MOTIR-1466 — the DRIFT-PROOF path: the config carries the marker, not a
        // numeric key, so it survives reseeds. Resolve it to the seeded home story
        // by its stable TITLE (the marker resolver, browse-gated). A missing home
        // (seed never ran / fresh env before its first reseed) is a 404 — same
        // shape the route already maps for an unknown parentKey.
        const home = await workItemsService.getWorkItemByProjectKindAndTitle(
          project.id,
          'story',
          PLANNER_BUG_HOME_STORY_TITLE,
          ctx,
        );
        if (!home) throw new WorkItemNotFoundError(PLANNER_BUG_HOME_MARKER);
        parentId = home.id;
      } else {
        // A literal `MOTIR-<n>` identifier. The parent must live in the SAME
        // project. `getWorkItemByIdentifier` applies the tenant gate + browse check
        // and throws `WorkItemNotFoundError` (no existence leak) for an unknown /
        // cross-tenant key; the create service re-checks same-project + kind-legality.
        const parent = await workItemsService.getWorkItemByIdentifier(
          project.id,
          rawParentKey.toUpperCase(),
          ctx,
        );
        parentId = parent.id;
      }
    }

    return workItemsService.createWorkItem(
      {
        projectId: project.id,
        kind: 'bug',
        title: input.title,
        parentId,
        descriptionMd: input.descriptionMd ?? null,
      },
      ctx,
    );
  },
};
