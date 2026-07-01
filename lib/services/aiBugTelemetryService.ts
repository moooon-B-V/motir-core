import 'server-only';

import { submitJob } from '@/lib/ai/motirAiClient';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import { workItemsService } from '@/lib/services/workItemsService';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type { BugAnalysisContext, BugAnalysisPlanNode } from '@/lib/ai/types';

// The OUTWARD self-improving loop's INPUT arm (Story 7.6 · MOTIR-1481) — the
// DISPATCH side of the boundary for user-bug telemetry. The `work-item/created`
// Inngest trigger (lib/jobs/definitions/outwardBugTelemetry.ts) hands every
// created item here; this service decides whether it's an outward-analysis
// candidate and, if so, ASSEMBLES the bug + its plan-tree neighborhood and
// dispatches exactly ONE `analyze_bug` job to motir-ai — which owns classify →
// file → capture (MOTIR-967). This card is DISPATCH-ONLY: it performs no
// classification or filing.
//
// Reads run AS the item's creator (the event's `actorId`) over their own access
// — the per-tenant read posture (Story 7.1 / 6.4). Only the abstracted signal
// ever crosses tenants (enforced in motir-ai); the read-back token `submitJob`
// mints is scoped to this same identity.

// The Motir META project key. A bug filed HERE is owned by the INWARD loop
// (MOTIR-965) — the outward analyzer never files a self-referential meta-bug —
// so it is skipped. Mirrors motir-ai's `MOTIR_META_PROJECT_KEY` (same default),
// so both sides of the boundary agree on the skip (motir-ai backstops it).
const META_PROJECT_KEY = process.env['MOTIR_META_PROJECT_KEY'] ?? 'MOTIR';

/** The event fields the trigger forwards (a `work-item/created` payload). */
export interface OutwardBugAnalysisTrigger {
  workspaceId: string;
  projectId: string;
  workItemId: string;
  /** The actor who created the item — reads + the read-back run AS them. */
  actorId: string;
}

export interface OutwardBugAnalysisOutcome {
  dispatched: boolean;
  jobId?: string;
  /** Why nothing was dispatched — surfaced on the job-run ledger + asserted in tests. */
  reason?: 'not-a-bug' | 'meta-project' | 'ai-not-configured';
}

/** Whether the closed motir-ai backend is wired for this deployment. A
 *  self-hosted open-core motir-core with no AI backend must NOT hard-fail (and
 *  dead-letter) on every user bug — the outward loop is a cloud/meta capability.
 *  A CONFIGURED-but-unreachable motir-ai is different: that throws on dispatch
 *  and the idempotent Inngest retry absorbs it. */
function motirAiConfigured(): boolean {
  return Boolean(process.env['MOTIR_AI_URL'] && process.env['MOTIR_AI_SERVICE_TOKEN']);
}

const IMPLICATED_KINDS = new Set(['subtask', 'task']);

