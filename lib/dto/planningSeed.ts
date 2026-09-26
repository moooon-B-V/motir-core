import type { ApprovalGateKindDTO } from '@/lib/dto/approvalGate';

/**
 * THE REFUSAL SEED (story MOTIR-6068 · MOTIR-6208; `approval-gates.md` §10f) —
 * what the planning surface opens with when it is launched from a refused gate.
 * Read by gate id through `GET /api/approval-gates/{id}/planning-seed`.
 *
 *  - `anchorKey` — where the surface anchors: the refused gate's work item key,
 *    or for a design Re-plan the design card's PARENT (§10h; MOTIR-6424) — the
 *    card itself when it has none;
 *  - `firstTurn` — the turn pre-filled UNSENT in the composer, composed on the
 *    server by the kind's composer (`REFUSAL_SEED_COMPOSERS`) in the request's
 *    locale; it quotes the gate's recorded reason verbatim;
 *  - `seededSessionId` — the viewer's OWN recent session this gate seeded, or
 *    `null`. When set, the surface reopens that session instead of pre-filling.
 */
export interface PlanningSeedDTO {
  gateId: string;
  gateKind: ApprovalGateKindDTO;
  anchorKey: string;
  firstTurn: string;
  seededSessionId: string | null;
}

/** The route's 200 body. */
export interface PlanningSeedReadDTO {
  seed: PlanningSeedDTO;
}
