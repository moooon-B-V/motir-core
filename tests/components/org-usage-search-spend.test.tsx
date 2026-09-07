// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import type { OrgUsageDTO, SearchRunDTO, UsageRunDTO } from '@/lib/dto/aiUsage';
import { renderWithIntl } from '../helpers/renderWithIntl';
import enMessages from '@/messages/en.json';
import {
  activityEntries,
  activityPageCount,
  searchUsageFigures,
} from '@/app/(authed)/settings/organization/usage/_components/searchUsage';
import { OrgUsageClient } from '@/app/(authed)/settings/organization/usage/_components/OrgUsageClient';

// SEARCH SPEND on the org cost dashboard (MOTIR-4558, building the MOTIR-4554
// design asset). EXTENDS the surface's coverage — `org-usage-run-log.test.tsx`
// is untouched and still runs.
//
// The three decisions this suite exists to hold, from the asset:
//   1. Two figures come apart under the DRILL, and each states its own scope.
//   2. A search row is NOT a job kind, and its empty columns take an EM-DASH.
//   3. The remainder is shown when it exists and NOT DRAWN when it is zero.
// Plus the rule that governs all three: **UNAVAILABLE IS NOT ZERO.**

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const a = enMessages.aiUsage.activity;
const sum = enMessages.aiUsage.summary;

function run(over: Partial<UsageRunDTO> = {}): UsageRunDTO {
  return {
    jobId: 'job_run_1',
    jobKind: 'plan',
    model: 'claude-opus-4-8',
    projectId: 'p1',
    projectName: 'Mobile App',
    inputTokens: 100,
    outputTokens: 50,
    credits: 86,
    startedAt: '2026-09-05T14:22:00.000Z',
    ...over,
  };
}

function searchRun(over: Partial<SearchRunDTO> = {}): SearchRunDTO {
  return { jobId: 'job_search_1', credits: 4, lastSearchAt: '2026-09-05T14:19:00.000Z', ...over };
}

function dto(over: Partial<OrgUsageDTO> = {}): OrgUsageDTO {
  return {
    access: { isAdmin: true },
    scope: 'org',
    org: { id: 'org_1', name: 'moooon' },
    activeWorkspace: null,
    activeProject: null,
    drill: { workspaces: [], projects: [] },
    isMeta: false,
    internalBilling: false,
    balance: 914,
    tier: { key: 'basic', name: 'Basic', monthlyCreditAllotment: 1000 },
    totalSpend: 7520,
    monthSpend: 7520,
    monthlyHistory: [],
    perModel: [],
    recentRuns: { runs: [run()], page: 1, pageSize: 20, total: 1 },
    search: { totalSpend: 1204, monthSpend: 312 },
    searchRuns: {
      runs: [searchRun()],
      page: 1,
      pageSize: 20,
      total: 1,
      attributedSpend: 246,
      unattributedSpend: 66,
    },
    hasUsage: true,
    ...over,
  } as unknown as OrgUsageDTO;
}

async function renderUsage(body: OrgUsageDTO) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
  renderWithIntl(<OrgUsageClient orgId="org_1" orgName="moooon" />, { messages: enMessages });
  await waitFor(() => expect(screen.getByText(sum.balance)).toBeTruthy());
}

// ── The view model ───────────────────────────────────────────────────────────

describe('searchUsageFigures', () => {
  it('carries every figure verbatim and flags the remainder', () => {
    const f = searchUsageFigures(dto())!;
    expect(f.variant).toBe('spend');
    expect(f.monthSpend).toBe(312);
    expect(f.totalSpend).toBe(1204);
    expect(f.attributedSpend).toBe(246);
    // NOT re-derived from the rows — it arrives computed over the same
    // population as the total, and re-deriving it would let the two sides of the
    // boundary disagree about a figure the customer reconciles by eye.
    expect(f.unattributedSpend).toBe(66);
    expect(f.hasRemainder).toBe(true);
  });

  it('reports NONE for a zero scope — not the dashboard`s global empty state', () => {
    const f = searchUsageFigures(
      dto({
        search: { totalSpend: 0, monthSpend: 0 },
        searchRuns: {
          runs: [],
          page: 1,
          pageSize: 20,
          total: 0,
          attributedSpend: 0,
          unattributedSpend: 0,
        },
      }),
    )!;
    expect(f.variant).toBe('none');
    expect(f.hasRemainder).toBe(false);
  });

  it('reports UNAVAILABLE for a REPORTED absence — `null`', () => {
    const f = searchUsageFigures(dto({ search: null, searchRuns: null }))!;
    expect(f.variant).toBe('unavailable');
    expect(f.figuresUnavailable).toBe(true);
    expect(f.monthSpend).toBeNull();
    expect(f.attributedSpend).toBeNull();
  });

  it('reports UNAVAILABLE for an OMITTED key too — the shape the wire can produce', () => {
    // `null` is a reported absence and `undefined` is an omitted JSON key. Both
    // mean the block was not reported, and only one of them is expressible in
    // the DTO type — so the type cannot be what proves this. The fixture is
    // built WITHOUT the keys rather than by deleting them, so it is the object
    // an older motir-ai would actually serialize.
    const { search: _s, searchRuns: _sr, ...withoutSearch } = dto();
    const f = searchUsageFigures(withoutSearch as OrgUsageDTO)!;
    expect(f.variant).toBe('unavailable');
    expect(f.figuresUnavailable).toBe(true);
    expect(f.monthSpend).toBeNull();
  });

  it('⚠️ UNAVAILABLE and ZERO do not collapse', () => {
    const unavailable = searchUsageFigures(dto({ search: null, searchRuns: null }))!;
    const zero = searchUsageFigures(
      dto({
        search: { totalSpend: 0, monthSpend: 0 },
        searchRuns: {
          runs: [],
          page: 1,
          pageSize: 20,
          total: 0,
          attributedSpend: 0,
          unattributedSpend: 0,
        },
      }),
    )!;
    expect(unavailable.variant).not.toBe(zero.variant);
    expect(unavailable.monthSpend).toBeNull();
    expect(zero.monthSpend).toBe(0);
  });

  // ⚠️ INVERTED (Story MOTIR-4337 · MOTIR-4572). The META arm returned `null`
  // because the dashboard showed that org a WORD where a balance belongs, so a
  // search figure beside it would have been the only number on the page. Every
  // org renders the real figures now, and search spend is one of them.
  it('renders the search figures for an internal-billing org', () => {
    expect(searchUsageFigures(dto({ internalBilling: true }))).not.toBeNull();
  });
});

