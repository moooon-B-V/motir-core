'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getErrorsTranslator } from '@/lib/i18n/errorsTranslator';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { jobsDashboardService } from '@/lib/services/jobsDashboardService';
import {
  ReplayForbiddenError,
  DlqEntryNotFoundError,
  SystemReplayForbiddenError,
  SystemReplayWorkspaceRowError,
} from '@/lib/jobs/errors';

// Server Actions for the operator dashboard (Subtask 1.6.5). HTTP/transport
// layer only: read the session + active workspace, call exactly one service
// method, translate typed errors into a UI result. No db.* here — the service
// owns the transaction + RLS context + owner gate.

export interface ActionResult {
  ok: boolean;
  error?: string;
  /**
   * Set by {@link replayDlqAction} when the entry had ALREADY been replayed and
   * this call enqueued nothing (MOTIR-3730). A success, not a failure — the
   * surface says so rather than showing the operator a constraint violation for
   * a second click on a slow button.
   */
  alreadyReplayed?: boolean;
}

async function requireContext() {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getWorkspaceContext();
  if (!ctx) redirect('/dashboard');
  return { userId: session.user.id, workspaceId: ctx.workspaceId };
}

/**
 * Replay a dead-lettered job. The service re-checks the owner gate server-side,
 * so a non-owner posting this directly still fails. On success the page is
 * revalidated so the DLQ row's "Replayed" stamp + badge count refresh.
 *
 * A row that was already replayed comes back `ok: true, alreadyReplayed: true`
 * (MOTIR-3730) — the engine's dedup answering a double-click, which is neither
 * a failure to translate here nor something to hide behind a second success
 * toast that claims a re-run happened.
 */
export async function replayDlqAction(dlqId: string): Promise<ActionResult> {
  const { userId, workspaceId } = await requireContext();
  const t = await getErrorsTranslator();
  if (!dlqId) return { ok: false, error: t('actions.missingDlqId') };

  let outcome: 'replayed' | 'already-replayed';
  try {
    ({ outcome } = await jobsDashboardService.replayDLQ({ dlqId, workspaceId, userId }));
  } catch (err) {
    if (err instanceof ReplayForbiddenError) {
      return { ok: false, error: t('actions.ownerOnlyReplay') };
    }
    if (err instanceof DlqEntryNotFoundError) {
      return { ok: false, error: t('actions.dlqGone') };
    }
    throw err;
  }

  // BOTH doors onto this surface (Story MOTIR-4843 · MOTIR-4849). Above the
  // workspace-tier reveal the dashboard is its own route; below it, it is a
  // section on `/settings/organization` — and a replay performed there must
  // re-read the row it just stamped, or the DLQ table keeps showing the entry as
  // un-replayed until something else happens to refresh the page.
  revalidatePath('/settings/workspace/jobs');
  revalidatePath('/settings/organization');
  return { ok: true, alreadyReplayed: outcome === 'already-replayed' };
}

/**
 * The OPERATOR's replay of a dead letter with no workspace (MOTIR-8083) — the
 * System tab's Replay control. Transport only: the session, one service call,
 * typed errors to copy. The platform-operator gate and the "no workspace on the
 * row" refusal both live in the service, so a non-operator posting this directly
 * fails exactly as a click would, and so does a workspace's row.
 *
 * No workspace context is read: the operator replays across the deployment, and
 * the row being replayed has no workspace to scope to.
 */
export async function replaySystemDlqAction(dlqId: string): Promise<ActionResult> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const t = await getErrorsTranslator();
  if (!dlqId) return { ok: false, error: t('actions.missingDlqId') };

  let outcome: 'replayed' | 'already-replayed';
  try {
    ({ outcome } = await jobsDashboardService.replaySystemDLQ({
      dlqId,
      userId: session.user.id,
      userEmail: session.user.email,
    }));
  } catch (err) {
    if (err instanceof SystemReplayForbiddenError) {
      return { ok: false, error: t('actions.systemReplayOperatorOnly') };
    }
    if (err instanceof SystemReplayWorkspaceRowError) {
      return { ok: false, error: t('actions.systemReplayWorkspaceRow') };
    }
    if (err instanceof DlqEntryNotFoundError) {
      return { ok: false, error: t('actions.dlqGone') };
    }
    throw err;
  }

  // Both doors onto the System tab, as `replayDlqAction` revalidates them.
  revalidatePath('/settings/workspace/jobs');
  revalidatePath('/settings/organization');
  return { ok: true, alreadyReplayed: outcome === 'already-replayed' };
}
