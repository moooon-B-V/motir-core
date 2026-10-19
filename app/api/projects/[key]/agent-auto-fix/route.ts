import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { projectErrorResponse } from '@/lib/projects/projectErrorResponse';
import { projectAgentAutoFixSettingsService } from '@/lib/services/projectAgentAutoFixSettingsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';

// GET / PATCH /api/projects/[key]/agent-auto-fix (Story MOTIR-8981 · MOTIR-9060) —
// read or flip a project's "fix a red pull request in the card's own agent" switch.
//
// The two verbs take the Hosted agent room's two keys, asserted in the SERVICE:
//   GET   — `work_item:edit`  (403 for a browser without it)
//   PATCH — `ai:configure`    (403 for a browser without it)
// A caller who cannot browse the project is thrown `ProjectNotFoundError` FIRST
// (404), on both verbs, so a refusal never confirms a project the actor may not see.
// Body-shape failures (not JSON / not an object / key absent / not a boolean) are a
// 400 here and never reach the service.

interface RouteParams {
  params: Promise<{ key: string }>;
}

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;
  const { key } = await params;

  try {
    const project = await projectsService.getByKey(key, ctx);
    await projectAccessService.assertCanBrowse(project.id, ctx);
    const dto = await projectAgentAutoFixSettingsService.getSettings(project.id, ctx);
    return NextResponse.json(dto, { headers: NO_STORE });
  } catch (err) {
    const mapped = projectErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;
  const { ctx } = gate;
  const { key } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  // A SHAPE question the transport can answer; authority and meaning are the service's.
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a JSON object body.' },
      { status: 400 },
    );
  }
  const value = (body as Record<string, unknown>).agentAutoFixEnabled;
  if (typeof value !== 'boolean') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`agentAutoFixEnabled` must be a boolean.' },
      { status: 400 },
    );
  }

  try {
    const project = await projectsService.getByKey(key, ctx);
    await projectAccessService.assertCanBrowse(project.id, ctx);
    const dto = await projectAgentAutoFixSettingsService.updateSettings(
      project.id,
      { agentAutoFixEnabled: value },
      ctx,
    );
    return NextResponse.json(dto);
  } catch (err) {
    const mapped = projectErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