// ── The merged list, and the page-at-a-time rule ─────────────────────────────

describe('activityEntries / activityPageCount', () => {
  it('merges THIS PAGE of each source, newest first — one list, not two', () => {
    const entries = activityEntries(
      dto({
        recentRuns: {
          runs: [
            run({ jobId: 'r1', startedAt: '2026-09-05T14:22:00.000Z' }),
            run({ jobId: 'r2', startedAt: '2026-09-05T13:58:00.000Z' }),
          ],
          page: 1,
          pageSize: 20,
          total: 2,
        },
        searchRuns: {
          runs: [searchRun({ jobId: 's1', lastSearchAt: '2026-09-05T14:19:00.000Z' })],
          page: 1,
          pageSize: 20,
          total: 1,
          attributedSpend: 4,
          unattributedSpend: 0,
        },
      }),
    );

    expect(entries.map((e) => e.kind)).toEqual(['run', 'search', 'run']);
    // It merged; it did not JOIN and it did not fetch more.
    expect(entries).toHaveLength(3);
  });

  it('sizes the pager on BOTH lists, so a search page is never unreachable', () => {
    // 1 page of runs, 3 of searches. Sizing on `recentRuns` alone — the shipped
    // behaviour before this card — would strand pages 2 and 3.
    const pages = activityPageCount(
      dto({
        recentRuns: { runs: [run()], page: 1, pageSize: 10, total: 4 },
        searchRuns: {
          runs: [searchRun()],
          page: 1,
          pageSize: 10,
          total: 25,
          attributedSpend: 25,
          unattributedSpend: 0,
        },
      }),
    );
    expect(pages).toBe(3);
  });

  it('is unaffected when there are no search entries at all', () => {
    const d = dto({ search: null, searchRuns: null });
    expect(activityEntries(d).every((e) => e.kind === 'run')).toBe(true);
    expect(activityPageCount(d)).toBe(1);
  });
});

// ── The rendered surface ─────────────────────────────────────────────────────

