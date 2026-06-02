'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getWorkspaceContext } from '@/lib/workspaces';
import { jobsDashboardService } from '@/lib/services/jobsDashboardService';
import { ReplayForbiddenError, DlqEntryNotFoundError } from '@/lib/jobs/errors';

// Server Actions for the operator dashboard (Subtask 1.6.5). HTTP/transport
// layer only: read the session + active workspace, call exactly one service
// method, translate typed errors into a UI result. No db.* here — the service
// owns the transaction + RLS context + owner gate.

export interface ActionResult {
  ok: boolean;
  error?: string;
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
 */
export async function replayDlqAction(dlqId: string): Promise<ActionResult> {
  const { userId, workspaceId } = await requireContext();
  if (!dlqId) return { ok: false, error: 'Missing dead-letter id.' };

  try {
    await jobsDashboardService.replayDLQ({ dlqId, workspaceId, userId });
  } catch (err) {
    if (err instanceof ReplayForbiddenError) {
      return { ok: false, error: 'Only a workspace owner can replay jobs.' };
    }
    if (err instanceof DlqEntryNotFoundError) {
      return { ok: false, error: 'That dead-letter entry no longer exists.' };
    }
    throw err;
  }

  revalidatePath('/settings/workspace/jobs');
  return { ok: true };
}
