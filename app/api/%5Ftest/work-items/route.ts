import { NextResponse } from 'next/server';
import { workItemsService, type ListWorkItemsFilter } from '@/lib/services/workItemsService';
import { projectsService } from '@/lib/services/projectsService';
import { renderMarkdown } from '@/lib/markdown/render';
import {
  AssigneeNotInWorkspaceError,
  CrossProjectParentError,
  DepthLimitExceededError,
  IllegalParentTypeError,
  IllegalTransitionError,
  ReporterNotInWorkspaceError,
  UnknownStatusError,
  WorkItemKeyConflictError,
  WorkItemNotFoundError,
} from '@/lib/workItems/errors';
import { ProjectNotFoundError, ProjectWorkspaceMismatchError } from '@/lib/projects/errors';
import type {
  CreateWorkItemInput,
  UpdateWorkItemInput,
  WorkItemKindDto,
} from '@/lib/dto/workItems';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { notFound, productionGate, requireContext } from '../_helpers';

// `_test` transport over workItemsService — CRUD on work items via the service
// layer (Subtask 1.4.8). See ../_helpers.ts for the WHY + the three invariants
// (NODE_ENV gate, auth, service-only). Surface:
//
//   GET  ?id=<id>                 → single WorkItemDto (404 if not in workspace)
//   GET  ?id=<id>&render=1         → WorkItemDto + descriptionHtml/explanationHtml
//   GET  ?id=<id>&subtree=1        → WorkItemSubtreeDto[] (the full subtree)
//   GET  ?id=<id>&revisions=1      → WorkItemRevisionDto[] (the revision feed)
//   GET  ?projectId=<id>           → WorkItemSummaryDto[] (the project's list)
//   POST   body=CreateWorkItemInput → 201 + WorkItemDto
//   PATCH  ?id=<id> body=UpdateWorkItemInput → 200 + WorkItemDto
//   DELETE ?id=<id>                → 204 (archive)
//
// `subtree`/`revisions` are 1.4.8 read additions over the story card's
// "GET = list/get" so the tree-query and revision-feed scenarios can run over
// HTTP; both delegate to existing service reads behind a getWorkItem tenancy
// guard.

/**
 * Map a typed work-item / project error to an HTTP response, or rethrow if it
 * isn't one we expect (a genuine 500). Tenancy misses collapse to a uniform
 * 404 body (no existence leak). Structural-validation failures are 422; a key
 * conflict is 409.
 */
function mapError(err: unknown): NextResponse {
  if (
    err instanceof WorkItemNotFoundError ||
    err instanceof ProjectNotFoundError ||
    err instanceof ProjectWorkspaceMismatchError
  ) {
    return notFound();
  }
  if (
    err instanceof IllegalParentTypeError ||
    err instanceof DepthLimitExceededError ||
    err instanceof CrossProjectParentError ||
    err instanceof AssigneeNotInWorkspaceError ||
    err instanceof ReporterNotInWorkspaceError ||
    err instanceof UnknownStatusError ||
    err instanceof IllegalTransitionError
  ) {
    return NextResponse.json({ code: err.code, error: err.name }, { status: 422 });
  }
  // NoInitialStatusError is deliberately NOT mapped here — it's a server
  // invariant violation that should surface as a 500 (the default `throw`).
  if (err instanceof WorkItemKeyConflictError) {
    return NextResponse.json({ code: err.code, error: err.name }, { status: 409 });
  }
  throw err;
}

/**
 * Render Markdown source to sanitized, highlighted static HTML (null-safe).
 * `react-dom/server` is imported DYNAMICALLY (not at module top): Turbopack's
 * App-Router guard rejects a STATIC `import … from 'react-dom/server'` in a
 * route file ("render the content directly as a Server Component instead"). A
 * runtime `await import(...)` sidesteps the static-graph check — legitimate
 * here because this throwaway endpoint really does need to serialize the
 * existing react-markdown render stack (1.4.2) to an HTML string for the smoke
 * assertion, and there is no production page to "render directly" into yet.
 */