export const aiBugTelemetryService = {
  /**
   * Decide whether a freshly-created work item is an outward-analysis candidate
   * and, if so, dispatch the `analyze_bug` job. Idempotent-safe: it reads +
   * submits, never mutates the originating item, so a retry re-dispatches at
   * most one job (Inngest dedups on the event). Throws only on a genuine
   * transport / infra failure (so the trigger's retry budget absorbs it); every
   * "not a candidate" outcome is a value, not an error.
   */
  async dispatchOutwardAnalysis(
    trigger: OutwardBugAnalysisTrigger,
  ): Promise<OutwardBugAnalysisOutcome> {
    if (!motirAiConfigured()) return { dispatched: false, reason: 'ai-not-configured' };

    const ctx: ServiceContext = { userId: trigger.actorId, workspaceId: trigger.workspaceId };

    // The `work-item/created` payload omits `kind` (WorkItemCreatedData), so load
    // the item to resolve it. A NotFound here means the item was archived/deleted
    // (or the actor lost access) between the create-commit and this async read —
    // nothing to analyze.
    let bug: WorkItemDto;
    try {
      bug = await workItemsService.getWorkItem(trigger.workItemId, ctx);
    } catch (err) {
      if (err instanceof WorkItemNotFoundError) return { dispatched: false, reason: 'not-a-bug' };
      throw err;
    }

    if (bug.kind !== 'bug') return { dispatched: false, reason: 'not-a-bug' };

    // The bug's project key gates the meta-project skip AND rides the tenant.
    const project = await projectRepository.findById(trigger.projectId);
    const projectKey = project?.identifier;
    if (!projectKey) return { dispatched: false, reason: 'not-a-bug' };
    if (projectKey === META_PROJECT_KEY) return { dispatched: false, reason: 'meta-project' };

    // Assemble the analysis context INLINE (motir-ai does not re-read the bug).
    const planNeighborhood = await this.assembleNeighborhood(bug, ctx);
    const bugAnalysis: BugAnalysisContext = {
      bugKey: bug.identifier,
      bug: {
        title: bug.title,
        descriptionMd: bug.descriptionMd ?? '',
        // Comments cannot pre-exist a create; carried for contract parity.
        comments: [],
      },
      planNeighborhood,
      // A user-filed bug carries no dispatch/PR signal and no known planning
      // phase — those describe Motir's OWN dispatched work, which is skipped above.
      dispatch: null,
      implicatedPlanningPhase: null,
    };

    const { organizationId, isMeta } = await resolveTenantOrg({
      userId: trigger.actorId,
      workspaceId: trigger.workspaceId,
    });
    const tenant = {
      organizationId,
      isMeta,
      workspaceId: trigger.workspaceId,
      projectId: bug.projectId,
      projectKey,
    };

    const { jobId } = await submitJob(
      'analyze_bug',
      tenant,
      { bugAnalysis },
      { userId: trigger.actorId },
    );
    return { dispatched: true, jobId };
  },

  /**
   * Best-effort plan-tree neighborhood around the bug: the parent chain (owning
   * story → owning epic) plus any outgoing links (implicated subtasks / siblings —
   * e.g. the `relates_to` edges MCP body-autolink writes at create). A node the
   * actor can't reach is simply omitted (the neighborhood is OPTIONAL context;
   * motir-ai drops malformed nodes too), so context assembly never blocks the
   * primary dispatch.
   */
  async assembleNeighborhood(
    bug: WorkItemDto,
    ctx: ServiceContext,
  ): Promise<BugAnalysisPlanNode[]> {
    const nodes: BugAnalysisPlanNode[] = [];
    const seen = new Set<string>([bug.id]);

    // Walk the parent chain: parent = owning story, grandparent = owning epic
    // (roles derived from kind, so a non-standard hierarchy degrades to sibling).
    let parentId = bug.parentId;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const node = await this.loadNode(parentId, ctx, (item) =>
        item.kind === 'epic' ? 'owning_epic' : item.kind === 'story' ? 'owning_story' : 'sibling',
      );
      if (!node.item) break;
      nodes.push(node.node);
      parentId = node.item.parentId;
    }

    // Outgoing links → implicated subtasks (or siblings). Read the raw edges;
    // resolve each target through the same browse-gated read.
    const links = await workItemLinkRepository.findByFromItem(bug.id);
    for (const link of links) {
      if (seen.has(link.toId)) continue;
      seen.add(link.toId);
      const node = await this.loadNode(link.toId, ctx, (item) =>
        IMPLICATED_KINDS.has(item.kind) ? 'implicated_subtask' : 'sibling',
      );
      if (node.item) nodes.push(node.node);
    }

    return nodes;
  },

  /** Load one neighborhood node, tagging its role; returns `{ item: null }` when
   *  it's absent / unreachable so the caller can skip it. */
  async loadNode(
    id: string,
    ctx: ServiceContext,
    role: (item: WorkItemDto) => BugAnalysisPlanNode['role'],
  ): Promise<{ item: WorkItemDto | null; node: BugAnalysisPlanNode }> {
    const empty = { key: '', kind: '', title: '', role: 'sibling' as const };
    try {
      const item = await workItemsService.getWorkItem(id, ctx);
      return {
        item,
        node: {
          key: item.identifier,
          kind: item.kind,
          title: item.title,
          role: role(item),
          type: item.type ?? null,
          status: item.status ?? null,
          descriptionMd: item.descriptionMd ?? null,
        },
      };
    } catch {
      // Missing / cross-tenant / un-browsable — omit it from the optional context.
      return { item: null, node: empty };
    }
  },
};
