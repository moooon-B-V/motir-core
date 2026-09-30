import { toGateRefusal, type GateRefusal } from '@/lib/approvalGates/refusals';

// *REVIEW AGAIN* — the press on an `agent_review` whose review COULD NOT RUN (Story
// MOTIR-1626 · MOTIR-6825; `approval-gates.md` §12.6). It calls the start card's route,
// `POST /api/approval-gates/[id]/review-again` (MOTIR-6820), which clears the reason and
// requests ONE new review run for the same gate and version. There is no automatic retry;
// this press is the only one.
//
// What the route answers, as the frame reads it:
// - 202 — requested: the frame turns back to *Reviewing*, and the page re-reads.
// - 409 `REVIEW_AGAIN_NOT_OFFERED` — the gate already moved (a run is in flight, the reason
//   was cleared, or it was decided): nothing to refuse, the page's re-read shows where it is.
// - 404 / 403 — the frame's own not-found / not-authorised refusals, drawn in place.
// - anything else, or no answer at all — the frame's `UNEXPECTED`, which is retried.

export type ReviewAgainResult = { ok: true; moved: boolean } | { ok: false; refusal: GateRefusal };

export async function reviewAgainRequest(gateId: string): Promise<ReviewAgainResult> {
  let res: Response;
  try {
    res = await fetch(`/api/approval-gates/${encodeURIComponent(gateId)}/review-again`, {
      method: 'POST',
    });
  } catch {
    return { ok: false, refusal: toGateRefusal('UNEXPECTED') };
  }
  if (res.status === 202) return { ok: true, moved: false };
  if (res.status === 409) return { ok: true, moved: true };
  if (res.status === 404) return { ok: false, refusal: toGateRefusal('APPROVAL_GATE_NOT_FOUND') };
  if (res.status === 403) {
    return { ok: false, refusal: toGateRefusal('APPROVAL_GATE_NOT_AUTHORISED') };
  }
  return { ok: false, refusal: toGateRefusal('UNEXPECTED') };
}
