import { resolveServiceProjectByKey } from '@/lib/ai/serviceAuth';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  isPlannerBugHomeMarker,
  PLANNER_BUG_HOME_MARKER,
  PLANNER_BUG_HOME_EPIC_TITLE,
  PlannerBugHomeNotProvisionedError,
} from '@/lib/ai/plannerBugHome';
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
   *  resolves to the planner-bug home EPIC by TITLE — the reseed-durable handle
   *  the self-learning loop targets instead of a volatile numeric key
   *  (MOTIR-1466; MOTIR-2201). When omitted, the bug is filed at project-root (a
   *  top-level `bug` is matrix-legal). */
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
        // numeric key, so it never dangles across deploys. MOTIR-2201 — ONE hop:
        // the home EPIC, found by its stable title, IS the bug parent (`epic →
        // bug` is matrix-legal, and it is where the live tenant's auto-filed bugs
        // already sit). It used to take a second hop to the epic's first `story`
        // CHILD; that read of mutable structure broke the moment the live story
        // was re-parented, and an epic — root-only in the kind-parent matrix —
        // cannot be moved out from under the marker the same way. Browse-gated
        // here. A missing home is a server invariant breach, not a caller error:
        // logged + 500 (see below), never a quiet 404 the filing path swallows.
        const home = await workItemsService.getWorkItemByProjectKindAndTitle(
          project.id,
          'epic',
          PLANNER_BUG_HOME_EPIC_TITLE,
          ctx,
        );
        if (!home) {
          console.error('[aiWorkItemsService] the planner-bug home epic is missing', {
            projectKey: input.projectKey,
            projectId: project.id,
            marker: PLANNER_BUG_HOME_MARKER,
            expectedEpicTitle: PLANNER_BUG_HOME_EPIC_TITLE,
          });
          throw new PlannerBugHomeNotProvisionedError(input.projectKey);
        }
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
