import { NextResponse } from 'next/server';
import { getLocale } from 'next-intl/server';
import { getActiveProject } from '@/lib/projects';
import { workItemsService } from '@/lib/services/workItemsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import type { Locale } from '@/lib/i18n/locales';

// GET /api/issues/peek?key=<identifier> (bug 8.8.2) — the data half of the
// quick-view (peek) modal, fetched CLIENT-side by IssueQuickViewController so the
// modal frame + skeleton render INSTANTLY (URL-driven by `?peek`) and the fields
// stream in over the wire, instead of the peek being server-rendered behind the
// host page's blocking data reads (the open-lag the bug fixes). Resolves the
// peek against the actor's ACTIVE project (the cookie — the peek only ever opens
// over /issues, /ready, /boards, all active-project-scoped surfaces).
//
// Thin HTTP layer over `workItemsService.getQuickView` (which reuses the detail
// aggregate read + its workspace gate + `assertCanBrowse`, then shapes the
// condensed payload). No `db` / no `$transaction` here (CLAUDE.md 4-layer rule).
//
// A stale / deleted / cross-workspace / forbidden key is the same 404 (the
// no-existence-leak contract) — the controller renders it as the not-found
// panel. Never a 403 (would leak "it exists but you can't see it").
export async function GET(req: Request): Promise<Response> {
  const ctx = await getActiveProject();
  if (!ctx) {
    return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
  }

  const key = new URL(req.url).searchParams.get('key')?.trim();
  if (!key) {
    return NextResponse.json({ code: 'BAD_REQUEST', error: '`key` is required.' }, { status: 400 });
  }

  const locale = (await getLocale()) as Locale;

  try {
    const data = await workItemsService.getQuickView(
      ctx.projectId,
      key,
      ctx.project.accessLevel,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      locale,
    );
    return NextResponse.json(data, {
      // The peek mirrors live item state (status / readiness change often);
      // never serve a stale card.
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (err) {
    if (
      err instanceof WorkItemNotFoundError ||
      err instanceof ProjectAccessDeniedError ||
      err instanceof ProjectNotFoundError
    ) {
      return NextResponse.json(
        { code: 'NOT_FOUND', error: 'Work item not available.' },
        {
          status: 404,
        },
      );
    }
    throw err;
  }
}
