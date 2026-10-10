import type { PlanChangeSession, Prisma } from '@/generated/prisma/client';
import type {
  GateEffect,
  GateEffectArgs,
  GateHandler,
  GateRoutingArgs,
} from '@/lib/approvalGates/registry';
import { ApprovalGateVerbNotOfferedError } from '@/lib/approvalGates/errors';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { sessionWaitingState } from '@/lib/planChange/sessionWaitingState';

// THE `planning_session` HANDLER (Story MOTIR-7905 · MOTIR-7913; ADR
// `docs/decisions/approval-gates.md` §1's MOTIR-7906 amendment).
//
// The SECOND card-less kind, copied from `planApprovalHandler`: its `subjectId` is the
// `PlanChangeSession.id`, `args.item` is always null, `routeTo` answers null because the
// raise writes `routedToId` (the session's owner), and nothing here calls `requireArgsCard`.
//
// ⚠️ IT HAS NO VERBS. The person answers a planning session by SENDING A TURN, which
// withdraws the gate (`answered`) in the turn's own transaction (`planningSessionGateService`).
// Approve and request changes both throw `ApprovalGateVerbNotOfferedError`; the decide door
// refuses every verb on the kind before it dispatches, and these answer the same refusal so
// a caller that reached the handler directly cannot record one.

/** The session a gate asks about, in the gate's own workspace, or null when it is gone. */
async function sessionOf(
  gate: GateEffectArgs['gate'],
  tx: Prisma.TransactionClient,
): Promise<PlanChangeSession | null> {
  return planChangeSessionRepository.findById(gate.subjectId, gate.workspaceId, tx);
}

export const planningSessionGateHandler: GateHandler<PlanChangeSession> = {
  async resolveSubject({ gate, tx }: GateEffectArgs): Promise<PlanChangeSession | null> {
    return sessionOf(gate, tx);
  },

  // The moment the session began waiting, as the stamp — null once it stops. A weaker row
  // is the honest answer for a session that is gone, never a refusal.
  async subjectVersion({ gate, tx }: GateEffectArgs): Promise<string | null> {
    const session = await sessionOf(gate, tx);
    return session?.awaitingPersonSince?.toISOString() ?? null;
  },

  // ⚠️ NULL FOR A CARD-LESS GATE, deliberately — `routeTo` is synchronous and is given no
  // session (`item` is null). The raise writes `routedToId` = the session's owner, and every
  // read of a card-less row routes by that column.
  routeTo(_args: GateRoutingArgs): string | null {
    return null;
  },

  // The raise's generic loop skips card-less kinds, so this is asked only with a gate in
  // hand: the session's id while it STILL waits on its person, else null.
  async currentSubject(args: GateRoutingArgs): Promise<string | null> {
    const gate = (args as Partial<GateEffectArgs>).gate;
    if (!gate) return null;
    const session = await sessionOf(gate, args.tx);
    return session && sessionWaitingState(session) === 'awaiting_person' ? session.id : null;
  },

  // The planning permission the overlay already asserts. There is no work item, so §2's
  // relationship rule does not apply, and no verb for it to gate.
  permission: 'ai:plan',

  statusIntent: null,

  async approve({ gate }: GateEffectArgs): Promise<GateEffect> {
    throw new ApprovalGateVerbNotOfferedError(gate.id, 'no_verbs_on_planning_session');
  },

  async requestChanges({ gate }: GateEffectArgs): Promise<GateEffect> {
    throw new ApprovalGateVerbNotOfferedError(gate.id, 'no_verbs_on_planning_session');
  },
};
