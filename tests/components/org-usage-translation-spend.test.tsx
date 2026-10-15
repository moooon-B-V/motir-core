// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import type { OrgUsageDTO } from '@/lib/dto/aiUsage';
import { renderWithIntl } from '../helpers/renderWithIntl';
import enMessages from '@/messages/en.json';
import { translationUsageFigures } from '@/app/(authed)/settings/organization/usage/_components/translationUsage';
import { OrgUsageClient } from '@/app/(authed)/settings/organization/usage/_components/OrgUsageClient';

// THE TRANSLATION LINE on Settings → Organization → Usage & cost (Story
// MOTIR-7735 · MOTIR-8117) — `org-usage-search-spend.test.tsx`'s twin. Three
// states, and the rule that governs them: UNAVAILABLE IS NOT ZERO. The figure is
// org-level, so a drilled response does not narrow it, and it is never part of
// the AI figures beside it.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const sum = enMessages.aiUsage.summary;

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
    monthlyHistory: [{ yearMonth: '2026-10', credits: 7520 }],
    recentRuns: { runs: [], page: 1, pageSize: 20, total: 0 },
    search: { totalSpend: 0, monthSpend: 0 },
    searchRuns: {
      runs: [],
      page: 1,
      pageSize: 20,
      total: 0,
      attributedSpend: 0,
      unattributedSpend: 0,
    },
    translation: { totalSpend: 3604, monthSpend: 451 },
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

const card = () => document.querySelector<HTMLElement>('[data-usage-translation]')!;

describe('translationUsageFigures', () => {
  it('carries both figures verbatim', () => {
    expect(translationUsageFigures(dto())).toEqual({
      variant: 'spend',
      monthSpend: 451,
      totalSpend: 3604,
    });
  });

  it('spend when only the all-time figure is above zero', () => {
    const f = translationUsageFigures(dto({ translation: { totalSpend: 12, monthSpend: 0 } }));
    expect(f.variant).toBe('spend');
  });

  it('none for zeros; unavailable for null AND for an omitted key — never zero', () => {
    expect(
      translationUsageFigures(dto({ translation: { totalSpend: 0, monthSpend: 0 } })).variant,
    ).toBe('none');
    expect(translationUsageFigures(dto({ translation: null }))).toEqual({
      variant: 'unavailable',
      monthSpend: null,
      totalSpend: null,
    });
    const { translation: _t, ...omitted } = dto();
    expect(translationUsageFigures(omitted as OrgUsageDTO).variant).toBe('unavailable');
  });
});

describe('the Translation line', () => {
  it('spend: the month and all-time figures, labelled organisation-level', async () => {
    await renderUsage(dto());
    const c = card();
    expect(c.getAttribute('data-usage-translation')).toBe('spend');
    expect(within(c).getByText(sum.translationThisMonth)).toBeTruthy();
    expect(within(c).getByText('451 credits')).toBeTruthy();
    expect(within(c).getByText('3,604 credits all time')).toBeTruthy();
    expect(within(c).getByText(sum.scopeOrg)).toBeTruthy();
  });

  it('none: a zero and a line saying nothing was spent on translation', async () => {
    await renderUsage(dto({ translation: { totalSpend: 0, monthSpend: 0 } }));
    const c = card();
    expect(c.getAttribute('data-usage-translation')).toBe('none');
    expect(within(c).getByText('0 credits')).toBeTruthy();
    expect(within(c).getByText(sum.translationNone)).toBeTruthy();
    expect(within(c).queryByLabelText(sum.translationUnavailableValue)).toBeNull();
  });

  it('unavailable: an em-dash and a line saying so — visibly not the zero', async () => {
    await renderUsage(dto({ translation: null }));
    const c = card();
    expect(c.getAttribute('data-usage-translation')).toBe('unavailable');
    expect(within(c).getByLabelText(sum.translationUnavailableValue).textContent).toBe('—');
    expect(within(c).getByText(sum.translationUnavailable)).toBeTruthy();
    expect(within(c).queryByText('0 credits')).toBeNull();
    expect(within(c).queryByText(sum.translationNone)).toBeNull();
  });

  it('a drilled response does not narrow it, and it is not in the AI figures', async () => {
    await renderUsage(
      dto({
        scope: 'project',
        activeProject: { id: 'p1', name: 'Mobile App' },
        totalSpend: 120,
        monthSpend: 80,
        monthlyHistory: [{ yearMonth: '2026-10', credits: 80 }],
      }),
    );
    const c = card();
    expect(within(c).getByText('451 credits')).toBeTruthy();
    expect(within(c).getByText('3,604 credits all time')).toBeTruthy();
    expect(within(c).getByText(sum.scopeOrg)).toBeTruthy();
    // The AI figures are the boundary's own, untouched by translation spend.
    expect(screen.getByText('120 credits')).toBeTruthy();
    expect(screen.queryByText('571 credits')).toBeNull();
    expect(screen.queryByText('3,724 credits')).toBeNull();
  });
});
