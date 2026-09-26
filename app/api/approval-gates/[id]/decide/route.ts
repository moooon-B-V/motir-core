import { NextResponse } from 'next/server';
import { gateDecisionRefusalResponse } from '@/lib/approvalGates/decisionRefusalResponse';
import type { GateDecision } from '@/lib/services/approvalGatesService';
import {
  APPROVAL_GATE_REFUSAL_VERDICTS,
  type ApprovalGateRefusalVerdictDTO,
} from '@/lib/dto/approvalGate';
import { pullRequestMergeService } from '@/lib/services/pullRequestMergeService';
import { workItemGateErrorResponse } from '@/lib/workItems/gateResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { PlanNotInExpectedStatusError } from '@/lib/plans/errors';

// POST /api/approval-gates/[id]/decide (Story MOTIR-4778 · Subtask MOTIR-4790)
// — record a DECISION on one approval gate, whatever its kind.
//
// ⚠️ ONE route for every kind, deliberately. The story's claim is that approving
// means one thing whatever is being approved, and a per-kind endpoint would make
// that a property of the CSS rather than of the product. The kind decides the
// verbs and the effect (`lib/approvalGates/registry.ts`); the door does not
// branch on it, and neither does this layer.
//
// ⚠️ IT CALLS `pullRequestMergeService.decideGate`, NOT THE DOOR DIRECTLY (MOTIR-5517 ·
// MOTIR-5624). An APPROVE on a card's approve-to-merge gate MERGES every pull request the
// card delivers, exactly as the item page's *Approve and merge* press does — the approval
// commits first, then each member is merged or enqueued. The response is the decision plus
// a `members` array, one outcome per pull request (`merged` / `enqueued` / `refused` with
// its typed refusal / `no_merge_gate`), empty for a decision that merged nothing. A host
// refusal is a MEMBER outcome of a 200, never an error status: the approval stands
// (`approval-gates.md` §8's THIRD AMENDMENT). Every other decision reaches
// `approvalGatesService.decide` unchanged.
//
// ⚠️ ADDRESSED BY GATE, NOT BY WORK ITEM, and that is not a style choice. A card
// carrying a repository SET legitimately holds SEVERAL simultaneous awaiting
// gates (ADR §6b — uniqueness is `(workItemId, kind, subjectId)`), so
// `/work-items/{key}/decide` could not name which one is being decided. The
// Approvals tab and the item page both already hold gate ids.
//
// Thin HTTP layer (CLAUDE.md § 4-layer): session gate → parse JSON → ONE service
// call → map typed errors. No `db`, no transaction, no business logic.
//
// SESSION-AUTHED, never CI-authed, and the reason is the same one the
// design-result WITHDRAW route gives one directory over: publishing is something
// a build DOES, and deciding is a judgement somebody MAKES. The record has to be
// able to name a person, so a keyless-OIDC arm — which resolves to a workspace
// rather than to a human — must not reach it. ADR §6a: the row is the
// human-in-the-loop evidence an agent-driven pipeline owes an auditor.
//
// JSON body: `decision` (required — `approve` | `request_changes` | `choose` |
// `overturn` | `decline`; `overturn` only on a `decision_confirmation` gate and only
// with a note, `decline` only on a `plan_approval` gate, whose note is optional),
// `optionId` (required with `choose` — the option a choice's decision picks,
// MOTIR-5893), `stamp` (required — the `stamp` the gate read returned, MOTIR-5234)
// and `noteMd` (free text — why they said yes, or what they sent back: optional on
// `approve` / `choose`, REQUIRED on `request_changes` and `overturn`, which the door
// refuses empty as `APPROVAL_GATE_VERB_NOT_OFFERED` — ADR §10a, MOTIR-6074) and
// `refusalVerdict` (`revise` | `re_plan` — what a DESIGN refusal meant, ADR §10d,
// MOTIR-6421: REQUIRED on `request_changes` of a `design_result` gate, refused
// everywhere else; the door answers both as `APPROVAL_GATE_VERB_NOT_OFFERED` with
// `reason` `refusal_verdict_required` / `refusal_verdict_not_offered`).
//
// ⚠️ WHICH VERB FITS WHICH KIND IS THE DOOR'S TO SAY, NOT THIS LAYER'S. `choose` is
// the one verb of a `decision_choice` gate and `approve` is every other kind's; the
// route cannot see the kind without a read, so it checks only the SHAPE and the
// door answers a mismatch as `APPROVAL_GATE_VERB_NOT_OFFERED` (400) under its lock.

