import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { encodeCollectionCursor, parseCollectionPageRequest } from '@/lib/api/v1/pagination';
import { presentApprovedDesign } from '@/lib/api/v1/workItems/designPresenter';
import { designAccessService } from '@/lib/services/designAccessService';

// GET /api/v1/projects/{projectKey}/designs (Story MOTIR-5553 · Subtask
// MOTIR-5560) — BROWSE a project's approved designs.
//
// AMENDMENT 5 Q6's *browsing further*: what an agent reaches for when the
// design it was handed is not the one it needs — most often to find the base a
// delta mock amends, by its repository path.
//
// ── APPROVED only, and that is the whole filter ────────────────────────────
// A design still under review is not something to build against, so it is not
// listed. The verdict rules are the service's; this route does not know them.
//
// ── NO DOWNLOAD LINKS, deliberately ────────────────────────────────────────
// A presign lives 300 seconds. Minting one per row means a page of twenty-five
// designs mints seventy-five links, every one of them already expiring while the
// caller reads the page, and almost none of them wanted. A caller that has found
// the design it wants asks `GET /api/v1/work-items/{key}/design` for it, and gets
// links that are fresh because they were minted when they were asked for.
//
// ── The CURSOR is the design card's key ────────────────────────────────────
// Stable under concurrent publishes, which a `publishedAt` cursor is not: a
// republish moves a card's newest result forward in time and would walk that card
// across page boundaries, showing it twice or not at all. The service owns that
// choice; the route passes the opaque value through.
export const GET = withV1Route<{ projectKey: string }>(
  { permission: 'project:browse' },
  async (ctx) => {
    const page = parseCollectionPageRequest(ctx.req, 'projectDesigns', readDesignKeyPosition);
    const url = new URL(ctx.req.url);
    const pathPrefix = url.searchParams.get('pathPrefix');
    const query = url.searchParams.get('query');

    const result = await designAccessService.listApprovedDesigns(
      ctx.params.projectKey,
      {
        limit: page.limit,
        ...(page.cursor !== undefined ? { cursor: String(page.cursor) } : {}),
        ...(pathPrefix ? { pathPrefix } : {}),
        ...(query ? { query } : {}),
      },
      ctx.service,
    );

    return NextResponse.json({
      items: result.designs.map(presentApprovedDesign),
      nextCursor:
        result.nextCursor !== null
          ? encodeCollectionCursor('projectDesigns', Number(result.nextCursor))
          : null,
    });
  },
);

/**
 * The cursor's position: a design card's `key` number.
 *
 * Validated here rather than trusted, exactly as every other collection's
 * reader validates its own: a signed cursor proves WE issued it, not that its
 * payload still means what this route expects.
 */
function readDesignKeyPosition(position: unknown): number | undefined {
  return typeof position === 'number' && Number.isInteger(position) && position > 0
    ? position
    : undefined;
}