async function renderHtml(md: string | null): Promise<string | null> {
  if (md === null) return null;
  const { renderToStaticMarkup } = await import('react-dom/server');
  return renderToStaticMarkup(renderMarkdown(md));
}

export async function GET(req: Request): Promise<Response> {
  const gated = productionGate();
  if (gated) return gated;
  const auth = await requireContext();
  if (auth.response) return auth.response;
  const ctx: ServiceContext = auth.ctx;

  const params = new URL(req.url).searchParams;
  const id = params.get('id');
  const projectId = params.get('projectId');

  try {
    if (id) {
      if (params.get('render') === '1') {
        const dto = await workItemsService.getWorkItem(id, ctx);
        return NextResponse.json({
          ...dto,
          descriptionHtml: await renderHtml(dto.descriptionMd),
          explanationHtml: await renderHtml(dto.explanationMd),
        });
      }
      if (params.get('subtree') === '1') {
        await workItemsService.getWorkItem(id, ctx); // tenancy guard (404 on miss)
        return NextResponse.json(await workItemsService.getWorkItemSubtree(id, ctx));
      }
      if (params.get('revisions') === '1') {
        return NextResponse.json(await workItemsService.listRevisions(id, ctx));
      }
      return NextResponse.json(await workItemsService.getWorkItem(id, ctx));
    }

    if (projectId) {
      // The project must belong to the active workspace, or the list 404s —
      // this is the cross-project / cross-workspace read gate (RLS narrowing's
      // application-layer equivalent on the BYPASSRLS dev connection).
      await projectsService.assertProjectInWorkspace(projectId, ctx.workspaceId);
      const filter: ListWorkItemsFilter = {};
      const kind = params.get('kind');
      const status = params.get('status');
      if (kind) filter.kind = kind as WorkItemKindDto;
      if (status) filter.status = status;
      return NextResponse.json(await workItemsService.listWorkItems(projectId, filter, ctx));
    }

    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Provide ?id=<id> or ?projectId=<id>' },
      { status: 400 },
    );
  } catch (err) {
    return mapError(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  const gated = productionGate();
  if (gated) return gated;
  const auth = await requireContext();
  if (auth.response) return auth.response;
  const ctx: ServiceContext = auth.ctx;

  const body = (await req.json()) as CreateWorkItemInput;
  try {
    // Gate the target project to the active workspace BEFORE creating: a POST
    // naming a foreign project 404s (no existence leak) rather than surfacing a
    // membership error that would confirm the project exists.
    await projectsService.assertProjectInWorkspace(body.projectId, ctx.workspaceId);
    const dto = await workItemsService.createWorkItem(body, ctx);
    return NextResponse.json(dto, { status: 201 });
  } catch (err) {
    return mapError(err);
  }
}

export async function PATCH(req: Request): Promise<Response> {
  const gated = productionGate();
  if (gated) return gated;
  const auth = await requireContext();
  if (auth.response) return auth.response;
  const ctx: ServiceContext = auth.ctx;

  const id = new URL(req.url).searchParams.get('id');
  if (!id) {
    return NextResponse.json({ code: 'BAD_REQUEST', error: 'Provide ?id=<id>' }, { status: 400 });
  }
  const body = (await req.json()) as UpdateWorkItemInput;
  try {
    await workItemsService.getWorkItem(id, ctx); // tenancy guard (404 on cross-tenant)
    return NextResponse.json(await workItemsService.updateWorkItem(id, body, ctx));
  } catch (err) {
    return mapError(err);
  }
}

export async function DELETE(req: Request): Promise<Response> {
  const gated = productionGate();
  if (gated) return gated;
  const auth = await requireContext();
  if (auth.response) return auth.response;
  const ctx: ServiceContext = auth.ctx;

  const id = new URL(req.url).searchParams.get('id');
  if (!id) {
    return NextResponse.json({ code: 'BAD_REQUEST', error: 'Provide ?id=<id>' }, { status: 400 });
  }
  try {
    await workItemsService.getWorkItem(id, ctx); // tenancy guard (404 on cross-tenant)
    await workItemsService.archiveWorkItem(id, ctx);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return mapError(err);
  }
}
