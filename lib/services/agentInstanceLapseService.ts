import type { AgentInstance } from '@/generated/prisma/client';
import { isUnlimitedAgentOrg } from '@/lib/agentInstances/config';
import { deletionDateFor } from '@/lib/agentInstances/planLapse';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { withOrgServiceWriteContext } from '@/lib/organizations/context';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { formatDate } from '@/lib/utils/datetime';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// WHEN AN ORGANISATION'S AI PLAN LAPSES, ITS AGENTS ARE DELETED AFTER 30 DAYS'
// NOTICE (Story MOTIR-6914 · MOTIR-6921; `docs/decisions/agent-instance-storage.md`
// §4 and §5).
//
// ── THE SIGNAL ──────────────────────────────────────────────────────────────
// motir-core learns of a plan change only by push: motir-ai's Stripe webhook calls
// `POST /api/internal/billing/ai-included-seat`, and the included seat is ON exactly
// while the org holds a paid AI plan. `billingPropagationService.setAiIncludedSeat`
// calls {@link agentInstanceLapseService.recordLapse} when the push turns it off and
// {@link agentInstanceLapseService.clearLapse} when it turns it on.
//
// ── THE SCHEDULE ────────────────────────────────────────────────────────────
// The org records `aiPlanLapsedAt` once (a repeated push keeps the FIRST day), and
// every live instance gets `scheduledDeletionAt` = the start of that UTC day + 30
// days. Motir's own organisations (`isMeta` / `internalBilling`) are never
// scheduled: a seat-off push for one records nothing (§5).
//
// ── COMMIT, THEN EFFECT (`docs/jobs.md`) ────────────────────────────────────
// The schedule commits first; the emails are enqueued after. A failed email never
// leaves a deletion unscheduled — and it is not lost either: a notice is recorded
// per instance (`deletionNoticedAt`) only AFTER its email is enqueued, and the agent
// sweep sends every notice still owed ({@link sendPendingNotices}). Each email
// carries a per-owner idempotency key, so a crash between the enqueue and the record
// re-sends at worst inside the engine's own dedupe window.
//
// ── THE DELETION ────────────────────────────────────────────────────────────
// The agent sweep lists instances whose date has passed ({@link listDue}) and
// deletes each through the lifecycle's ordinary delete — machine, volume, the
// final interval closed and charged. The org's flags are read again at that
// moment, so an org classified internal after its lapse loses nothing.

/** How many owed notices one sweep pass sends, and how many due deletions it takes. */
const LAPSE_BATCH = 100;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown error';
}

/** An org's own row — `null` when it cannot be found. */
async function readOrg(organizationId: string) {
  return withOrgServiceWriteContext(organizationId, (tx) =>
    organizationRepository.findByIdInTx(organizationId, tx),
  );
}

/** Run `write` once per workspace the rows live in, bound to that workspace (RLS). */
async function perWorkspace(
  rows: readonly AgentInstance[],
  write: (workspaceId: string) => Promise<unknown>,
): Promise<void> {
  for (const workspaceId of new Set(rows.map((r) => r.workspaceId))) await write(workspaceId);
}

