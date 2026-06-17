import { submitJob, getJob } from '@/lib/ai/motirAiClient';
import { projectsService } from '@/lib/services/projectsService';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { withWorkspaceContext, type WorkspaceContext } from '@/lib/workspaces/context';
import type { JobView } from '@/lib/ai/errors';

// The dispatch side of the boundary (Subtask 7.1.7): motir-core SUBMITS jobs to
// motir-ai via the 7.1.5 client, and polls them. The read-back side (what
// motir-ai calls during a job) is aiBoundaryService. Today the only kind is
// `noop` (the walking skeleton); 7.2+ add chat/generation entry points here.

export const aiJobsService = {
  // Submit a `noop` job for a project (by key). Resolves + access-gates the
  // project AS the actor (projectsService.getByKey is a 404-not-403 read),
  // resolves the workspace's ORG (the billing entity the job-submit tenant
  // carries — Subtask 7.2.16), then mints the job-scoped token + submits via the
  // client. Returns the jobId.
  async submitNoopJob(projectKey: string, ctx: WorkspaceContext): Promise<{ jobId: string }> {
    const project = await projectsService.getByKey(projectKey, ctx);
    const organizationId = await resolveOrganizationId(ctx);
    const tenant = {
      organizationId,
      workspaceId: ctx.workspaceId,
      projectId: project.id,
      projectKey: project.identifier,
    };
    return submitJob('noop', tenant, {}, { userId: ctx.userId });
  },

  // Poll a job's status (status + result/error mapped to a typed error).
  async getJobStatus(jobId: string): Promise<JobView> {
    return getJob(jobId);
  },
};

// Resolve the active workspace's organization id — the billing entity the
// job-submit tenant carries (7.2.16). RLS-aware: the read runs inside
// `withWorkspaceContext` so the workspace policy admits the row under the
// non-bypass app role (the same pattern projectsService.getByKey uses).
async function resolveOrganizationId(ctx: WorkspaceContext): Promise<string> {
  return withWorkspaceContext(ctx, async (tx) => {
    const workspace = await workspaceRepository.findByIdInTx(ctx.workspaceId, tx);
    if (!workspace) throw new Error(`workspace ${ctx.workspaceId} not found`);
    return workspace.organizationId;
  });
}
