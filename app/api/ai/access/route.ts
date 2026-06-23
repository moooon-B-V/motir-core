import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { billingService } from '@/lib/services/billingService';
import type { AiAccessDTO } from '@/lib/dto/aiAccess';

// GET /api/ai/access — the member-safe AI entitlement the 8.1.8 paywall reads to
// decide whether (and which variant) to show at the AI entry points (chat / plan
// / Draft-with-AI). HTTP-only (CLAUDE.md § 4-layer): session-gate, resolve the
// active project, call ONE billingService method.
//
// It DEGRADES to "not applicable" rather than erroring, by design: a paywall is
// an upsell, not a gate on its own — a 401, a missing active project, a non-member
// org, or a transient motir-ai outage must NEVER flash a false "AI is blocked"
// state. The authoritative block is always the boundary's own out-of-credits
// refusal (the reactive paywall), which this proactive read only anticipates.
const NOT_APPLICABLE: AiAccessDTO = {
  applicable: false,
  organizationId: null,
  organizationName: null,
  canManageBilling: false,
  hasPaidAiPlan: false,
  balance: 0,
  tierName: null,
  tierAllotment: null,
  renewsAt: null,
};

export async function GET(): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json(NOT_APPLICABLE);

  const ctx = await getActiveProject();
  if (!ctx) return NextResponse.json(NOT_APPLICABLE);

  try {
    const access = await billingService.getAiAccessForContext({
      actorUserId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return NextResponse.json(access);
  } catch {
    // A non-member org, a boundary outage, or any resolution failure → render no
    // paywall (the reactive out-of-credits path still catches a real block).
    return NextResponse.json(NOT_APPLICABLE);
  }
}
