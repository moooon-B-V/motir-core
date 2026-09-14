// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { AcceptanceVideoGateCard } from '@/app/(authed)/settings/project/approvals/_components/AcceptanceVideoGateCard';

// The acceptance-video switch, rendered for the only actor who reaches it.
//
// ⚠️ RESTORED 2026-09-13 — the Approvals room is manage-only (MOTIR-4880 re-plan ·
// MOTIR-5394); MOTIR-5278's browse view is reverted. Every actor who renders this
// card may change it, so there is no read-only case here.
//
// ⚠️ THE STATES ARE ASSERTED AS A SET (MOTIR-5171). The card's inputs are a pair —
// the stored flag × the organisation's entitlement — and all four values of that
// pair are rendered below, so no combination draws a state the design did not
// (`design/projects/approvals.mock.html` panels 1–3). The case that was WRONG on the
// org-tier card is `enabled: true, entitled: false`: it printed "On" beside an off
// switch.

function renderCard(initialEnabled: boolean, entitled = true) {
  return renderWithIntl(
    <ToastProvider>
      <AcceptanceVideoGateCard
        projectKey="MOTIR"
        initialEnabled={initialEnabled}
        entitled={entitled}
      />
    </ToastProvider>,
  );
}

const gateSwitch = () =>
  screen.getByRole('switch', { name: 'Acceptance video approval' }) as HTMLButtonElement;

const UNAVAILABLE_WHAT =
  'Your organisation has no paid Motir AI plan, so no acceptance video can be published.';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AcceptanceVideoGateCard — the switch a manager is offered', () => {
  it('is LIVE and shows the stored state when it is on', () => {
    renderCard(true);
    expect(gateSwitch().disabled).toBe(false);
    expect(gateSwitch().getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('On')).toBeTruthy();
  });

  it('shows the stored state when it is off, on the state line as well as the switch', () => {
    renderCard(false);
    expect(gateSwitch().disabled).toBe(false);
    expect(gateSwitch().getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Off')).toBeTruthy();
  });

  it('a click sends the PATCH and reconciles from its response', async () => {
    const fetchSpy = vi.fn(async () => Response.json({ acceptanceVideoEnabled: false }));
    vi.stubGlobal('fetch', fetchSpy);
    renderCard(true);

    fireEvent.click(gateSwitch());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Off')).toBeTruthy();
  });
});

describe('AcceptanceVideoGateCard — with no paid AI plan, ONE effective value', () => {
  it.each([
    ['the stored flag ON — the case the org-tier card got wrong', true],
    ['the stored flag OFF', false],
  ])('%s: named Unavailable, the switch off and disabled', (_label, enabled) => {
    renderCard(enabled, false);

    expect(screen.getByText('Unavailable')).toBeTruthy();
    expect(screen.getByText(UNAVAILABLE_WHAT)).toBeTruthy();
    // The label and the switch agree: nothing prints a name the switch contradicts.
    expect(screen.queryByText('On')).toBeNull();
    expect(screen.queryByText('Off')).toBeNull();
    expect(gateSwitch().getAttribute('aria-checked')).toBe('false');
    expect(gateSwitch().disabled).toBe(true);
  });

  it('explains the entitlement is the organisation’s and offers Upgrade', () => {
    renderCard(true, false);

    expect(
      screen.getByText('The plan is bought once, for the organisation — not per project.'),
    ).toBeTruthy();
    const upgrade = screen.getByRole('link', { name: 'Upgrade' });
    expect(upgrade.getAttribute('href')).toBe('/settings/organization/billing');
  });

  it('a disabled switch sends nothing when clicked', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    renderCard(true, false);

    fireEvent.click(gateSwitch());

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('an entitled organisation carries no entitlement footer', () => {
    renderCard(true);
    expect(screen.queryByRole('link', { name: 'Upgrade' })).toBeNull();
    expect(screen.queryByText(UNAVAILABLE_WHAT)).toBeNull();
  });
});

describe('AcceptanceVideoGateCard — ink', () => {
  it.each([
    ['On', true, true],
    ['Off', false, true],
    ['Unavailable', true, false],
  ])('%s: no string uses --el-text-muted', (_label, enabled, entitled) => {
    const { container } = renderCard(enabled, entitled);
    expect(container.innerHTML).not.toContain('--el-text-muted');
    // The description and the state gloss read on the AA-passing secondary ink.
    const secondary = [...container.querySelectorAll('[class*="--el-text-secondary"]')].map(
      (el) => el.textContent,
    );
    expect(secondary.some((text) => text?.startsWith('A story that has an acceptance video'))).toBe(
      true,
    );
    expect(secondary.length).toBeGreaterThanOrEqual(2);
  });
});
