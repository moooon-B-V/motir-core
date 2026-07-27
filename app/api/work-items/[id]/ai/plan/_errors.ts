import { NextResponse } from 'next/server';

import { mapPlanChangeError } from '@/app/api/ai/plan-change/_errors';
import { TooManyPlanChangeTargetsError } from '@/lib/planChange/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';

// Typed-error → HTTP mapping for the contextual-planning routes (7.12.3 ·
// MOTIR-909). It DELEGATES to the shipped plan-change mapping rather than
// restating it — submit / append / access / metered-AI errors must translate
// identically whether the conversation is anchored at the project or at a work
// item — and adds only what is specific to an ANCHORED turn.
//
// Returns null for an unrecognized error so the route rethrows (a 500).
export function mapContextualPlanError(err: unknown): NextResponse | null {
  // An anchor that does not resolve IN THIS TENANT is 404, never 403 — the
  // cross-tenant posture every work-item read takes (no existence leak). This is
  // also what an anchor from another project surfaces as: adopting it would plan
  // against the wrong tree, so it is treated as absent.
  if (err instanceof WorkItemNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  // Too many anchors is a malformed request, not a state conflict: the same body
  // will never succeed on retry.
  if (err instanceof TooManyPlanChangeTargetsError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
  }
  return mapPlanChangeError(err);
}

export { noActiveProject } from '@/app/api/ai/plan-change/_errors';
