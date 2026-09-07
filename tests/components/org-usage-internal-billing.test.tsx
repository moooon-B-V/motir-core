// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import type { OrgUsageDTO } from '@/lib/dto/aiUsage';
import { renderWithIntl } from '../helpers/renderWithIntl';
import enMessages from '@/messages/en.json';
import { OrgUsageClient } from '@/app/(authed)/settings/organization/usage/_components/OrgUsageClient';

/**
 * THE PANELS AN INTERNAL ORG COULD NEVER SEE — MOTIR-4572, Story MOTIR-4337.
 *
 * ⚠️ WHY THESE TWO PANELS AND NOT THE WHOLE SURFACE. Five `isMeta` reads stood
 * in `OrgUsageClient`'s derivation block, and between them they hid the balance
 * hero's figure, the allotment bar, the low-balance banner (Panel 7a) and the
 * out-of-credits card (Panel 7b). The org with the most product usage was the
 * one org that could never see any of them. The other three surfaces have
 * existing suites that this card INVERTED; 7a and 7b had none, because before
 * this card their `internalBilling` states were unreachable — there was no
 * fixture that could produce them and no assertion that could fail.
 *
 * ⚠️ AND THE SECOND TEST IS THE STORY'S OWN CLAUSE, NOT A REDUNDANT RENDER.
 * *The org is never blocked.* Rendering out-of-credits is a STATEMENT about the
 * balance, and the ledger keeps that balance at zero by pairing every debit with
 * an offsetting credit in the same transaction (MOTIR-4570) — so the state is
 * reachable in a fixture and unreachable in life. What must never be true is
 * that DRAWING it turns something off. That is asserted as a DIFFERENCE between
 * two renders rather than as a fixed list, because a fixed list of controls
 * silently stops covering the surface the day somebody adds one.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const sum = enMessages.aiUsage.summary;
const low = enMessages.aiUsage.lowBalance;
const out = enMessages.aiUsage.outOfCredits;

function dto(over: Partial<OrgUsageDTO> = {}): OrgUsageDTO {
  return {
    access: { isAdmin: true },
    scope: 'org',
    org: { id: 'org_1', name: 'moooon' },
    activeWorkspace: null,
    activeProject: null,
    drill: { workspaces: [], projects: [] },
    isMeta: false,
    // The whole point of the fixture: this org IS classified.
    internalBilling: true,
    balance: 914,
    tier: { key: 'basic', name: 'Basic', monthlyCreditAllotment: 1000 },
    totalSpend: 7520,
    monthSpend: 7520,
    monthlyHistory: [],
    perModel: [
      { model: 'claude-opus-4-8', inputTokens: 120_000, outputTokens: 40_000, credits: 6_100 },
      { model: 'claude-sonnet-4-5', inputTokens: 90_000, outputTokens: 30_000, credits: 1_420 },
    ],
    recentRuns: { runs: [], page: 1, pageSize: 20, total: 0 },
    search: { totalSpend: 1204, monthSpend: 312 },
    searchRuns: {
      runs: [],
      page: 1,
      pageSize: 20,
      total: 0,
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

/**
 * Every control on the surface, and whether it is turned off. Read from the DOM
 * rather than enumerated, so a control added later is covered without an edit.
 */
function controls(): { total: number; disabled: string[] } {
  const els = Array.from(
    document.querySelectorAll<HTMLElement>('button, a, input, select, textarea'),
  );
  return {
    total: els.length,
    disabled: els
      .filter((el) => el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true')
      .map(
        (el) => `${el.tagName}:${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim()}`,
      )
      .sort(),
  };
}

describe('the usage dashboard for an org classified `internalBilling`', () => {
  it('renders the real balance, the ALLOTMENT BAR and the per-model breakdown', async () => {
    await renderUsage(dto());

    // The figure, not a word — `summary.unlimited` stood here and is deleted.
    expect(screen.getByText('914')).toBeTruthy();
    // The bar's own caption, which the `remainingPct` read used to suppress:
    // 914 of a 1,000-credit allotment is 91%.
    expect(
      screen.getByText(
        sum.allotmentRemaining.replace('{pct}', '91').replace('{allotment}', '1,000'),
      ),
    ).toBeTruthy();
    // …and the breakdown, whose rows are unconditional but whose surrounding
    // hero was not.
    expect(screen.getByText(enMessages.aiUsage.byModel.title)).toBeTruthy();
    expect(screen.getByText('claude-opus-4-8')).toBeTruthy();
    expect(screen.getByText('claude-sonnet-4-5')).toBeTruthy();
  });

  it('renders Panel 7a — the LOW-BALANCE banner — when the balance reaches that threshold', async () => {
    // 40 of a 1000-credit allotment is 4%, under the 10% line.
    await renderUsage(dto({ balance: 40 }));

    expect(screen.getByText(sum.internalBilling)).toBeTruthy();
    expect(screen.getByText(low.title)).toBeTruthy();
    // …and NOT the paused card: the two states are exclusive, and a banner that
    // appeared alongside "planning is paused" would contradict it.
    expect(screen.queryByText(out.title)).toBeNull();
  });

  it('renders Panel 7b — the OUT-OF-CREDITS card — at a zero balance', async () => {
    await renderUsage(dto({ balance: 0 }));

    expect(screen.getByText(sum.internalBilling)).toBeTruthy();
    expect(screen.getByText(out.title)).toBeTruthy();
    expect(screen.getByText(out.passiveSlot)).toBeTruthy();
    expect(screen.queryByText(low.title)).toBeNull();
  });

  it('a NEGATIVE balance is out of credits too, and the figure is shown rather than hidden', async () => {
    // The state the old comment said "is never surfaced". It is surfaced now,
    // and the number is the real one — an internal org whose offset had not yet
    // been written would show exactly this, which is the point of showing it.
    await renderUsage(dto({ balance: -120 }));

    expect(screen.getByText(out.title)).toBeTruthy();
    expect(screen.getByText('-120')).toBeTruthy();
  });

  it('drawing out-of-credits GATES NOTHING — no control is disabled that was enabled at a healthy balance', async () => {
    await renderUsage(dto({ balance: 914 }));
    const healthy = controls();
    cleanup();
    vi.unstubAllGlobals();

    await renderUsage(dto({ balance: 0 }));
    expect(screen.getByText(out.title)).toBeTruthy();
    const drained = controls();
    // Non-vacuous: the surface HAS controls to gate.
    expect(healthy.total).toBeGreaterThan(0);

    // ⚠️ THE DIFFERENCE IS THE ASSERTION. The story's clause is *the org is
    // never blocked*; the way that regresses is somebody reading `outOfCredits`
    // and hanging a `disabled` off it, which would look correct in isolation.
    expect(drained.disabled).toEqual(healthy.disabled);
    // And the paused card adds no control of its own — its Epic-8 slot is
    // PASSIVE by design, so the count is unchanged in both directions.
    expect(drained.total).toBe(healthy.total);
  });
});