const DECISIONS: readonly GateDecision[] = [
  'approve',
  'request_changes',
  'choose',
  'overturn',
  // A plan's DECLINE (MOTIR-6035; ADR §11.4) — offered by `plan_approval` alone, note
  // optional; the door refuses it on every other kind (`decline_on_other_kind`).
  'decline',
];

function parseDecision(value: unknown): GateDecision | null {
  return typeof value === 'string' && (DECISIONS as readonly string[]).includes(value)
    ? (value as GateDecision)
    : null;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;

  const { id } = await params;
  const gateId = id.trim();
  if (gateId === '') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'A gate id is required.' },
      { status: 400 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  const decision = parseDecision(body.decision);
  if (!decision) {
    return NextResponse.json(
      {
        code: 'BAD_REQUEST',
        error:
          '`decision` must be `approve`, `request_changes`, `choose`, `overturn` or `decline`.',
      },
      { status: 400 },
    );
  }

  // A choice's decision names its option; no other verb carries one.
  const optionId = typeof body.optionId === 'string' ? body.optionId.trim() : '';
  if (decision === 'choose' && optionId === '') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`choose` needs an `optionId` — the option being picked.' },
      { status: 400 },
    );
  }

  // ⚠️ `stamp` IS REQUIRED (MOTIR-5234): what the caller was shown, as the gate read
  // returned it. A decision that cannot say what it saw is refused before anything is
  // locked — the door never guesses one.
  if (typeof body.stamp !== 'string' || body.stamp.trim() === '') {
    return NextResponse.json(
      {
        code: 'BAD_REQUEST',
        error: '`stamp` is required — pass the stamp the gate read returned.',
      },
      { status: 400 },
    );
  }
  const stamp = body.stamp;

  // The verdict's SHAPE only (MOTIR-6421): absent or null is "none", anything else must
  // be one of the two values. WHETHER this gate offers one is the door's to say, under
  // its lock — the route cannot see the kind.
  const rawVerdict = body.refusalVerdict;
  if (
    rawVerdict !== undefined &&
    rawVerdict !== null &&
    !(
      typeof rawVerdict === 'string' &&
      (APPROVAL_GATE_REFUSAL_VERDICTS as readonly string[]).includes(rawVerdict)
    )
  ) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`refusalVerdict` must be `revise` or `re_plan`.' },
      { status: 400 },
    );
  }
  const refusalVerdict = (rawVerdict ?? null) as ApprovalGateRefusalVerdictDTO | null;

  try {
    const result = await pullRequestMergeService.decideGate(
      {
        gateId,
        decision,
        optionId: decision === 'choose' ? optionId : null,
        noteMd: typeof body.noteMd === 'string' ? body.noteMd : null,
        refusalVerdict,
        // `api` — a token called the REST API (ADR §6a). NOT `ui`, even though a
        // browser can reach this route: the record answers *how did the decision
        // arrive*, and this door authenticates a caller rather than witnessing a
        // click. An MCP tool deciding a gate would say `mcp` here, and the
        // GitHub sync `github` (§6b's amendment); neither exists yet.
        source: 'api',
        stamp,
      },
      ctx,
    );
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    // The shared project gate's two refusals — a non-browser reads 404, a
    // browser without the kind's permission floor reads 403 — so neither leaks
    // the other.
    const gateError = workItemGateErrorResponse(err);
    if (gateError) return gateError;
    // A PLAN gate's two inherited refusals (MOTIR-6035; ADR §11.5c): a revision HOLDS
    // the plan — the gate is still awaiting, and says until when — or the plan is no
    // longer `planned`. Both are 409s, as the plan routes answer them.
    if (err instanceof PlanNotInExpectedStatusError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    // Every other door refusal — and the held plan — in the ONE mapping the plan
    // routes share (MOTIR-6038): a stale refusal says WHAT moved, a primary-pending one
    // WHICH question, a verb-not-offered one WHICH refusal, a conflict at the press
    // WHICH members.
    const refusal = gateDecisionRefusalResponse(err);
    if (refusal) return refusal;
    throw err;
  }
}
