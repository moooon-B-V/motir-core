'use server';

import { revalidatePath } from 'next/cache';
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
// so the panel reconciles from THIS response, never a refresh of the panel's own
// optimistic state (the inline-edit rule). A typed error comes back as the
// translated `error` string the panel renders inline.
//
// ⚠️ THIS USED TO SAY *THE CALLER DOES THE SURGICAL `router.refresh()`* AND LEFT
// THE SERVER HALF OUT ENTIRELY (Bug MOTIR-5160). That was word for word the
// reasoning `approvalGateActions.ts` carried before MOTIR-5118, and the
// measurement that falsified it there is what this file now ships against. It is
// NOT that `router.refresh()` fails to fire: in the sibling's failing trace it
// fires and succeeds — the decide action POSTs and returns 200 in 95 ms carrying
// no `x-action-revalidated`, the refresh GETs `/items/<key>?_rsc=…` and returns
// 200 in 113 ms — and the server-rendered status rail still read the
// pre-decision value twenty seconds later. The action's own response carried no
// revalidation, so the fresh tree arrived on a SECOND, separate apply, and that
// apply is the one that intermittently goes missing. Nothing about that
// mechanism was specific to the design gate: it is a property of a Server Action
// whose response carries no revalidation. So the fresh tree goes on the ACTION'S
// OWN RESPONSE, where nothing can race it away.
//
// ⚠️ WHAT WAS AND WAS NOT MEASURED HERE, because the distinction is the whole
// point of the card. The SHAPE was verified by reading (no `revalidatePath`, and
// this comment). The MECHANISM was measured on the sibling, not on this surface.
// The defect itself did NOT reproduce here: `tests/e2e/cloud-acceptance-repaint.spec.ts`
// passed 12/12 against the unfixed code on 2026-09-11. What that guard does prove
// is that it CAN see the defect — deleting `AcceptancePanel`'s `router.refresh()`
// fails both of its tests at the status-rail assertion. Read a green run of it as
// "no repaint regression", never as "the race cannot happen".
//
// ⚠️ AND IT DOES NOT UNDO THE INLINE-EDIT RULE. The panel's own evidence state is
// `useState`-seeded and reconciled from this response (`setEvidence(res.evidence)`),
// so a server re-render cannot clobber the value the reader was just handed. Case
// 1 is about re-READING the edited cell, and nothing here does; the status rail is
// case 2 (`CLAUDE.md` § *Page state after a mutation*).
//
// ⚠️ `turnOnAcceptanceVideoAction` BELOW HAD THE SAME SHAPE AND NOW SHIPS THE
// SAME SERVER HALF (Bug MOTIR-5196) — see its own note for what that card
// measured.

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
export async function decideAcceptanceAction(input: {
  workItemId: string;
  /** The card whose page the panel is on — the path revalidated on success.
   *  A PARAMETER rather than a lookup: the action knows a work-item id, the path
   *  is the card's identifier, and `LateSections` already holds it, so passing it
   *  costs nothing and keeps this action free of a read it would otherwise need
   *  (the shape `approvalGateActions.ts` settled on). */
  itemIdentifier: string;
  decision: 'approve' | 'request_changes';
}): Promise<AcceptanceDecisionResult> {
  const { workItemId, itemIdentifier, decision } = input;
  const ctx = await requireContext();
  try {
    const { evidence, storyStatus } = await acceptanceEvidenceService.decide(
      { workItemId, decision },
      ctx,
    );
    // The server half, on the action's own response. BOTH decisions move the
    // story (`done` on approve, `in_progress` on request_changes), so both owe
    // the rail a repaint — unlike the design gate, where only approval is
    // terminal. A REFUSAL revalidates nothing: no surface moved, and re-rendering
    // the page under a reader who is about to be shown why their press did not
    // land helps nobody. That is why this sits on the success branch and the
    // catch below does not have it.
    revalidatePath(`/items/${itemIdentifier}`);
    return { ok: true, storyStatus, evidence };
  } catch (err) {
    const t = await getErrorsTranslator();
    if (err instanceof WorkItemError) return { ok: false, error: workItemErrorMessage(err, t) };
    if (err instanceof AcceptanceEvidenceError) return { ok: false, error: err.message };
    throw err;
  }
}

