// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';

// Component test for the Account › Profile pane's ProfileCard (Subtask 8.8.24,
// the scaffold). Proves the inline-edit UX: display → edit → empty-validation →
// successful save (optimistic keep + router.refresh for the server-rendered rail
// header). The server action is mocked (the action's own DB behaviour is covered
// by tests/account-profile-actions.test.ts against real Postgres).

const { updateSpy, refresh } = vi.hoisted(() => ({
  updateSpy: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock('@/app/(authed)/settings/account/profile/actions', () => ({
  updateProfileNameAction: updateSpy,
}));

import { ProfileCard } from '@/app/(authed)/settings/account/_components/ProfileCard';

function renderCard(props?: {
  initialName?: string;
  initialImage?: string | null;
  email?: string;
}) {
  return render(
    <ToastProvider>
      <ProfileCard
        initialName={props?.initialName ?? 'Zhu Yue'}
        initialImage={props?.initialImage ?? null}
        email={props?.email ?? 'zhuyue@motir.co'}
      />
    </ToastProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProfileCard', () => {
  it('renders the name and email display rows', () => {
    renderCard();
    expect(screen.getByText('Zhu Yue')).toBeTruthy();
    expect(screen.getByText('zhuyue@motir.co')).toBeTruthy();
    // Email is display-only in the scaffold — no edit affordance on it.
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
  });

  it('shows a validation error and does not call the action for an empty name', async () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const input = screen.getByLabelText('Name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(screen.getByText("Name can't be empty.")).toBeTruthy();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('saves a new name optimistically and refreshes the server header', async () => {
    updateSpy.mockResolvedValue({ ok: true, name: 'New Name' });
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const input = screen.getByLabelText('Name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'New Name' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(updateSpy).toHaveBeenCalledWith('New Name');
    await waitFor(() => expect(screen.getByText('New Name')).toBeTruthy());
    // The cell keeps the optimistic value AND the server-rendered rail header is
    // refreshed (page-state contract: client island + server surface).
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('surfaces a server-side INVALID_NAME error without changing the value', async () => {
    updateSpy.mockResolvedValue({ ok: false, code: 'INVALID_NAME', message: 'Name is required.' });
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(await screen.findByText('Name is required.')).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });
});
