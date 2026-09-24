import { NextResponse } from 'next/server';
import { InvalidRequestError } from '@/lib/api/v1/errors';
import { withV1Route } from '@/lib/api/v1/route';
import { approvalGateKindSchema, presentApprovalGateRecord } from '@/lib/api/v1/workItems/schema';
import { approvalGateAccessService } from '@/lib/services/approvalGateAccessService';

// GET /api/v1/work-items/{key}/approval-gate?kind=<gate kind> (Bug MOTIR-6191) —
// ONE gate's DECISION RECORD: its state, the note the decider wrote, who wrote
// it, when, on which version, through which surface.
//
// ── Why it exists on the PUBLIC surface and not only on MCP ─────────────────
// A DISPATCHED agent speaks `/api/v1` and nothing else (the CLI retired its MCP
// transport in 11.5.6), and it has exactly the problem this bug is about: it is
// the author of the `decision_approval` and `design_result` questions a person
// answers, and every door onto `ApprovalGate.noteMd` was session-authed — the
// overlay's `/api/work-items/approval-gate` resolves `getActiveProject()` on its
// first line. So *"Request changes, and read my note"* was an instruction no
// agent could follow, on the gate kind whose author is ALWAYS an agent
// (`approval-gates.md` §8's FIFTH AMENDMENT: `decision_approval` is raised only
// on `type: decision` + `executor: coding_agent`). The MCP twin is
// `get_approval_gate`, for the runbook; this is the CLI's door, and both call the
// one service method so they cannot drift.
//
// ── `project:browse`, and deliberately nothing new ─────────────────────────
// Reading a decision about the card you are working on is browsing the project.
// The key is one `CLI_TOKEN_GRANT` already carries, so a dispatched agent reaches
// this without the grant being widened — the property that keeps the whole fix
// inside the credential a sandboxed run already holds.
//
// ⚠️ AND IT IS A READ. Nothing here decides a gate, and §2's *"the decide route
// is session-authed and no MCP tool or `/api/v1` operation asserts the key"* is
// still true verbatim: `approval:decide_any` is not asserted here and there is
// still no agent path to approving — §1: *"and there is not meant to be"*. Those
// are two opposite questions, and §11.5b's wording invites merging them.
//
// ONE service call. The verdict rules, the 404-not-403 answer and the choice of
// WHICH gate wins are `approvalGateAccessService`'s and are not re-derived here.
export const GET = withV1Route<{ key: string }>({ permission: 'project:browse' }, async (ctx) => {
  const raw = new URL(ctx.req.url).searchParams.get('kind');
  const kind = approvalGateKindSchema.safeParse(raw?.trim());
  if (!kind.success) {
    // A 422 the caller can fix, BEFORE any read — the same disposition
    // `resolveWorkItemKey` gives a malformed key, and for its reason: answering
    // 404 would spend a round trip telling them nothing about what was wrong.
    throw new InvalidRequestError(
      'INVALID_GATE_KIND',
      '`kind` must be one of: ' + approvalGateKindSchema.options.join(', ') + '.',
    );
  }
  const record = await approvalGateAccessService.getGateRecord(
    { key: ctx.params.key, kind: kind.data },
    ctx.service,
  );
  return NextResponse.json(presentApprovalGateRecord(record), {
    // A gate's state changes under the reader by design — never serve a decision
    // that has since been made, or hide one that has.
    headers: { 'Cache-Control': 'private, no-store' },
  });
});
