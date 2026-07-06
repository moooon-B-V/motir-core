import { NextResponse } from 'next/server';
import { authenticateApiToken } from '@/lib/apiTokens/routeAuth';
import { authenticateGithubOidc } from '@/lib/github/oidcAuth';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { projectsService } from '@/lib/services/projectsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { acceptanceEvidenceService } from '@/lib/services/acceptanceEvidenceService';
import { acceptanceVideoEligibilityService } from '@/lib/services/acceptanceVideoEligibilityService';
import { AcceptanceEvidenceError } from '@/lib/acceptanceEvidence/errors';
import { AttachmentError } from '@/lib/blob/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import type { AcceptanceEvidenceChapterDTO } from '@/lib/dto/acceptanceEvidence';

// POST /api/work-items/[key]/acceptance-evidence (Story MOTIR-1627 · Subtask
// MOTIR-1631) — the CI/BYOK publish seam: a green E2E's video is attached to the
// STORY as PENDING acceptance evidence. UNLIKE the session-gated attachment
// route, this is authed by an `integration`-scoped API token (the ADR's choice),
// so a user's own CI can call it. Thin HTTP layer (CLAUDE.md § 4-layer): auth →
// resolve story → eligibility gate → one service call.
//
// Multipart body: `video` (File, required), `trace` (File, optional), and text
// fields `chapters` (JSON `[{label,tSeconds}]`), `commitSha`, `ciRunUrl`,
// `producedByKey`. The story is left in `in_review` — the endpoint never
// advances the gate (a human Approves).

/** Derive the owning project key from a `MOTIR-7`-style identifier. */
function projectKeyOf(identifier: string): string {
  const dash = identifier.lastIndexOf('-');
  return dash > 0 ? identifier.slice(0, dash) : identifier;
}

function parseChapters(raw: FormDataEntryValue | null): AcceptanceEvidenceChapterDTO[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((e) =>
      e && typeof e.label === 'string' && typeof e.tSeconds === 'number'
        ? [{ label: e.label, tSeconds: e.tSeconds }]
        : [],
    );
  } catch {
    return [];
  }
}

const strField = (raw: FormDataEntryValue | null): string | null =>
  typeof raw === 'string' && raw.trim() !== '' ? raw : null;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  // Auth: keyless GitHub OIDC first (MOTIR-1650) when the caller opts in via the
  // `X-Motir-Auth: github-oidc` marker; otherwise the `integration` PAT
  // (MOTIR-1631). Both resolve the `{ userId, workspaceId }` the publish consumes
  // — for OIDC, `userId` is the workspace owner (OIDC carries no user).
  let ctx: { userId: string; workspaceId: string };
  const oidc = await authenticateGithubOidc(req);
  if (oidc) {
    if (!oidc.ok) {
      return oidc.status === 401
        ? NextResponse.json({ code: 'UNAUTHENTICATED', reason: oidc.reason }, { status: 401 })
        : NextResponse.json({ code: 'FORBIDDEN', reason: oidc.reason }, { status: 403 });
    }
    ctx = { userId: oidc.userId, workspaceId: oidc.workspaceId };
  } else {
    const auth = await authenticateApiToken(req, 'integration');
    if (!auth.ok) {
      return auth.reason === 'unauthenticated'
        ? NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 })
        : NextResponse.json(
            { code: 'FORBIDDEN', error: 'The token lacks the integration scope.' },
            { status: 403 },
          );
    }
    ctx = { userId: auth.userId, workspaceId: auth.workspaceId };
  }

  const { key } = await params;
  const identifier = key.trim().toUpperCase();

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: 'Expected a multipart form body.' },
      { status: 400 },
    );
  }
  const video = form.get('video');
  if (!(video instanceof File)) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`video` file is required.' },
      { status: 400 },
    );
  }
  const traceEntry = form.get('trace');
  const trace = traceEntry instanceof File ? traceEntry : null;

  try {
    // Resolve the story within the token's workspace (404, never 403, on a
    // hidden / cross-workspace / missing item).
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    const story = await withWorkspaceContext(ctx, (tx) =>
      workItemRepository.findByIdentifier(project.id, identifier, tx),
    );
    if (!story) {
      return NextResponse.json(
        { code: 'WORK_ITEM_NOT_FOUND', error: `${identifier} was not found.` },
        { status: 404 },
      );
    }

    // Eligibility gate (MOTIR-1630) — reject with the reason BEFORE any blob
    // spend. not_applicable (self-host / meta) is eligible (ungated).
    const eligibility = await acceptanceVideoEligibilityService.resolve({
      actorUserId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    if (!eligibility.eligible) {
      const status = eligibility.reason === 'no_plan' ? 402 : 403;
      return NextResponse.json(
        { code: 'ACCEPTANCE_VIDEO_INELIGIBLE', reason: eligibility.reason },
        { status },
      );
    }

    const evidence = await acceptanceEvidenceService.recordFromUpload(
      {
        workItemId: story.id,
        video,
        trace,
        chapters: parseChapters(form.get('chapters')),
        commitSha: strField(form.get('commitSha')),
        ciRunUrl: strField(form.get('ciRunUrl')),
        producedByKey: strField(form.get('producedByKey')),
      },
      ctx,
    );
    return NextResponse.json({ evidence }, { status: 201 });
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    if (err instanceof AcceptanceEvidenceError || err instanceof AttachmentError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: err.status });
    }
    throw err;
  }
}
