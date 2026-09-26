import type { ApprovalGateKindDTO } from '@/lib/dto/approvalGate';

/**
 * THE REFUSAL SEED (story MOTIR-6068 · MOTIR-6208; `approval-gates.md` §10f) —
 * what the planning surface opens with when it is launched from a refused gate.
 * Read by gate id through `GET /api/approval-gates/{id}/planning-seed`.
 *
 *  - `intent` — what the turn asks for: `replan` after a refusal, `plan` forward
 *    after a PICKED option (story MOTIR-6069 · MOTIR-6433);
 *  - `anchorKey` — where the surface anchors: the refused gate's own work item, or
 *    for a pick the choice's parent (else the nearest not-`done` ancestor); `null`
 *    means THE PROJECT (`docs/decisions/picked-option-planning.md` §2);
 *  - `firstTurn` — the turn pre-filled UNSENT in the composer, composed on the
 *    server by the kind's composer (`REFUSAL_SEED_COMPOSERS`) in the request's
 *    locale; it quotes the gate's recorded reason verbatim;
 *  - `seededSessionId` — the viewer's OWN recent session this gate seeded, or
 *    `null`. When set, the surface reopens that session instead of pre-filling.
 */
export interface PlanningSeedDTO {
  gateId: string;
  gateKind: ApprovalGateKindDTO;
  intent: 'plan' | 'replan';
  anchorKey: string | null;
  firstTurn: string;
  seededSessionId: string | null;
}

/** The route's 200 body. */
export interface PlanningSeedReadDTO {
  seed: PlanningSeedDTO;
}
