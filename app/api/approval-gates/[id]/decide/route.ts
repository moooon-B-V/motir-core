import { NextResponse } from 'next/server';
import { ApprovalGateError, type ApprovalGateErrorTag } from '@/lib/approvalGates/errors';
import { approvalGatesService, type GateDecision } from '@/lib/services/approvalGatesService';
import { workItemGateErrorResponse } from '@/lib/workItems/gateResponse';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';

// POST /api/approval-gates/[id]/decide (Story MOTIR-4778 · Subtask MOTIR-4790)
// — record a DECISION on one approval gate, whatever its kind.
//
// ⚠️ ONE route for every kind, deliberately. The story's claim is that approving
// means one thing whatever is being approved, and a per-kind endpoint would make
// that a property of the CSS rather than of the product. The kind decides the
// verbs and the effect (`lib/approvalGates/registry.ts`); the door does not
// branch on it, and neither does this layer.
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
// JSON body: `decision` (required — `approve` | `request_changes`) and `noteMd`
// (optional free text — why they said yes, or what they sent back).

const DECISIONS: readonly GateDecision[] = ['approve', 'request_changes'];

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
      { code: 'BAD_REQUEST', error: '`decision` must be `approve` or `request_changes`.' },
      { status: 400 },
    );
  }

  try {
    const result = await approvalGatesService.decide(
      {
        gateId,
        decision,
        noteMd: typeof body.noteMd === 'string' ? body.noteMd : null,
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
    if (err instanceof ApprovalGateError) {
      return NextResponse.json(
        { code: err.code, error: err.message },
        { status: APPROVAL_GATE_STATUS[err.tag] },
      );
    }
    throw err;
  }
}

/**
 * Typed domain error → HTTP status, TOTAL over `ApprovalGateErrorTag` — so a tag
 * added to that union is a compile error here rather than an unmapped throw,
 * which is a bare 500 on the one surface built to explain refusals in place.
 *
 * `409` for both terminal-state refusals: the request was well-formed and the
 * resource is no longer in a state that admits it. `403` for the relationship
 * refusal — the actor cleared the permission floor and may see the gate; saying
 * "not found" here would be a lie the surface cannot render. `501` for an
 * unregistered kind, which is not the caller's fault and not a permanent
 * refusal: it is a hole the registry names an owning card for.
 */
const APPROVAL_GATE_STATUS: Record<ApprovalGateErrorTag, number> = {
  APPROVAL_GATE_NOT_FOUND: 404,
  APPROVAL_GATE_NOT_AUTHORISED: 403,
  APPROVAL_GATE_ALREADY_DECIDED: 409,
  APPROVAL_GATE_SUPERSEDED: 409,
  APPROVAL_GATE_ALREADY_AWAITING: 409,
  APPROVAL_GATE_KIND_UNREGISTERED: 501,
};