export const agentInstanceLapseService = {
  /**
   * The org's paid AI plan ended: record the lapse (once), schedule every live
   * instance, then tell each owner. A no-op for Motir's own organisations.
   * Returns the deletion date, or null when nothing was scheduled.
   */
  async recordLapse(organizationId: string, at: Date): Promise<Date | null> {
    const org = await readOrg(organizationId);
    if (!org || isUnlimitedAgentOrg(org)) return null;
    const recorded = await withOrgServiceWriteContext(organizationId, (tx) =>
      organizationRepository.setAiPlanLapsedAt(organizationId, at, tx),
    );
    /* v8 ignore next -- `setAiPlanLapsedAt` never leaves a set request unset. */
    if (!recorded.aiPlanLapsedAt) return null;
    const deletesOn = deletionDateFor(recorded.aiPlanLapsedAt);
    const live = await withSystemContext((tx) =>
      agentInstanceRepository.listLiveForOrganization(organizationId, tx),
    );
    await perWorkspace(live, (workspaceId) =>
      withWorkspaceServiceContext(workspaceId, (tx) =>
        agentInstanceRepository.scheduleDeletion(organizationId, deletesOn, tx),
      ),
    );
    // Committed. Now the notice — after, and never able to undo the schedule.
    await this.notify(organizationId, org.name);
    return deletesOn;
  },

  /** The plan is back before the date: clear the lapse and every schedule. */
  async clearLapse(organizationId: string): Promise<void> {
    const org = await readOrg(organizationId);
    if (!org) return;
    if (org.aiPlanLapsedAt !== null) {
      await withOrgServiceWriteContext(organizationId, (tx) =>
        organizationRepository.setAiPlanLapsedAt(organizationId, null, tx),
      );
    }
    const live = await withSystemContext((tx) =>
      agentInstanceRepository.listLiveForOrganization(organizationId, tx),
    );
    await perWorkspace(live, (workspaceId) =>
      withWorkspaceServiceContext(workspaceId, (tx) =>
        agentInstanceRepository.clearScheduledDeletion(organizationId, tx),
      ),
    );
  },

  /**
   * Email each owner of a scheduled, not-yet-told instance in this org ONCE, with
   * their agents and the date, then record the notice. A failed send is logged and
   * left owed — a mail outage must not fail the push that scheduled the deletion,
   * and the sweep sends it later.
   */
  async notify(organizationId: string, organizationName: string): Promise<number> {
    let owed: AgentInstance[];
    try {
      owed = (
        await withSystemContext((tx) =>
          agentInstanceRepository.listLiveForOrganization(organizationId, tx),
        )
      ).filter((r) => r.scheduledDeletionAt !== null && r.deletionNoticedAt === null);
    } catch (err) {
      console.error('[agentInstanceLapseService] could not read the notices owed', {
        organizationId,
        detail: describeError(err),
      });
      return 0;
    }
    if (owed.length === 0) return 0;
    const byOwner = new Map<string, AgentInstance[]>();
    for (const row of owed) byOwner.set(row.ownerId, [...(byOwner.get(row.ownerId) ?? []), row]);
    const owners = await withSystemContext((tx) =>
      userRepository.findByIds([...byOwner.keys()], tx),
    );
    const billingUrl = `${resolveBaseUrlTrimmed()}/settings/organization/billing`;
    let sent = 0;
    // One owner at a time, each on its own: one failed send never skips another.
    for (const owner of owners) {
      const rows = byOwner.get(owner.id) ?? [];
      const deletesOn = rows[0]!.scheduledDeletionAt!;
      try {
        if (owner.email) {
          await sendEvent('email.send', {
            to: owner.email,
            template: 'agents-deletion-scheduled',
            data: {
              recipientName: owner.name,
              organizationName,
              deletionDate: formatDate(deletesOn.toISOString()),
              agentNames: rows.map((r) => r.name),
              billingUrl,
            },
            workspaceId: rows[0]!.workspaceId,
            idempotencyKey: `agent-plan-lapse:${organizationId}:${deletesOn.toISOString()}:${owner.id}`,
          });
          sent += 1;
        }
        // Recorded AFTER the enqueue — a crash in between re-sends, never skips.
        await perWorkspace(rows, (workspaceId) =>
          withWorkspaceServiceContext(workspaceId, (tx) =>
            agentInstanceRepository.markDeletionNoticed(
              rows.filter((r) => r.workspaceId === workspaceId).map((r) => r.id),
              new Date(),
              tx,
            ),
          ),
        );
      } catch (err) {
        console.error('[agentInstanceLapseService] a deletion notice failed — the sweep retries', {
          organizationId,
          ownerId: owner.id,
          detail: describeError(err),
        });
      }
    }
    return sent;
  },

  /** The sweep's retry of every notice still owed, one org at a time. */
  async sendPendingNotices(): Promise<number> {
    const owed = await withSystemContext((tx) =>
      agentInstanceRepository.listScheduledUnnoticed(LAPSE_BATCH, tx),
    );
    let sent = 0;
    for (const organizationId of new Set(owed.map((r) => r.organizationId))) {
      const org = await readOrg(organizationId);
      if (org) sent += await this.notify(organizationId, org.name);
    }
    return sent;
  },

  /**
   * Instances whose deletion date has passed, for the sweep to delete — minus any
   * whose org is now one of Motir's own (§5), whose schedule is cleared instead.
   */
  async listDue(now: Date): Promise<AgentInstance[]> {
    const due = await withSystemContext((tx) =>
      agentInstanceRepository.listDueForDeletion(now, LAPSE_BATCH, tx),
    );
    const kept: AgentInstance[] = [];
    const unlimitedByOrg = new Map<string, boolean>();
    for (const row of due) {
      let unlimited = unlimitedByOrg.get(row.organizationId);
      if (unlimited === undefined) {
        const org = await readOrg(row.organizationId);
        // An org that cannot be read is not deleted from: a destructive act
        // waits for a definite answer.
        unlimited = !org || isUnlimitedAgentOrg(org);
        unlimitedByOrg.set(row.organizationId, unlimited);
        if (org && isUnlimitedAgentOrg(org)) await this.clearLapse(row.organizationId);
      }
      if (!unlimited) kept.push(row);
    }
    return kept;
  },
};
