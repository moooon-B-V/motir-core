import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { hostedRunModelService } from '@/lib/services/hostedRunModelService';

// GET /api/hosted-runs/models (MOTIR-6483) — the models the Run hosted picker
// offers, and the one it preselects (`docs/decisions/hosted-agent-run.md` §7).
//
// Thin HTTP layer (CLAUDE.md 4-layer): the compliant-session gate (401 signed
// out), ONE service call, and the answer. Any signed-in member of a workspace may
// read it: the list is one list for everyone, and it carries no tenant data.
//
// ⚠️ UNAVAILABLE IS A 503 WITH A STABLE CODE, NEVER A 200 WITH AN EMPTY LIST.
// The picker disables Run hosted and says why on this code; an empty list would
// tell the person no model exists while motir-ai is merely unreachable.
export async function GET(): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;

  const offered = await hostedRunModelService.listOfferedModels();
  if (offered.state === 'unavailable') {
    return NextResponse.json(
      {
        code: 'hosted_models_unavailable',
        error: 'The models a hosted run may use could not be read. Try again shortly.',
      },
      { status: 503, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
  return NextResponse.json(
    { models: offered.models, default: offered.default },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
