'use server';

import { revalidatePath } from 'next/cache';
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
// ⚠️ IT REVALIDATES THE ITEM PAGE, AND THE CALLER REFRESHES TOO — BOTH HALVES,
// ON PURPOSE (Bug MOTIR-5118). The page-state contract (CLAUDE.md) splits the
// surfaces: the frame reconciles its OWN state from THIS response (the
// inline-edit rule — refreshing the cell that just changed re-reads stale data
// and causes a visible revert), while the SERVER surfaces the decision also
// moves — the core-fields status rail, the record band's `Files kept` line, the
// readiness of every card this one was blocking — are case 2, and they need a
// server render to arrive.
//
// ⚠️ THIS USED TO SAY *IT DOES NOT `revalidatePath` — THE CALLER REFRESHES*, AND
// THE CALLER'S REFRESH ALONE WAS MEASURED INSUFFICIENT. It is not that
// `router.refresh()` fails to fire. In the failing run's trace it fires, and it
// succeeds: the decide action POSTs at `14:23:14.429` and returns 200 in 95 ms,
// the refresh GETs `/items/GATE-2?_rsc=…` at `14:23:14.526` and returns 200 in
// 113 ms — and the status rail still read `In Progress` twenty seconds later,
// with the frame beside it reading `Approved`. The action's own response carried
// no revalidation (no `x-action-revalidated`), so the fresh tree arrived on a
// SECOND, separate apply, and that apply is the one that goes missing. It is
// intermittent by construction: the same walk repaints in place on a quiet lane
// and does not on a loaded one, which is why this shipped looking correct.
//
// So the fix is to put the fresh tree on the ACTION'S OWN RESPONSE, where
// nothing can race it away — which is exactly what the sibling twenty lines away
// in `actions.ts` already does (`createLinkAction`, whose last line is
// `revalidatePath(`/items/${input.identifier}`)`). The client half stays: it is
// what reaches the surfaces on a navigation the server tree does not cover, and
// removing it is a separate claim nobody has measured.
//
// ⚠️ AND IT DOES NOT UNDO THE INLINE-EDIT RULE. The frame's own state is
// `useState`-seeded in `DesignResultSection`, so a fresh `gate` prop cannot
// clobber the value this reader was just handed — the port is keyed on the
// SERVER's gate deliberately, and a re-render is what swaps in its pinned
// answer. Case 1 is about re-READING the edited cell, and nothing here does.
//
// ⚠️ THE IDENTIFIER IS A PARAMETER RATHER THAN A LOOKUP. The action knows a
// gate id; the path is the CARD's. `DesignResultSection` already holds
// `itemIdentifier` (it renders it in the consequence line), so passing it costs
// nothing and keeps this action free of a read it would otherwise need.

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
export async function decideApprovalGateAction(input: {
  gateId: string;
  decision: GateDecision;
  /** The card whose page the frame is on — the path revalidated on success. */
  identifier: string;
  noteMd?: string | null;
}): Promise<DecideGateActionResult> {
  const { gateId, decision, identifier, noteMd } = input;
  const ctx = await requireContext();
  try {
    const { gate } = await approvalGatesService.decide(
      // `ui` — a SERVER ACTION is a person pressing the control in Motir. It is
      // the audit's strongest claim (ADR §6a: *"a human click must be
      // distinguishable from a programmatic call"*), so it is stated at the one
      // call site that actually knows it rather than defaulted in the door.
      { gateId, decision, noteMd, source: 'ui' },
      ctx,
    );
    // The server half, on the action's own response. A REFUSAL revalidates
    // nothing — no surface moved, and re-rendering the page under a reader who
    // is about to be shown why their press did not land helps nobody.
    revalidatePath(`/items/${identifier}`);
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
