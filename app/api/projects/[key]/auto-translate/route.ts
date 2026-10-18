import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { projectErrorResponse } from '@/lib/projects/projectErrorResponse';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectAutoTranslateSettingsService } from '@/lib/services/projectAutoTranslateSettingsService';
import { projectsService } from '@/lib/services/projectsService';

// GET / PATCH /api/projects/[key]/auto-translate (Story MOTIR-7738 · Subtask
// MOTIR-8827) — read or flip a project's "Auto-translate work content" switch.
//
// The project is addressed by its workspace-unique `key`, resolved through
// `projectsService.getByKey`. Thin HTTP transport per CLAUDE.md: resolve, one
// service call, map typed errors.
//
// The two verbs take DIFFERENT permissions, on purpose:
//   GET   — `project:browse`. A member who cannot change the switch still sees its
//           state (the Settings room renders the control read-only for them), so
//           this is NOT the `approval-gates` route's manage-only read. The gate is
//           asserted here, not merely implied by the absence of a stronger one.
//   PATCH — `project:administer`, asserted in the SERVICE: this route is reachable
//           by URL whether or not the rail offers its row.
//
// A caller who cannot browse the project is thrown `ProjectNotFoundError` FIRST
// (404), on both verbs, so a refusal never confirms a project the actor may not see.
//
// Typed errors → status codes (via `projectErrorResponse`):
//   ProjectNotFoundError  → 404  (no such project, or not a browser)
//   NotProjectAdminError  → 403  (PATCH — lacks `project:administer`)
// Body-shape failures (not JSON / not an object / key absent / not a boolean) are
// a 400 here and never reach the service.

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
    const dto = await projectAutoTranslateSettingsService.getSettings(project.id, ctx);
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
  const value = (body as Record<string, unknown>).autoTranslateWorkContent;
  if (typeof value !== 'boolean') {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`autoTranslateWorkContent` must be a boolean.' },
      { status: 400 },
    );
  }

  try {
    const project = await projectsService.getByKey(key, ctx);
    await projectAccessService.assertCanBrowse(project.id, ctx);
    const dto = await projectAutoTranslateSettingsService.updateSettings(
      project.id,
      { autoTranslateWorkContent: value },
      ctx,
    );
    return NextResponse.json(dto);
  } catch (err) {
    const mapped = projectErrorResponse(err);
    if (mapped) return mapped;
    throw err;
  }
}
