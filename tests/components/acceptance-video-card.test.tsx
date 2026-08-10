// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { hasAiEntitlement } from '@/lib/billing/aiEntitlement';
import type { AiAccessDTO } from '@/lib/dto/aiAccess';

// AcceptanceVideoCard (Story MOTIR-1627 · Subtask MOTIR-1635) — the org settings
// toggle card, in happy-dom. The PATCH + router are mocked.

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { AcceptanceVideoCard } =
  await import('@/app/(authed)/settings/organization/_components/AcceptanceVideoCard');

function renderCard(props: Parameters<typeof AcceptanceVideoCard>[0]) {
  return render(
    <ToastProvider>
      <AcceptanceVideoCard {...props} />
    </ToastProvider>,
  );
}

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

describe('AcceptanceVideoCard', () => {
  it('with a plan → an enabled switch that PATCHes the org toggle', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });
    renderCard({ orgId: 'org_1', initialEnabled: true, hasPlan: true, canManage: true });
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.getAttribute('disabled')).toBeNull();

    fireEvent.click(sw);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/organizations/org_1',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body).toEqual({ acceptanceVideoEnabled: false });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('no plan → the switch is disabled and an Upgrade CTA links to billing', () => {
    renderCard({ orgId: 'org_1', initialEnabled: true, hasPlan: false, canManage: true });
    expect(screen.getByRole('switch').getAttribute('disabled')).not.toBeNull();
    expect(screen.getByText('Requires a paid Motir AI plan')).toBeTruthy();
    expect(screen.getByRole('link', { name: /upgrade/i }).getAttribute('href')).toBe(
      '/settings/organization/billing',
    );
  });

  it('a non-admin cannot flip it (disabled)', () => {
    renderCard({ orgId: 'org_1', initialEnabled: true, hasPlan: true, canManage: false });
    expect(screen.getByRole('switch').getAttribute('disabled')).not.toBeNull();
  });

  // MOTIR-2545 — the two tests above prove the card renders whatever `hasPlan`
  // it is handed. The defect was one layer up: the page DERIVED that flag by
  // reading `hasPaidAiPlan` off the inert not-applicable sentinel, so a `meta`
  // organization — exempt from the paywall — was handed `false`. These two run
  // the real derivation into the real card, which is the seam neither half
  // could see on its own.
  describe('the entitlement derivation the page performs', () => {
    const sentinel: AiAccessDTO = {
      applicable: false,
      organizationId: null,
      organizationName: null,
      canManageBilling: false,
      hasPaidAiPlan: false,
      balance: 0,
      tierName: null,
      tierAllotment: null,
      renewsAt: null,
    };

    it('an EXEMPT org (meta / self-host) gets no upsell and a working switch', () => {
      renderCard({
        orgId: 'org_meta',
        initialEnabled: true,
        hasPlan: hasAiEntitlement(sentinel),
        canManage: true,
      });

      expect(screen.queryByText('Requires a paid Motir AI plan')).toBeNull();
      expect(screen.queryByRole('link', { name: /upgrade/i })).toBeNull();
      expect(screen.getByRole('switch').getAttribute('disabled')).toBeNull();
      // And it reflects the STORED value rather than reading Off: `checked` is
      // `enabled && hasPlan`, so a wrong derivation showed the org's own setting
      // as off no matter what the database said.
      expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
    });

    it('a cloud org on no paid plan still gets the upsell and the disabled switch', () => {
      const cloudNoPlan: AiAccessDTO = {
        ...sentinel,
        applicable: true,
        organizationId: 'org_1',
        organizationName: 'Acme',
        canManageBilling: true,
      };

      renderCard({
        orgId: 'org_1',
        initialEnabled: true,
        hasPlan: hasAiEntitlement(cloudNoPlan),
        canManage: true,
      });

      expect(screen.getByText('Requires a paid Motir AI plan')).toBeTruthy();
      expect(screen.getByRole('switch').getAttribute('disabled')).not.toBeNull();
    });
  });
});
