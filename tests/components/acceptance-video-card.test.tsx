// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';

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
});
