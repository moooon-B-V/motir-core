// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import type { OrgUsageDTO, UsageRunDTO } from '@/lib/dto/aiUsage';
import { renderWithIntl } from '../helpers/renderWithIntl';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';

// The org cost dashboard's RUN LOG — the job-kind pill (MOTIR-4305, building the
// MOTIR-4303 design amendment).
//
// ⚠️ THE PROPERTY THIS SUITE EXISTS FOR: the renderer is TOTAL over a PERSISTED
// STRING, not over a live enum. `AiUsage.jobKind` records what was submitted AT
// THE TIME, `aiUsageService` passes it straight through, and after MOTIR-4306 the
// four old planning kinds are gone from the wire — but their ROWS remain, and
// they are what an organization was billed for. So the switch must keep answering
// for values nothing sends any more, and it must not answer for them by
// relabelling them.
//
// It drives the SHIPPED component with `fetch` stubbed, rather than exporting the
// two helper functions to assert them directly: a test that calls
// `jobKindLabel('plan')` proves the switch has a case, and this proves the pill a
// person actually sees carries it.

import { OrgUsageClient } from '@/app/(authed)/settings/organization/usage/_components/OrgUsageClient';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** One run per job kind the column can hold — the live one, the four historical,
 *  and a value nobody has ever drawn. */
const KINDS = [
  'plan',
  'generate_tree',
  'expand_item',
  'augment',
  'replan',
  'something_nobody_drew',
] as const;

function run(jobKind: string, i: number): UsageRunDTO {
  return {
    jobId: `job_${i}`,
    jobKind,
    model: 'claude-opus-4-8',
    projectId: 'p1',
    projectName: 'Mobile App',
    inputTokens: 100,
    outputTokens: 50,
    credits: 7,
    startedAt: '2026-06-16T14:22:00.000Z',
  };
}

function dto(runs: UsageRunDTO[]): OrgUsageDTO {
  return {
    access: { isAdmin: true },
    scope: 'org',
    org: { id: 'org_1', name: 'moooon' },
    activeWorkspace: null,
    activeProject: null,
    drill: { workspaces: [], projects: [] },
    isMeta: false,
    balance: 914,
    tier: { key: 'basic', name: 'Basic', monthlyCreditAllotment: 1000 },
    totalSpend: 86,
    monthSpend: 86,
    monthlyHistory: [],
    perModel: [],
    recentRuns: { runs, page: 1, pageSize: 20, total: runs.length },
    hasUsage: true,
  } as unknown as OrgUsageDTO;
}

function stubUsage(body: OrgUsageDTO) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
}

async function renderRunLog(runs: UsageRunDTO[], messages: Record<string, unknown> = enMessages) {
  stubUsage(dto(runs));
  renderWithIntl(<OrgUsageClient orgId="org_1" orgName="moooon" />, { messages });
  // The island fetches on mount; wait for the authoritative response to land
  // rather than asserting against the loading frame.
  await waitFor(() => expect(screen.getAllByText('Mobile App').length).toBeGreaterThan(0));
}

describe('the run-log job-kind pill is TOTAL over a persisted string (MOTIR-4305)', () => {
  it('renders FIVE distinct labels — the live kind and the four historical ones', async () => {
    await renderRunLog(KINDS.slice(0, 5).map((k, i) => run(k, i)));

    const a = enMessages.aiUsage.activity;
    // The live kind, from the design's copy inventory.
    expect(a.kindPlan).toBe('Planning');
    // Each of the five renders its OWN label — asserted as a SET, so a switch
    // that collapsed two cases onto one string would fail here rather than pass
    // five individual `getByText` calls.
    const labels = [a.kindPlan, a.kindGenerate, a.kindExpand, a.kindAugment, a.kindReplan];
    expect(new Set(labels).size).toBe(5);
    for (const label of labels) {
      expect(screen.getByText(label), `${label} is not rendered`).toBeTruthy();
    }
    // …and none of them fell through to the generic default.
    expect(screen.queryByText(a.kindOther)).toBeNull();
  });

  it('gives `plan` the tint the design asset specifies, and `replan` the neutral one', async () => {
    await renderRunLog([run('plan', 0), run('replan', 1)]);

    const a = enMessages.aiUsage.activity;
    // `--el-tint-peach` is read off `design/ai-usage/usage.mock.html`'s `.pill-plan`
    // — the one tint that panel does not already spend.
    expect(screen.getByText(a.kindPlan).className).toContain('bg-(--el-tint-peach)');
    // ⚠️ `replan` is LABELLED and UNTINTED, deliberately: `jobKindTint` has no
    // case for it and the asset draws it with the neutral pill. A fifth tint here
    // would make the shipped surface and the design disagree.
    expect(screen.getByText(a.kindReplan).className).toContain('bg-(--el-surface)');
  });

  it('an UNKNOWN kind still falls to the generic default on the neutral tint', async () => {
    // The fallback is the CONTRACT for a value nobody has drawn — this card must
    // not turn a missing case into a crash or a blank cell. It is also what every
    // post-switch row rendered as before this card, which is why the card exists.
    await renderRunLog([run('something_nobody_drew', 0)]);

    const pill = screen.getByText(enMessages.aiUsage.activity.kindOther);
    expect(pill).toBeTruthy();
    expect(pill.className).toContain('bg-(--el-surface)');
  });

  it('the `zh` catalog carries the new key too — a key in one locale is a defect', async () => {
    // The two locales move together (`messages/` holds exactly these two). A
    // missing translation renders the KEY PATH to a Chinese-locale user, so this
    // asserts the rendered string rather than the catalog's shape.
    const zhPlan = (zhMessages as unknown as { aiUsage: { activity: { kindPlan: string } } })
      .aiUsage.activity.kindPlan;
    expect(zhPlan).toBeTruthy();
    expect(zhPlan).not.toBe(enMessages.aiUsage.activity.kindPlan);

    stubUsage(dto([run('plan', 0)]));
    renderWithIntl(<OrgUsageClient orgId="org_1" orgName="moooon" />, {
      locale: 'zh',
      messages: zhMessages as unknown as Record<string, unknown>,
    });
    await waitFor(() => expect(screen.getByText(zhPlan)).toBeTruthy());
  });

  it('the four historical labels are UNCHANGED — the org’s own record of what it paid for', async () => {
    // Pinned against the catalog values that shipped, so a future card cannot
    // "tidy" a retired kind's label and silently rewrite what a past invoice said.
    const a = enMessages.aiUsage.activity;
    expect(a.kindGenerate).toBe('Generate plan');
    expect(a.kindExpand).toBe('Expand story');
    expect(a.kindAugment).toBe('Augment tree');
    expect(a.kindReplan).toBe('Re-plan');
    expect(a.kindOther).toBe('Planning run');
  });
});

describe('the run log is AI-only, and that is a KNOWN gap rather than this card’s (MOTIR-4325)', () => {
  it('renders a row per RUN — a debit with no planning turn has no row to render', async () => {
    // ⚠️ NOT A BUG IN THIS CARD, and asserted so the boundary is legible rather
    // than assumed. `recentRuns` joins `PlanningTurn`, so `ci_overage` and
    // `search` debits are structurally absent from this table — while the
    // `balance` above it is the WHOLE ledger. That reconciliation gap is
    // MOTIR-4325's; this card only names the kind a planning run reports.
    await renderRunLog(KINDS.slice(0, 5).map((k, i) => run(k, i)));
    const rows = screen.getAllByText('Mobile App');
    expect(rows).toHaveLength(5);
  });
});
