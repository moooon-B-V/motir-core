import { jobEventRepository } from '@/lib/repositories/jobEventRepository';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { monitorConnectionRepository } from '@/lib/repositories/monitorConnectionRepository';
import { monitorIssueRepository } from '@/lib/repositories/monitorIssueRepository';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// The monitor SYNC PROBE (Story MOTIR-4931 · Subtask MOTIR-5709) — the reads and
// the one write the acceptance walk's `_test` doors make, and nothing else calls.
//
// ⚠️ WHY IT EXISTS. The resolve-back is a JOB, so it runs in the lane's WORKER —
// a third process whose fake provider the spec cannot reach. So the browser walk
// cannot count provider calls; it asserts what the job LEAVES BEHIND (the link's
// resolve state) and it waits on the job's own run reaching a terminal state
// rather than on a sleep. Counting calls and driving the failure mechanism are
// the vitest gate's (MOTIR-5708).
//
// Every method is scoped to the caller's WORKSPACE: the doors run on the dev/CI
// superuser connection, where RLS is inert, so the tenancy check is here.

export interface MonitorLinkResolveState {
  externalIssueId: string;
  resolveState: string | null;
  resolvedByMotirAt: string | null;
  resolveError: string | null;
}

export type MonitorResolveRunState = 'none' | 'pending' | 'running' | 'terminal';

export const monitorSyncProbeService = {
  /** Every link on one bug and what the resolve-back recorded on it. */
  async resolveStatesFor(
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<MonitorLinkResolveState[]> {
    const links = await withWorkspaceContext(ctx, (tx) =>
      monitorIssueRepository.listByWorkItem(workItemId, tx),
    );
    return links
      .filter((link) => link.workspaceId === ctx.workspaceId)
      .map((link) => ({
        externalIssueId: link.externalIssueId,
        resolveState: link.resolveState,
        resolvedByMotirAt: link.resolvedByMotirAt?.toISOString() ?? null,
        resolveError: link.resolveError,
      }));
  },

  /**
   * Where the `monitor-issue-resolve` run for the NEWEST transition of one work
   * item into `toStatusKey` stands — the authoritative signal "nothing was
   * resolved" waits on, so an absence cannot pass because the job has not run
   * yet. `none` = no such transition event, or no run enqueued for it.
   */
  async resolveRunFor(
    workItemId: string,
    toStatusKey: string,
    ctx: ServiceContext,
  ): Promise<MonitorResolveRunState> {
    return withWorkspaceContext(ctx, async (tx) => {
      const event = await jobEventRepository.findLatestTransitioned(workItemId, toStatusKey, tx);
      if (!event || event.workspaceId !== ctx.workspaceId) return 'none';
      const run = await jobQueueRepository.findForEventAndJob(
        event.id,
        'monitor-issue-resolve',
        tx,
      );
      if (!run) return 'none';
      if (run.state === 'pending' || run.state === 'running') return run.state;
      return 'terminal';
    });
  },

  /** Seed a connection's last sync failure through the store's own write, so the
   *  walk can SHOW the failure line; producing one is the vitest gate's. */
  async seedSyncFailure(
    connectionId: string,
    input: { reason: string; workItemIdentifier: string | null },
    ctx: ServiceContext,
  ): Promise<boolean> {
    return withWorkspaceContext(ctx, async (tx) => {
      const connection = await monitorConnectionRepository.findById(connectionId, tx);
      if (!connection || connection.workspaceId !== ctx.workspaceId) return false;
      await monitorConnectionRepository.recordSyncFailure(
        connectionId,
        { ...input, at: new Date() },
        tx,
      );
      return true;
    });
  },
};
