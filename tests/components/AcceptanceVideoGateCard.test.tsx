// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { AcceptanceVideoGateCard } from '@/app/(authed)/settings/project/approvals/_components/AcceptanceVideoGateCard';

// The acceptance-video switch, rendered for the only actor who reaches it.
//
// ⚠️ RESTORED 2026-09-13 — the Approvals room is manage-only (MOTIR-4880 re-plan ·
// MOTIR-5394); MOTIR-5278's browse view is reverted. MOTIR-5278 added this file
// with `canManage` cases: a DISABLED switch for a member the PATCH refuses. The
// room admits only `workflow:manage` again, so every actor who renders this card
// may change it. The prop, its disabled branch and those cases are gone. What
// stays is what the card owes that actor: a live switch showing the STORED state,
// and a click that really sends the PATCH.
//
// Out of scope, and deliberately unasserted: `Unavailable`, which is MOTIR-5171's.

function renderCard(initialEnabled: boolean) {
  return renderWithIntl(
    <ToastProvider>
      <AcceptanceVideoGateCard projectKey="MOTIR" initialEnabled={initialEnabled} />
    </ToastProvider>,
  );
}

const gateSwitch = () =>
  screen.getByRole('switch', { name: 'Acceptance video approval' }) as HTMLButtonElement;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AcceptanceVideoGateCard — the switch a manager is offered', () => {
  it('is LIVE and shows the stored state when it is on', () => {
    renderCard(true);
    expect(gateSwitch().disabled).toBe(false);
    expect(gateSwitch().getAttribute('aria-checked')).toBe('true');
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
