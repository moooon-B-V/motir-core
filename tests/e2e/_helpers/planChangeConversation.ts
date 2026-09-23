import { plansService } from '@/lib/services/plansService';
import { adminDb } from './db-reset';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { buildScope, PROJECT_SCOPE_KEY } from '@/lib/planChange/scope';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

/**
 * Run a seed's plan APPEND as a turn of its CONVERSATION, then put the
 * conversation back as the browser will find it (bug MOTIR-5640).
 *
 * ⚠️ WHY THE E2E SEEDS OWE THIS. A real submit does two things: it opens the
 * Plan bound to the job, AND it stamps that job onto the plan-change SESSION as
 * its `lastJobId` (`planChangeSessionsService.submit`). The seeds stood in for
 * the handler and did only the first, so the plans they produced belonged to no
 * conversation. Once a plan PARKS its targets, a card is planned by one planner
 * at a time — and a session-less seeded plan read as a SECOND planner: two turns
 * over one card were refused with `PlanTargetLockedError`, and a contextual seed
 * fought the browser's own session-open on its anchor.
 *
 * ⚠️ AND WHY THE LINK IS ONLY FOR THE APPEND — found by the merge queue, the
 * second time. The first version of this helper LEFT `lastJobId` pointing at the
 * seeded job. But the specs seed the plan BEFORE the user types, as a stand-in
 * for what the handler will produce after the (stubbed) submit — and a session
 * whose `lastJobId` already names a `planned` plan is, to the rail, a FINISHED
 * turn awaiting review. So the rail resumed it on mount and showed the confirm
 * bar before any turn was sent: `cloud-contextual-plan-confirm.spec.ts`'s
 * failed-run case saw a gate it should never have had, and the cases that EXPECT
 * a gate could pass without their turn ever running.
 *
 * So the conversation is linked for exactly as long as the append needs to
 * resolve its plan to it (a conversation's plan parks nothing — its session is
 * the holder), and `lastJobId` is then restored to what it was: at page load, no
 * turn has been submitted. A session row that did not exist before is KEPT, with
 * `lastJobId` null — the same row the rail's own open would create, which it
 * then resumes rather than forking.
 *
 * ⚠️ AND IT IS BOUND. `db` is RLS-scoped: an unbound read finds nothing and an
 * unbound write is refused, so every tenant statement runs inside
 * `withWorkspaceServiceContext`.
 */
export async function asConversationTurn<T>(
  ctx: ServiceContext,
  projectId: string,
  /** The anchor: a work-item ID when `anchorIsWorkItemId`, else a raw scope key.
   *  `null` means the project-wide thread. */
  anchor: string | null,
  jobId: string,
  append: (sessionId: string) => Promise<T>,
  opts: { anchorIsWorkItemId?: boolean } = {},
): Promise<T> {
  const { sessionId, previousLastJobId } = await withWorkspaceServiceContext(
    ctx.workspaceId,
    async (tx) => {
      let scopeKey = PROJECT_SCOPE_KEY;
      if (anchor !== null) {
        if (opts.anchorIsWorkItemId) {
          // The scope key is built from the anchor's `MOTIR-<n>` KEY — what
          // `buildScope` canonicalizes and the contextual route persists.
          const item = await tx.workItem.findUniqueOrThrow({ where: { id: anchor } });
          scopeKey = buildScope([item.identifier]).scopeKey;
        } else {
          scopeKey = anchor;
        }
      }
      const existing = await tx.planChangeSession.findFirst({ where: { projectId, scopeKey } });
      if (existing) {
        await tx.planChangeSession.update({
          where: { id: existing.id },
          data: { lastJobId: jobId },
        });
        return { sessionId: existing.id, previousLastJobId: existing.lastJobId };
      }
      const created = await tx.planChangeSession.create({
        data: { workspaceId: ctx.workspaceId, projectId, scopeKey, lastJobId: jobId },
      });
      return { sessionId: created.id, previousLastJobId: null };
    },
  );

  try {
    return await append(sessionId);
  } finally {
    // Back to the state the BROWSER finds: no turn submitted yet.
    await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      tx.planChangeSession.update({
        where: { id: sessionId },
        data: { lastJobId: previousLastJobId },
      }),
    );
  }
}

// ── Session TIME, set rather than waited (Story MOTIR-6011 · MOTIR-6027) ─────
//
// The resume window is two hours (`PLAN_SESSION_RESUME_WINDOW_MS`), and a spec
// never waits real time for it: it moves the session's `lastActivityAt` back.
// That column is the ONLY input the window reads — `updatedAt` and the turns'
// own timestamps are not consulted — so moving it is the product's own notion
// of "a conversation you left three hours ago", not a simulation of one.

/** The member's most recently active planning conversation in the project. */
export async function latestPlanningSession(
  email: string,
): Promise<{ id: string; workspaceId: string; createdById: string }> {
  const user = await adminDb.user.findUniqueOrThrow({ where: { email } });
  const session = await adminDb.planChangeSession.findFirstOrThrow({
    where: { createdById: user.id },
    orderBy: { lastActivityAt: 'desc' },
  });
  return { id: session.id, workspaceId: session.workspaceId, createdById: user.id };
}

/** Move a conversation's last activity `ms` into the past. */
export async function agePlanningSession(sessionId: string, ms: number): Promise<void> {
  await adminDb.planChangeSession.update({
    where: { id: sessionId },
    data: { lastActivityAt: new Date(Date.now() - ms) },
  });
}

/**
 * Let the conversation's run FINISH: its latest plan gains one proposal and
 * closes as `planned` — what the planner's handler does when a real job
 * completes (`addProposals` → `markPlanned`, the same shipped services). The lane's
 * motir-ai mock settles a plan job with nothing proposed, so without this the
 * plan would stay `generating` for ever.
 */
export async function finishSessionPlan(sessionId: string, title: string): Promise<string> {
  const plan = await adminDb.plan.findFirstOrThrow({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
  });
  const session = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } });
  const ctx = { userId: session.createdById!, workspaceId: session.workspaceId };
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title, kind: 'task' } }],
    ctx,
  );
  await plansService.markPlanned(plan.id, ctx);
  return plan.id;
}
