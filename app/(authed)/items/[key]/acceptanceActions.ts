'use server';

import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { redirect } from 'next/navigation';
import { acceptanceEvidenceService } from '@/lib/services/acceptanceEvidenceService';
import { organizationsService } from '@/lib/services/organizationsService';
import { getErrorsTranslator } from '@/lib/i18n/errorsTranslator';
import { workItemErrorMessage } from '@/lib/workItems/errorMessages';
import { WorkItemError } from '@/lib/workItems/errors';
import { AcceptanceEvidenceError } from '@/lib/acceptanceEvidence/errors';
import { OrganizationNotFoundError, OrgForbiddenError } from '@/lib/organizations/errors';
import type { AcceptanceEvidenceDTO } from '@/lib/dto/acceptanceEvidence';

// Server Actions for the acceptance panel (Story MOTIR-1627 · Subtask
// MOTIR-1634). One service call each; the success branch returns the new state
// so the panel reconciles from THIS response — the caller does the surgical
// router.refresh() (the server-rendered status pill / board), never a refresh of
// the panel's own optimistic state (the inline-edit rule). A typed error comes
// back as the translated `error` string the panel renders inline.

async function requireContext() {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) redirect('/dashboard');
  return { userId: ctx.userId, workspaceId: ctx.workspaceId };
}

export type AcceptanceDecisionResult =
  | { ok: true; storyStatus: 'done' | 'in_progress'; evidence: AcceptanceEvidenceDTO }
  | { ok: false; error: string };

/** Approve or request changes on the current evidence — the gate (in_review → done / in_progress). */
export async function decideAcceptanceAction(
  workItemId: string,
  decision: 'approve' | 'request_changes',
): Promise<AcceptanceDecisionResult> {
  const ctx = await requireContext();
  try {
    const { evidence, storyStatus } = await acceptanceEvidenceService.decide(
      { workItemId, decision },
      ctx,
    );
    return { ok: true, storyStatus, evidence };
  } catch (err) {
    const t = await getErrorsTranslator();
    if (err instanceof WorkItemError) return { ok: false, error: workItemErrorMessage(err, t) };
    if (err instanceof AcceptanceEvidenceError) return { ok: false, error: err.message };
    throw err;
  }
}

export type TurnOnAcceptanceVideoResult = { ok: true } | { ok: false; error: string };

/** Turn acceptance video ON for the org from the panel (the toggle-off admin path). */
export async function turnOnAcceptanceVideoAction(
  organizationId: string,
): Promise<TurnOnAcceptanceVideoResult> {
  const ctx = await requireContext();
  try {
    await organizationsService.setAcceptanceVideoEnabled({
      organizationId,
      actorUserId: ctx.userId,
      enabled: true,
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof OrganizationNotFoundError || err instanceof OrgForbiddenError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}
