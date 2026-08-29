import { NextResponse } from 'next/server';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';

// GET /api/work-items/[key]/dispatch-runs (Story MOTIR-1789 · MOTIR-1793) — one
// card's RUN HISTORY, newest first, cursor-paginated.
//
// ⚠️ "EVERY RUN THAT CARRIED A LEG FOR THIS CARD", not every run that NAMED it.
// That is the correct question now a run covers a set: the sprint run that swept
// a card up is exactly the run its owner goes looking for, and it never named
// the card at all.
//
// ⚠️ AND THERE IS NO SECOND "CURRENT RUN" ENDPOINT, deliberately. The order is
// newest-first, so the item page's run section reads the current run off the
// first row of the first page — a second endpoint would be a second definition
// of *current* to keep in step with this one.
//
// Cursor-paginated because run history is UNBOUNDED: a card worked by `motir
// auto` every night accumulates a run per night for as long as the project lives.

/** One page. Bounded so a caller cannot ask for the whole history at once. */
const DEFAULT_TAKE = 20;
const MAX_TAKE = 100;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;

  const { key } = await params;
  const url = new URL(req.url);
  const rawTake = Number(url.searchParams.get('limit'));
  const take = Number.isFinite(rawTake) && rawTake > 0 ? Math.min(rawTake, MAX_TAKE) : DEFAULT_TAKE;
  const cursor = url.searchParams.get('cursor') ?? undefined;

  try {
    const runs = await dispatchRunService.listRunsForWorkItemKey(
      key,
      { take, ...(cursor ? { cursor } : {}) },
      gate.ctx,
    );
    // The cursor is the LAST row's id, or null when this page is the last one —
    // the same shape every other cursor-paginated read in the product answers.
    return NextResponse.json({
      runs,
      nextCursor: runs.length === take ? (runs[runs.length - 1]?.id ?? null) : null,
    });
  } catch (err) {
    if (err instanceof WorkItemNotFoundError || err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
