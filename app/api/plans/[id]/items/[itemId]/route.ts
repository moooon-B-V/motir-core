import { NextResponse } from 'next/server';

import { getWorkspaceContext } from '@/lib/workspaces';
import { plansService } from '@/lib/services/plansService';
import {
  InvalidProposalError,
  PlanItemNotFoundError,
  PlanNotFoundError,
  PlanNotInExpectedStatusError,
} from '@/lib/plans/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import type { UpdateProposalInput } from '@/lib/dto/plans';

// PATCH /api/plans/[id]/items/[itemId] — edit a proposed `add` of a `planned`
// plan (Subtask 7.21.6 / MOTIR-1370, calling the MOTIR-1336 substrate). Patches
// the add's proposed fields (title/kind/priority/type/description + leaf sizing
// storyPoints/estimateMinutes, MOTIR-1433) in place — NO WorkItem until approve.
// Only an `add` is editable; the plan must be `planned`.
//
// HTTP only (CLAUDE.md 4-layer): resolve the workspace, parse the body, call ONE
// service method, map typed errors. `updateProposal` asserts `canEdit` (→ 403/404).
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; itemId: string }> },
): Promise<Response> {
  const ctx = await getWorkspaceContext();
  if (!ctx) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const { id, itemId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ code: 'INVALID_BODY' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ code: 'INVALID_BODY' }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  // Pick ONLY the editable fields (the service merges sparsely; an absent key is
  // left untouched). Unknown keys are ignored, not an error. Leaf sizing
  // (MOTIR-1433): storyPoints/estimateMinutes are numbers — a present-but-
  // non-number value (other than the explicit clear) becomes `null`, and the
  // service re-validates the merged values (Fibonacci range / non-negative int).
  const input: UpdateProposalInput = {
    ...(typeof b.title === 'string' ? { title: b.title } : {}),
    ...(typeof b.kind === 'string' ? { kind: b.kind } : {}),
    ...('descriptionMd' in b
      ? { descriptionMd: typeof b.descriptionMd === 'string' ? b.descriptionMd : null }
      : {}),
    ...('type' in b ? { type: typeof b.type === 'string' ? b.type : null } : {}),
    ...('priority' in b ? { priority: typeof b.priority === 'string' ? b.priority : null } : {}),
    ...('storyPoints' in b
      ? { storyPoints: typeof b.storyPoints === 'number' ? b.storyPoints : null }
      : {}),
    ...('estimateMinutes' in b
      ? { estimateMinutes: typeof b.estimateMinutes === 'number' ? b.estimateMinutes : null }
      : {}),
  };

  try {
    const plan = await plansService.updateProposal(id, itemId, input, ctx);
    return NextResponse.json(plan);
  } catch (err) {
    if (err instanceof PlanNotFoundError || err instanceof PlanItemNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof PlanNotInExpectedStatusError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
    }
    if (err instanceof InvalidProposalError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 422 });
    }
    if (err instanceof ProjectAccessDeniedError) {
      return NextResponse.json(
        { code: err.code, error: err.message },
        { status: err.kind === 'browse' ? 404 : 403 },
      );
    }
    throw err;
  }
}
