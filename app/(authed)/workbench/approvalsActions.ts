'use server';

import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { designEvidenceService } from '@/lib/services/designEvidenceService';
import type { DesignGateSubjectDTO } from '@/lib/dto/designEvidence';

// The Approvals tab's ONE server action (Story MOTIR-4879 · Subtask
// MOTIR-4794) — load the design a row is about, WHEN THE ROW OPENS.
//
// ⚠️ WHY A LAZY LOAD AND NOT A FIELD ON THE ROW. The frame's premise is that you
// see what you are approving — its own first cut drew the button alone and was
// rejected for exactly that ("Approve button without review doesn't stand"). So
// band 2 has to render the real design, not a summary of it. But a PAGE of rows
// is up to `HOME_PAGE_SIZE` gates, and putting the full evidence + its assets on
// every row would be the N+1 `listAwaitingMe` was deliberately written to avoid
// — paid on every render, to show a design the reader opens one of.
//
// So the LIST read carries what a row shows (`ApprovalQueueRowDto.subject` — the
// count, the sha, the note lead) and this action carries what the PORT shows,
// once, for the row a reader actually opened. `design/workbench/approvals-row.mock.html`
// Panel 3 is the shape.
//
// ⚠️ IT IS THE SAME SERVICE METHOD THE ITEM PAGE USES, deliberately.
// `getForGateSubject` reads by the gate's own `subjectId` — never
// `findCurrentByWorkItem` — so a republish cannot silently re-point an in-flight
// question at a version the reader never saw (ADR §6c), and it takes the
// `workItemId` as a GUARD that the evidence belongs to the card being rendered.
// Both properties are why this composes that method rather than reaching for the
// repository.

/** The design a gate is about, for the port of an opened row. */
export async function loadApprovalSubjectAction(
  workItemId: string,
  subjectId: string,
): Promise<DesignGateSubjectDTO> {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) redirect('/sign-in');
  return designEvidenceService.getForGateSubject(
    { workItemId, subjectId },
    { userId: ctx.userId, workspaceId: ctx.workspaceId },
  );
}
