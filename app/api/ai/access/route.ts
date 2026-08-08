import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { billingService } from '@/lib/services/billingService';
import { projectAccessService } from '@/lib/services/projectAccessService';
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
    // `project:browse`, NOT `ai:plan` (Story MOTIR-2291 · Subtask MOTIR-2358).
    // This is the PROBE the UI uses to decide whether to offer a planning
    // affordance at all. Gating it on `ai:plan` would mean an actor who may not
    // plan cannot even discover that planning exists, pushing the discovery into
    // a failed write; gating it on browse keeps the answer readable while the ACT
    // stays refused by the four cards that gate the acts.
    //
    // The assert is in the ROUTE rather than the service on purpose:
    // `getAiAccessForContext` is WORKSPACE-scoped billing (it takes no project),
    // and the project is the route's own context. A refusal falls into the catch
    // below and renders NOT_APPLICABLE, which preserves the degrade-never-error
    // contract this endpoint is built on.
    await projectAccessService.assertPermission(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      'project:browse',
    );
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