export type TurnOnAcceptanceVideoResult = { ok: true } | { ok: false; error: string };

/** Turn acceptance video ON for the org from the panel (the toggle-off admin path).
 *
 * ⚠️ WHAT MOTIR-5196 MEASURED HERE, AND WHAT IT DID NOT — the note this replaces
 * recorded the defect as known-and-deferred, and the replacement owes the reader
 * the result rather than the promise.
 *
 * THE SHAPE WAS THE SAME as `decideAcceptanceAction` above: one service call and
 * a return, no `revalidatePath`, with `AcceptancePanel.turnOn` following it with
 * a bare `router.refresh()`. The surface it moves is server-rendered — the
 * panel's whole `eligibility` prop is a server read, and turning the toggle on is
 * what swaps State B for State A — so it is case 2 of the page-state contract
 * exactly as the decide path is, and the same second-apply race can drop it.
 *
 * THE DEFECT REPRODUCED — the first time in this family, and unlike MOTIR-5160
 * one surface over. `tests/e2e/cloud-acceptance-toggle-repaint.spec.ts` went red
 * **2 of 8** against this action unfixed (2026-09-12), each failure the panel
 * still reading State B twenty seconds after the press. So no deliberate break
 * was needed to establish that the guard can go red; the unfixed build did it.
 *
 * ⚠️ AND THE FIX DOES NOT FULLY CLOSE IT — said here because the next reader of
 * this function is owed it. The same guard is **1/8 and then 1/16 red against
 * this FIXED build**, while the shipped sibling guard is 0/16 twice on the same
 * machine at higher load. On a failing run the action returned **200 in 193 ms**
 * and the refresh `GET …?_rsc=…` returned **200**, so the MOTIR-5118 race —
 * a fresh tree arriving on a second apply that goes missing — is EXCLUDED by
 * the trace: both halves fired and succeeded and the panel did not move. The
 * residual is filed as its own bug, with that spec as its reproduction, and the
 * difference worth chasing is that this panel renders inside the item page's
 * late `<Suspense>` stack (MOTIR-3436) while the sibling's status rail does not.
 *
 * So this `revalidatePath` is shipped as a MEASURED IMPROVEMENT, not as a
 * closure: it is the same server half two sibling surfaces already carry, and it
 * lowers the failure rate, and it is not the whole story here.
 *
 * ⚠️ AND `router.refresh()` STAYS IN THE CALLER. Removing it is a SEPARATE claim
 * nobody has tested, and on the design gate one tier over it was measured
 * NECESSARY. It is also what this card's guard breaks to prove itself red-able,
 * so deleting it would take the detector with it. */
export async function turnOnAcceptanceVideoAction(input: {
  organizationId: string;
  /** The card whose page the panel is on — the path revalidated on success.
   *  A PARAMETER rather than a lookup, the shape `decideAcceptanceAction` and
   *  `approvalGateActions.ts` both settled on: the action knows an organisation
   *  id, the path is the CARD's identifier, and `AcceptancePanel` already holds
   *  it (MOTIR-5160 threaded it through `AcceptancePanelProps`). */
  itemIdentifier: string;
}): Promise<TurnOnAcceptanceVideoResult> {
  const { organizationId, itemIdentifier } = input;
  const ctx = await requireContext();
  try {
    await organizationsService.setAcceptanceVideoEnabled({
      organizationId,
      actorUserId: ctx.userId,
      enabled: true,
    });
    // The server half, on the action's own response. A REFUSAL revalidates
    // nothing — the toggle did not move, so no surface did, and re-rendering the
    // page under a reader about to be shown why their press did not land helps
    // nobody. That is why this sits on the success branch and the catch below
    // does not have it.
    revalidatePath(`/items/${itemIdentifier}`);
    return { ok: true };
  } catch (err) {
    if (err instanceof OrganizationNotFoundError || err instanceof OrgForbiddenError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}
