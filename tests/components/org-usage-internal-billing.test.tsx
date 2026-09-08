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
const exempt = enMessages.aiUsage.exempt;

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

/**
 * Every LEAF text node the surface renders, as a set. Used for criterion 7's
 * difference assertion: a fixed list of things that must stay identical stops
 * covering the surface the day somebody adds one, so the assertion is the SET
 * DIFFERENCE between two renders of the same DTO instead.
 */
function leafText(): Set<string> {
  return new Set(
    Array.from(document.querySelectorAll<HTMLElement>('*'))
      .filter((el) => el.children.length === 0)
      .map((el) => (el.textContent ?? '').trim())
      .filter(Boolean),
  );
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

  it('renders Panel 7b — the OUT-OF-CREDITS card — at a zero balance, and KEEPS its tier pill', async () => {
    await renderUsage(dto({ balance: 0 }));

    expect(screen.getByText(sum.internalBilling)).toBeTruthy();
    expect(screen.getByText(out.title)).toBeTruthy();
    expect(screen.getByText(out.passiveSlot)).toBeTruthy();
    expect(screen.queryByText(low.title)).toBeNull();
    // ⚠️ MOTIR-4806 criterion 6 — WHY this org keeps both, where an `isMeta` one
    // gets neither. `internalBilling` is charged exactly like a customer and made
    // whole afterwards: it genuinely HAS a tier, and at a zero balance it is
    // genuinely refused by both of motir-ai's gates (`hasCredits = isMeta ||
    // balanceCredits > 0` is false here). Every line on this page is true for it,
    // so the predicate must never widen from `isMeta` to the classification flag
    // — that would hide a real refusal.
    expect(screen.getByText(sum.tier.replace('{tier}', 'Basic'))).toBeTruthy();
    expect(screen.queryByText(sum.exemptPill)).toBeNull();
    expect(screen.queryByText(exempt.title)).toBeNull();
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

/**
 * THE EXEMPT ORG — MOTIR-4806, to `design/ai-usage/design-notes.md`
 * §§ AMENDMENT 2026-09-07 (panel 7c) and AMENDMENT 2026-09-08 (the tier pill).
 *
 * ⚠️ WHY THIS BLOCK EXISTS AT ALL, AND WHY IT IS SEPARATE FROM THE ONE ABOVE.
 * The suite above fixes `isMeta: false, internalBilling: true` — which is why
 * neither of these two states was ever exercised: the fixture that would produce
 * them did not exist in this file, and both defects shipped under it. "Internal"
 * is not one thing, and a suite that only ever renders one of the two kinds
 * cannot see the difference the whole predicate is about.
 */
describe('the usage dashboard for an EXEMPT org (`isMeta`)', () => {
  const meta = (over: Partial<OrgUsageDTO> = {}) =>
    dto({ isMeta: true, internalBilling: false, ...over });

  it('renders Panel 7c — NOT 7b — at a zero balance and at a negative one', async () => {
    for (const balance of [0, -4210]) {
      await renderUsage(meta({ balance }));

      expect(screen.getByText(exempt.title)).toBeTruthy();
      expect(screen.getByText(exempt.balanceNote)).toBeTruthy();
      // The sentence this card exists to remove: no gate performs the pause it
      // asserts, at either enforcement point in motir-ai.
      expect(screen.queryByText(out.title)).toBeNull();
      expect(screen.queryByText(out.passiveSlot)).toBeNull();
      expect(screen.queryByText(low.title)).toBeNull();
      // …and the figure is still the real one, negative included — formatted the
      // way the hero formats it (`fmt` is `toLocaleString`, so -4210 is -4,210).
      expect(screen.getByText(balance.toLocaleString())).toBeTruthy();

      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it('replaces the tier pill with the EXEMPT pill, and never names a commercial tier', async () => {
    await renderUsage(meta({ balance: -4210 }));

    // The reported defect, verbatim: `moooon` read "Free tier".
    expect(screen.queryByText(sum.tier.replace('{tier}', 'Basic'))).toBeNull();
    expect(screen.queryByText(sum.tier.replace('{tier}', 'Free'))).toBeNull();
    expect(screen.getByText(sum.exemptPill)).toBeTruthy();
  });

  it('renders NO pill at all when the org has genuinely never transacted (`tier: null`)', async () => {
    // The third row of the predicate table, and the one the 2026-09-07 fixture
    // mistook for the live shape: an org with no tier row has never run, so it
    // has no balance to be negative either. `ensureBilling` assigns the free tier
    // BEFORE the first debit, which is why the two cannot co-occur in life.
    await renderUsage(meta({ balance: 0, tier: null }));

    expect(screen.queryByText(sum.exemptPill)).toBeNull();
    expect(screen.queryByText(sum.tier.replace('{tier}', 'Free'))).toBeNull();
    // 7c still renders — the exhausted balance is about the number, not the tier.
    expect(screen.getByText(exempt.title)).toBeTruthy();
  });

  it('the CUSTOMER path is untouched — a plain org still gets 7b at zero and at a negative balance', async () => {
    for (const balance of [0, -120]) {
      await renderUsage(dto({ isMeta: false, internalBilling: false, balance }));

      expect(screen.getByText(out.title)).toBeTruthy();
      expect(screen.queryByText(exempt.title)).toBeNull();
      expect(screen.queryByText(sum.exemptPill)).toBeNull();
      expect(screen.getByText(sum.tier.replace('{tier}', 'Basic'))).toBeTruthy();

      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it('SUPPRESSES NOTHING ELSE — the only differences between the two renders are the state and the pill', async () => {
    // ⚠️ THE DIFFERENCE IS THE ASSERTION (criterion 7), and it is stated as a SET
    // DIFFERENCE rather than as a list of things that must survive — a list stops
    // covering the surface the day somebody adds a figure to it. Same DTO, one
    // flag flipped.
    await renderUsage(dto({ isMeta: false, internalBilling: false, balance: 0 }));
    const gated = leafText();
    const gatedControls = controls();
    cleanup();
    vi.unstubAllGlobals();

    await renderUsage(meta({ balance: 0 }));
    const exemptText = leafText();
    const exemptControls = controls();

    // Non-vacuous: both renders drew a substantial surface.
    expect(gated.size).toBeGreaterThan(20);

    const removed = [...gated].filter((x) => !exemptText.has(x));
    const added = [...exemptText].filter((x) => !gated.has(x));

    // EXACTLY the 7b→7c swap and the pill swap. Every figure — the balance, the
    // allotment bar and its caption, the drill, the per-model breakdown, the run
    // log and the search figures — is in both sets, so none of them is named
    // here and all of them are covered.
    expect(removed.sort()).toEqual(
      [
        out.title,
        out.body.replace('{org}', 'moooon'),
        out.passiveSlot,
        sum.tier.replace('{tier}', 'Basic'),
      ].sort(),
    );
    expect(added.sort()).toEqual(
      [
        exempt.title,
        exempt.body.replace('{org}', 'moooon'),
        exempt.balanceNote,
        sum.exemptPill,
      ].sort(),
    );

    // And 7c gates nothing either — the same clause 7b was held to.
    expect(exemptControls.disabled).toEqual(gatedControls.disabled);
    expect(exemptControls.total).toBe(gatedControls.total);
  });
});
