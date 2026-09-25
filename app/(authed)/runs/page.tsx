import { Suspense } from 'react';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ChevronLeft, SearchX } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import { getSession } from '@/lib/auth';
import type { DispatchRunScopeDto } from '@/lib/dto/dispatchRuns';
import { getActiveProject } from '@/lib/projects';
import {
  RUNS_RUN_PARAM,
  RUNS_SCOPE_PARAM,
  RUNS_VIEW_PARAM,
  parseRunsScope,
  runsHref,
} from '@/lib/runs/runsAddress';
import { parseRoomView, resolveRoomView, type RoomView } from '@/lib/rooms/roomView';
import { RoomViewSwitch } from '@/components/rooms/RoomViewSwitch';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { DISPATCH_RUN_LIVE_STATUSES, DISPATCH_RUN_PAST_STATUSES } from '@/lib/runs/timeline';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { RunsIndex } from './_components/RunsIndex';
import { RunsIndexSkeleton } from './_components/RunsIndexSkeleton';

// THE RUNS INDEX (Story MOTIR-1789 · MOTIR-3923) — every run this project has
// made, current and past. The surface that makes a run FINDABLE at all: before
// it, every door into a run started from something the reader already held.
//
// Renders `design/runs/runs-index.mock.html`. A Server Component that resolves
// the active project the established way (`getActiveProject`, as /ready and
// /items do) and reads `dispatchRunService` DIRECTLY — the server-component
// 4-layer path. `GET /api/projects/[key]/dispatch-runs` is the CLIENT's read for
// paging and polling, not this page's first paint.
//
// ⚠️ TWO HEADED SECTIONS, NOT A SWITCH — `design-notes.md` § `/runs`. A person
// arrives asking one of exactly two questions, *what is happening right now* or
// *what happened*, and the two are read differently: the first is watched, the
// second is searched. Two sections answer both without a click and without
// hiding either. The card that planned this specified a `Segmented` switch; the
// design merged after it and overrules it, and the card is amended on the record.
//
// ⚠️ AND NO `loading.tsx` HERE. `design/shell/design-notes.md` § the
// navigation-pending grammar settles it for the whole group: every page's frame
// is its own in-page <Suspense>, placed AFTER the page's own gate, and no
// `loading.tsx` is added under `app/(authed)` at all. The boundary below sits
// after the session + project gates for exactly that reason.
//
// ⚠️ `?scope=<KEY>` NARROWS THIS SAME PAGE — it is not a second page (Story
// MOTIR-5363 · design MOTIR-5402, `design/runs/run-scope.mock.html` panels 4–9).
// Both sections stay, both reads are narrowed by the QUERY, and the header names
// the scope. Entering or leaving a narrowing changes both server reads, so it is
// a real navigation (a link); opening a run over it is not (`RunsIndex`).

/** One page of past runs — the read's own default, and the design's number. */
const PAGE = 25;

/**
 * What the header knows about a `?scope=` key, before the list renders.
 *
 * Three answers and they are different faces: the key RESOLVED (the header names
 * it), it resolves to NOTHING (panel 7 — distinct from empty, because *has no
 * runs* and *is not yours* are opposite facts), or the header read itself FAILED
 * (the key stays plain text, and the list's own reads show their failed face).
 */
type ScopeHeader =
  | { state: 'found'; scope: DispatchRunScopeDto }
  | { state: 'missing' }
  | { state: 'unread' };