describe('the search summary figures', () => {
  it('renders both figures with their SCOPE stated (AC 2)', async () => {
    await renderUsage(dto());

    expect(screen.getByText(sum.searchThisMonth)).toBeTruthy();
    expect(screen.getByText(sum.searchAttributed)).toBeTruthy();
    // ⚠️ The org-level figure says so; the ones that narrow say the opposite.
    // Without this the middle figure not moving under a drill reads as broken.
    expect(screen.getAllByText(sum.scopeOrg).length).toBe(1);
    expect(screen.getAllByText(sum.scopeFollows).length).toBeGreaterThanOrEqual(3);
  });

  it('labels credits as `credits` and never a currency', async () => {
    await renderUsage(dto());
    const panel = screen.getByText(sum.searchThisMonth).closest('div')?.parentElement;
    expect(panel?.textContent ?? '').not.toContain('$');
    expect(screen.getByText('1,204 credits all time')).toBeTruthy();
  });

  it('shows the REMAINDER when there is one (AC 4)', async () => {
    await renderUsage(dto());
    expect(screen.getByText('66 credits not attributed to a run')).toBeTruthy();
  });

  it('⚠️ draws NO remainder line when it is zero (AC 4)', async () => {
    // A line reading "not attributed — 0" invites the reader to look for a
    // problem that does not exist.
    await renderUsage(
      dto({
        searchRuns: {
          runs: [searchRun()],
          page: 1,
          pageSize: 20,
          total: 1,
          attributedSpend: 312,
          unattributedSpend: 0,
        },
      }),
    );
    expect(screen.getByText(sum.searchAttributed)).toBeTruthy();
    expect(screen.queryByText(/not attributed to a run/)).toBeNull();
  });

  it('⚠️ renders UNAVAILABLE as a dash, visibly different from zero (AC 5)', async () => {
    await renderUsage(dto({ search: null, searchRuns: null }));

    expect(screen.getAllByLabelText(sum.searchUnavailableValue).length).toBe(2);
    expect(screen.getByText(sum.searchUnavailable)).toBeTruthy();
    // The token figures beside it are untouched — a per-figure treatment, never
    // a page error.
    expect(screen.getByText(sum.spentThisMonth)).toBeTruthy();
    expect(screen.queryByText(/couldn’t load/i)).toBeNull();
  });

  it('renders the search figures AND a real balance for an internal-billing org (MOTIR-4572)', async () => {
    await renderUsage(dto({ internalBilling: true }));
    expect(screen.getByText(sum.searchThisMonth)).toBeTruthy();
    // The BALANCE, not the word `Unlimited` — that key is deleted with its
    // branch. A word where a figure belongs is the shape this story removes.
    expect(screen.getByText('914')).toBeTruthy();
    expect(screen.getByText(sum.internalBilling)).toBeTruthy();
  });
});

describe('the search row in the activity log', () => {
  it('renders INSIDE the shipped log, interleaved with token rows (AC 3)', async () => {
    await renderUsage(dto());

    // One list: the token run and the search entry are in the same table.
    expect(screen.getByText(a.webSearch)).toBeTruthy();
    expect(screen.getByText(a.kindPlan)).toBeTruthy();
    const table = screen.getByText(a.webSearch).closest('table');
    expect(table).toBeTruthy();
    expect(table?.contains(screen.getByText(a.kindPlan))).toBe(true);
  });

  it('⚠️ takes the NEUTRAL chip, never a job-kind tint', async () => {
    await renderUsage(dto());
    // A search is not a job kind. All six tint slots on this surface are spent,
    // five on job kinds — reusing `sky` would make a search read like `expand`.
    const chip = screen.getByText(a.webSearch).closest('span');
    const cls = chip?.className ?? '';
    expect(cls).not.toContain('--el-tint-sky');
    expect(cls).not.toContain('--el-tint-peach');
    expect(cls).not.toContain('--el-tint-mint');
    expect(cls).not.toContain('--el-tint-lavender');
  });

  it('⚠️ puts an EM-DASH in the columns a search has no value for, never a zero', async () => {
    await renderUsage(dto());
    // A search does not use zero tokens — it uses none, and a `0` claims the
    // first. The label carries the meaning for a reader who cannot see the dash.
    expect(screen.getByLabelText(a.noModel)).toBeTruthy();
    expect(screen.getByLabelText(a.noTokens)).toBeTruthy();
    // Its credits ARE real and are in the same column every other row sums into.
    expect(screen.getByText('4')).toBeTruthy();
  });

  it('keeps the log page-at-a-time — the pager is still there (AC 3)', async () => {
    await renderUsage(dto());
    expect(screen.getByRole('button', { name: a.next })).toBeTruthy();
    expect(screen.getByRole('button', { name: a.prev })).toBeTruthy();
  });
});

// ── AC 6 — the shipped member narrowing is unchanged ─────────────────────────

describe('the plain-member view', () => {
  it('carries no org-wide search figure the member is not entitled to', async () => {
    // `aiUsageService` narrows a non-admin to their own project SERVER-side and
    // this card does not widen it: what the member sees is whatever that call
    // returned. Here the boundary reported no search block for them, so the page
    // renders the unavailable treatment and NO org-level number.
    await renderUsage(
      dto({
        access: { isAdmin: false },
        scope: 'project',
        activeProject: { id: 'p1', name: 'Mobile App' },
        search: null,
        searchRuns: null,
      }),
    );

    expect(screen.queryByText('1,204 credits all time')).toBeNull();
    expect(screen.queryByText(/not attributed to a run/)).toBeNull();
    expect(screen.getAllByLabelText(sum.searchUnavailableValue).length).toBe(2);
  });

  it('shows a member their OWN project`s attributed spend when the boundary sends it', async () => {
    await renderUsage(
      dto({
        access: { isAdmin: false },
        scope: 'project',
        activeProject: { id: 'p1', name: 'Mobile App' },
        search: { totalSpend: 1204, monthSpend: 312 },
        searchRuns: {
          runs: [searchRun()],
          page: 1,
          pageSize: 20,
          total: 1,
          attributedSpend: 84,
          unattributedSpend: 0,
        },
      }),
    );
    expect(screen.getByText(sum.searchAttributed)).toBeTruthy();
    expect(screen.getByText('84 credits')).toBeTruthy();
  });
});
