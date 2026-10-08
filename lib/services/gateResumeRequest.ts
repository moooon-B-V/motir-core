import type { ApprovalGateKind } from '@/generated/prisma/client';
import { isRunHoldingGateKind } from '@/lib/dispatchRuns/heldGates';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { dispatchRunHeldGateRepository } from '@/lib/repositories/dispatchRunHeldGateRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// THE ASK for an automatic hosted resume (Story MOTIR-7701 · MOTIR-7710) — what the
// decide doors call after a decision commits. Its own module, apart from
// `gateResumeService`, so the decide door does not import the hosted start (which
// would close an import cycle through the gate service).

/** The `run/gate-resume.requested` event payload. */
export interface GateResumeRequestedData {
  workspaceId: string;
  /** The approved gate. */
  gateId: string;
  /** The gate id — the job's dedup key. */
  idempotencyKey: string;
}

/**
 * ASK for the resume of whatever run an approved gate on this card released — after
 * the deciding transaction commits, from both decide doors (the decide door and the
 * design-approval-off system approval). One indexed read when nothing waits on the
 * card; otherwise one event, keyed on the LATEST gate of the kind so a redelivery or
 * a second publish asks nothing new.
 *
 * ⚠️ NEVER FAILS THE DECISION. The approval is committed by the time this runs; an
 * enqueue that throws is logged and the run waits on To resume for a person, which
 * is the state it would be in without this card.
 */
export async function requestGateResumeAfterDecision(
  gate: { workItemId: string | null; kind: ApprovalGateKind },
  workspaceId: string,
): Promise<void> {
  const { workItemId, kind } = gate;
  if (workItemId === null || !isRunHoldingGateKind(kind)) return;
  try {
    const latest = await withWorkspaceServiceContext(workspaceId, async (tx) => {
      const held = await dispatchRunHeldGateRepository.listRunIdsByWorkItemAndKind(
        workItemId,
        kind,
        tx,
      );
      if (held.length === 0) return null;
      return approvalGateRepository.findLatestByWorkItem(workItemId, kind, tx);
    });
    if (!latest || latest.state !== 'approved') return;
    await sendEvent('run/gate-resume.requested', {
      workspaceId,
      gateId: latest.id,
      idempotencyKey: latest.id,
    });
  } catch (err) {
    console.error('[gate-resume] enqueue failed after a committed decision', err);
  }
}
