import { NextResponse } from 'next/server';
import type { DispatchRunStatus } from '@/generated/prisma/client';
import { requireCompliantWorkspaceContext } from '@/lib/auth/requireCompliantSession';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  DISPATCH_RUN_LIST_DEFAULT_TAKE,
  DISPATCH_RUN_LIST_MAX_TAKE,
  DISPATCH_RUN_LIVE_STATUSES,
  DISPATCH_RUN_PAST_STATUSES,
  dispatchRunService,
} from '@/lib/services/dispatchRunService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';

// GET /api/projects/[key]/dispatch-runs (Story MOTIR-1789 · MOTIR-3922) — the
// project's RUN HISTORY: every run it has made, current and past, newest first,
// cursor-paginated. The read the RUNS INDEX at `/runs` stands on.
//
// ⚠️ IT IS THE ONLY READ THAT STARTS FROM THE PROJECT. The three shipped beside
// it — one run by id, one card's runs, and the project's LIVE runs — each start
// from something the caller already holds, so a run that finished last night
// could not be found at all. That is the gap this route closes, and it is why
// the surface it feeds gets a primary-nav row rather than a link from somewhere.
//
// Cursor-paginated, and unlike the `active` sibling it has to be: run headers
// are append-only and nothing deletes them (the retention sweep clears event
// BODIES, not rows), so this population grows for as long as the project lives.
//
// Rows carry each run's set as COUNTS rather than as legs — see
// `DispatchRunListItemDto`. A list that grows without bound must not make every
// reader pay for a run view nobody opened.

/** One page. Bounded so a caller cannot ask for the whole history at once. */
const DEFAULT_TAKE = DISPATCH_RUN_LIST_DEFAULT_TAKE;
const MAX_TAKE = DISPATCH_RUN_LIST_MAX_TAKE;

/**
 * `?status=` — `live`, `past`, or a comma-separated list of raw statuses.
 *
 * The two words are the ones the index actually renders, and they resolve
 * through the service's single `RUN_IS_LIVE` partition rather than being spelled
 * out here: a second definition of *live* is exactly how two surfaces end up
 * disagreeing about whether a run is still going.
 *
 * Returns `null` for "no narrowing", or `false` for a value that is neither —
 * which is a 400 rather than a silent full list, because a client that
 * mistypes a status and gets everything back has been told its filter worked.
 */
function parseStatuses(raw: string | null): DispatchRunStatus[] | null | false {
  if (raw === null || raw.trim() === '') return null;
  const value = raw.trim().toLowerCase();
  if (value === 'live') return DISPATCH_RUN_LIVE_STATUSES;
  if (value === 'past') return DISPATCH_RUN_PAST_STATUSES;

  const known = new Set<string>([...DISPATCH_RUN_LIVE_STATUSES, ...DISPATCH_RUN_PAST_STATUSES]);
  const asked = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (asked.length === 0 || asked.some((s) => !known.has(s))) return false;
  return asked as DispatchRunStatus[];
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const gate = await requireCompliantWorkspaceContext();
  if (!gate.ok) return gate.response;

  const { key } = await params;
  const url = new URL(req.url);

  const statuses = parseStatuses(url.searchParams.get('status'));
  if (statuses === false) {
    return NextResponse.json(
      {
        code: 'BAD_REQUEST',
        error: '`status` must be `live`, `past`, or a comma-separated list of run statuses.',
      },
      { status: 400 },
    );
  }

  const rawTake = Number(url.searchParams.get('limit'));
  const take = Number.isFinite(rawTake) && rawTake > 0 ? Math.min(rawTake, MAX_TAKE) : DEFAULT_TAKE;
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const scope = url.searchParams.get('scope') ?? undefined;

  try {
    const runs = await dispatchRunService.listRunsForProject(
      key,
      {
        take,
        ...(cursor ? { cursor } : {}),
        ...(statuses ? { statuses } : {}),
        ...(scope ? { scopeWorkItemKey: scope } : {}),
      },
      gate.ctx,
    );
    // The cursor is the LAST row's id, or null when this page is the last one —
    // the same shape every other cursor-paginated read in the product answers.
    return NextResponse.json({
      runs,
      nextCursor: runs.length === take ? (runs[runs.length - 1]?.id ?? null) : null,
    });
  } catch (err) {
    if (err instanceof ProjectNotFoundError || err instanceof WorkItemNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
}
