'use server';

import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { approvalGatesService, type GateDecision } from '@/lib/services/approvalGatesService';
import { ApprovalGateError } from '@/lib/approvalGates/errors';
import { ApprovalGateAlreadyDecidedError } from '@/lib/approvalGates/errors';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { toGateRefusal, type GateRefusal } from '@/lib/approvalGates/refusals';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';

// Server Action for the approval FRAME (Story MOTIR-4778 · Subtask MOTIR-4792),
// beside the section that renders it — the shape `acceptanceActions.ts` ships,
// one service call and a typed result.
//
// ⚠️ IT RETURNS A TYPED REFUSAL, NEVER A MESSAGE STRING. The frame draws each
// refusal in place with its own copy and its own next action
// (`lib/approvalGates/refusals.ts`), so handing it a server sentence would put
// untranslated prose on a decision surface and let anybody add a failure by
// writing one. The tag is the contract; the words are the client's.
//
// ⚠️ AND IT DOES NOT `revalidatePath`. The caller refreshes — the page-state
// contract (CLAUDE.md) splits the surfaces: the frame reconciles its OWN state
// from THIS response (the inline-edit rule — refreshing the cell that just
// changed re-reads stale data and causes a visible revert), and the SERVER
// surfaces the decision also moves (the status pill, the readiness of every card
// this one was blocking) are what `router.refresh()` is for.

async function requireContext() {
  const session = await getSession();
  if (!session) redirect('/sign-in');
  const ctx = await getActiveProject();
  if (!ctx) redirect('/dashboard');
  return { userId: ctx.userId, workspaceId: ctx.workspaceId };
}

export type DecideGateActionResult =
  | { ok: true; gate: ApprovalGateDTO }
  | { ok: false; refusal: GateRefusal };

/** Record a decision on one approval gate, whatever its kind. */
export async function decideApprovalGateAction(
  gateId: string,
  decision: GateDecision,
  noteMd?: string | null,
): Promise<DecideGateActionResult> {
  const ctx = await requireContext();
  try {
    const { gate } = await approvalGatesService.decide({ gateId, decision, noteMd }, ctx);
    return { ok: true, gate };
  } catch (err) {
    // The shared project gate's two refusals. A non-browser reads NOT_FOUND and
    // a browser without the kind's permission floor reads NOT_AUTHORISED, so
    // neither leaks the other — the same posture the HTTP route takes.
    if (err instanceof ProjectNotFoundError) {
      return { ok: false, refusal: toGateRefusal('APPROVAL_GATE_NOT_FOUND') };
    }
    if (err instanceof PermissionDeniedError) {
      return { ok: false, refusal: toGateRefusal('APPROVAL_GATE_NOT_AUTHORISED') };
    }
    if (err instanceof ApprovalGateError) {
      // ⚠️ The already-decided refusal is the one that can NAME the winner, and
      // that is the whole reason the door locks and re-reads rather than
      // guessing. Passing the label through is what lets the frame say "Mara
      // approved this a moment ago" instead of a generic conflict.
      const decidedByLabel =
        err instanceof ApprovalGateAlreadyDecidedError ? err.decidedByLabel : null;
      return { ok: false, refusal: toGateRefusal(err.tag, { decidedByLabel }) };
    }
    throw err;
  }
}
