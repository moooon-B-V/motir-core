// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { AcceptanceVideoGateCard } from '@/app/(authed)/settings/project/approvals/_components/AcceptanceVideoGateCard';

// Task MOTIR-5278 — the switch is never OFFERED to an actor the server refuses.
//
// The Approvals room opens on `project:browse` now (`design/projects/design-notes.md`
// § ⭐ Approvals §6), so this card renders for members the PATCH refuses. Before
// `canManage`, such a member would click, watch the switch flip optimistically,
// and then watch it snap back on a 403 — a control that lies for a moment and
// then apologises. The page reads `canManage` off the registry's WRITE key; this
// suite pins what the card does with each value.
//
// Out of scope, and deliberately unasserted: the read-only FOOTER that explains
// why, and `Unavailable` — both are MOTIR-5171's.

function renderCard({
  canManage,
  initialEnabled,
}: {
  canManage: boolean;
  initialEnabled: boolean;
}) {
  return renderWithIntl(
    <ToastProvider>
      <AcceptanceVideoGateCard
        projectKey="MOTIR"
        initialEnabled={initialEnabled}
        canManage={canManage}
      />
    </ToastProvider>,
  );
}

const gateSwitch = () =>
  screen.getByRole('switch', { name: 'Acceptance video approval' }) as HTMLButtonElement;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AcceptanceVideoGateCard — `canManage` (MOTIR-5278)', () => {
  it('an actor holding the WRITE key is offered a LIVE switch showing the stored state', () => {
    renderCard({ canManage: true, initialEnabled: true });
    expect(gateSwitch().disabled).toBe(false);
    expect(gateSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('an actor WITHOUT it sees the stored state on a DISABLED switch', () => {
    renderCard({ canManage: false, initialEnabled: false });
    expect(gateSwitch().disabled).toBe(true);
    expect(gateSwitch().getAttribute('aria-checked')).toBe('false');
    // The state line still tells them what their project asks — reading it is
    // the point of letting them in.
    expect(screen.getByText('Off')).toBeTruthy();
  });

  it('a click on the disabled switch sends NOTHING and changes nothing — no optimistic flip to revert', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    renderCard({ canManage: false, initialEnabled: true });

    fireEvent.click(gateSwitch());

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(gateSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('CONTROL: the same click with the write key DOES send the PATCH', async () => {
    const fetchSpy = vi.fn(async () => Response.json({ acceptanceVideoEnabled: false }));
    vi.stubGlobal('fetch', fetchSpy);
    renderCard({ canManage: true, initialEnabled: true });

    fireEvent.click(gateSwitch());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Off')).toBeTruthy();
  });
});