export default async function RunsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('runs');
  const ctx = await getActiveProject();
  // UNREACHABLE for a signed-in reader (MOTIR-4870 seeds a default project at
  // the WORKSPACE tier). The guard stays because the type does — the only null
  // left is a session-less request — and it redirects rather than rendering.
  if (!ctx) redirect('/sign-in');

  const projectKey = ctx.project.identifier;
  const wsCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const params = (await searchParams) ?? {};
  const scopeKey = parseRunsScope(params[RUNS_SCOPE_PARAM]);

  // THE VIEW (Story MOTIR-6179 · MOTIR-6335, design MOTIR-6327
  // `runs-index--view-tabs.mock.html`): WHOSE runs — a different axis from
  // `?scope=` (WHICH work item's). Project on `run:view_any`, Mine on starting a
  // run; both ⇒ the switch, one ⇒ that view alone, none ⇒ not-found. The two
  // headed sections stay, and the switch filters both.
  const access = await dispatchRunService.roomAccess(projectKey, wsCtx);
  if (access.views.length === 0) notFound();
  const view: RoomView =
    (await resolveRoomView({
      requested: parseRoomView(params[RUNS_VIEW_PARAM]),
      available: access.views,
      mineHasRows: async () =>
        (
          await dispatchRunService.listRunsForProject(
            projectKey,
            { take: 1, view: 'mine', ...(scopeKey ? { scopeWorkItemKey: scopeKey } : {}) },
            wsCtx,
          )
        ).runs.length > 0,
    }).catch(() => null)) ?? access.views[0]!;
  const hasSwitch = access.views.length > 1;
  // A switch keeps `scope` and drops `run` — the modal covers the page, so an
  // open run is never under the switch anyway.
  const viewSwitch = hasSwitch ? (
    <RoomViewSwitch value={view} label={t('viewAria')} drop={[RUNS_RUN_PARAM]} />
  ) : null;
  const indexData = (
    <RunsIndexData
      projectKey={projectKey}
      ctx={wsCtx}
      scopeKey={scopeKey}
      view={view}
      viewInUrl={hasSwitch}
      canRun={access.canRun}
    />
  );

  if (!scopeKey) {
    return (
      <div className="flex flex-col gap-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="font-serif text-2xl font-semibold text-(--el-text)">
              {t('indexHeading')}
            </h1>
            <p className="text-sm text-(--el-text-secondary)">
              {view === 'mine'
                ? t('indexSubtitleMine', { project: ctx.project.name })
                : t('indexSubtitle', { project: ctx.project.name })}
            </p>
          </div>
          {viewSwitch}
        </header>
        <Suspense fallback={<RunsIndexSkeleton />}>{indexData}</Suspense>
      </div>
    );
  }

  // The header's read — the design's one new read — is made only on a narrowed
  // address, and only once: the list's poll and paging never ask for it again.
  const header = await readScopeHeader(projectKey, scopeKey, wsCtx);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <Link
            href={runsHref({ view: hasSwitch ? view : null })}
            className="inline-flex items-center gap-1 self-start text-sm text-(--el-link)"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
            {t('scopeIndex.allRuns')}
          </Link>
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">
            {t('indexHeading')}
          </h1>
          <p className="flex flex-wrap items-center gap-x-2 text-sm text-(--el-text-secondary)">
            {header.state === 'found' ? (
              <>
                <span>
                  {t.rich('scopeIndex.subtitle', {
                    key: header.scope.key,
                    title: header.scope.title,
                    item: (chunks) => (
                      <Link
                        href={`/items/${encodeURIComponent(header.scope.key)}`}
                        className="text-(--el-link) underline"
                      >
                        {chunks}
                      </Link>
                    ),
                  })}
                </span>
                {header.scope.archived ? (
                  <Pill tone="neutral">{t('scopeIndex.archived')}</Pill>
                ) : null}
              </>
            ) : (
              // Unresolved or unread: the key is PLAIN TEXT — there is nothing
              // (known) for it to open.
              <span>{t('scopeIndex.subtitleMissing', { key: scopeKey })}</span>
            )}
          </p>
        </div>
        {viewSwitch}
      </header>
      {header.state === 'missing' ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-(--radius-card) border border-(--el-border) bg-(--el-tint-sky) px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text-strong)"
        >
          <SearchX className="mt-0.5 size-4 flex-none" aria-hidden="true" />
          <div className="flex flex-col gap-0.5">
            <p className="font-semibold">{t('scopeIndex.notFoundTitle', { key: scopeKey })}</p>
            <p>{t('scopeIndex.notFoundBody')}</p>
          </div>
        </div>
      ) : (
        <Suspense fallback={<RunsIndexSkeleton />}>{indexData}</Suspense>
      )}
    </div>
  );
}

/**
 * Resolve a `?scope=` key for the header. Only `WorkItemNotFoundError` means
 * *no such work item here*; any other failure is a failed READ, which must not
 * wear the unresolvable face — the list's own reads will say they failed.
 */
async function readScopeHeader(
  projectKey: string,
  scopeKey: string,
  ctx: { userId: string; workspaceId: string },
): Promise<ScopeHeader> {
  try {
    return {
      state: 'found',
      scope: await dispatchRunService.getRunScope(projectKey, scopeKey, ctx),
    };
  } catch (err) {
    if (err instanceof WorkItemNotFoundError) return { state: 'missing' };
    return { state: 'unread' };
  }
}

/**
 * The read, behind the boundary.
 *
 * ⚠️ THE TWO SECTIONS ARE TWO READS, and that is cheaper than it looks: live
 * runs are bounded by how many agents are running, so the first is short by
 * construction. Filtering one list client-side would mean asking for enough PAST
 * runs to be sure the live ones were included, which on an append-only list that
 * grows for ever is a read with no bound.
 *
 * ⚠️ A FAILED READ IS NOT AN EMPTY ONE. `design-notes.md` § panel 5 keeps them
 * separate faces — *we could not load this* and *nothing has run* are opposite
 * facts — so the catch resolves to a flag the island renders its own error for,
 * rather than throwing into a boundary that would replace the whole page.
 *
 * A `scopeKey` narrows BOTH reads by the query, never the page.
 */
async function RunsIndexData({
  projectKey,
  ctx,
  scopeKey,
  view,
  viewInUrl,
  canRun,
}: {
  projectKey: string;
  ctx: { userId: string; workspaceId: string };
  scopeKey: string | null;
  /** The SERVED view — both reads ask for it, and the island carries it. */
  view: RoomView;
  /** Whether the reader has the switch, so every address the island writes keeps `?view=`. */
  viewInUrl: boolean;
  canRun: boolean;
}) {
  const narrowing = { view, ...(scopeKey ? { scopeWorkItemKey: scopeKey } : {}) };
  const [live, past] = await Promise.all([
    dispatchRunService
      .listRunsForProject(
        projectKey,
        { take: PAGE, statuses: [...DISPATCH_RUN_LIVE_STATUSES], ...narrowing },
        ctx,
      )
      .catch(() => null),
    dispatchRunService
      .listRunsForProject(
        projectKey,
        { take: PAGE, statuses: [...DISPATCH_RUN_PAST_STATUSES], ...narrowing },
        ctx,
      )
      .catch(() => null),
  ]);

  return (
    <RunsIndex
      projectKey={projectKey}
      scopeKey={scopeKey}
      view={view}
      viewInUrl={viewInUrl}
      canRun={canRun}
      initialLive={live?.runs ?? null}
      initialPast={past?.runs ?? null}
      pageSize={PAGE}
    />
  );
}
