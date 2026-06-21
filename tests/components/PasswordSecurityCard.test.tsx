// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';

// Component test for the Account › Profile pane's PasswordSecurityCard (Subtask
// 8.8.24c). Proves the two-branch UX: the credential user's change-password
// modal (success toast + the typed-error mappings — wrong current password,
// validation, mismatch) and the OAuth-only user's send-set-password-link path
// (link-sent confirmation). The server actions are mocked (their own DB / auth
// behaviour is covered by tests/account-profile-actions.test.ts against real
// Postgres).

const { changeSpy, sendLinkSpy } = vi.hoisted(() => ({
  changeSpy: vi.fn(),
  sendLinkSpy: vi.fn(),
}));

vi.mock('@/app/(authed)/settings/account/profile/actions', () => ({
  changePasswordAction: changeSpy,
  sendSetPasswordLinkAction: sendLinkSpy,
}));

import { PasswordSecurityCard } from '@/app/(authed)/settings/account/_components/PasswordSecurityCard';

function renderCard(hasPassword: boolean) {
  return render(
    <ToastProvider>
      <PasswordSecurityCard hasPassword={hasPassword} />
    </ToastProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Open the change-password modal and fill the three fields.
async function openModalAndFill(values: { current: string; next: string; confirm: string }) {
  fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
  await screen.findByRole('dialog');
  fireEvent.change(screen.getByLabelText('Current password'), {
    target: { value: values.current },
  });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: values.next } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), {
    target: { value: values.confirm },
  });
}

describe('PasswordSecurityCard — credential user (hasPassword)', () => {
  it('renders the Change password control', () => {
    renderCard(true);
    expect(screen.getByText('Password & security')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change password' })).toBeTruthy();
  });

  it('changes the password on valid input and shows the success toast', async () => {
    changeSpy.mockResolvedValue({ ok: true, revokedSessions: 0 });
    renderCard(true);

    await openModalAndFill({
      current: 'oldpassword',
      next: 'newpassword1',
      confirm: 'newpassword1',
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Update password' }));
    });

    await waitFor(() =>
      expect(changeSpy).toHaveBeenCalledWith({
        currentPassword: 'oldpassword',
        newPassword: 'newpassword1',
      }),
    );
    // Success → toast + modal closed.
    await screen.findByText('Password updated');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows a field error when the current password is wrong', async () => {
    changeSpy.mockResolvedValue({ ok: false, code: 'WRONG_CURRENT_PASSWORD' });
    renderCard(true);

    await openModalAndFill({ current: 'wrongpass', next: 'newpassword1', confirm: 'newpassword1' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Update password' }));
    });

    await screen.findByText('The current password is incorrect.');
    // Modal stays open on error.
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('validates the new-password length client-side without calling the action', async () => {
    renderCard(true);
    await openModalAndFill({ current: 'oldpassword', next: 'short', confirm: 'short' });
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }));

    await screen.findByText('New password must be at least 8 characters.');
    expect(changeSpy).not.toHaveBeenCalled();
  });

  it('flags a confirm mismatch client-side without calling the action', async () => {
    renderCard(true);
    await openModalAndFill({ current: 'oldpassword', next: 'newpassword1', confirm: 'different1' });
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }));

    await screen.findByText("Those passwords don't match.");
    expect(changeSpy).not.toHaveBeenCalled();
  });
});

describe('PasswordSecurityCard — OAuth-only user (!hasPassword)', () => {
  it('renders the Google sign-in callout and the send-link button', () => {
    renderCard(false);
    expect(screen.getByText(/You sign in with/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send a password-reset link' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Change password' })).toBeNull();
  });

  it('sends the set-password link and shows the confirmation', async () => {
    sendLinkSpy.mockResolvedValue({ ok: true });
    renderCard(false);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send a password-reset link' }));
    });

    await waitFor(() => expect(sendLinkSpy).toHaveBeenCalledTimes(1));
    // Toast + inline confirmation; the button is replaced by the confirmation.
    await screen.findByText('Reset link sent');
    await screen.findByText(/check your inbox to set a password/i);
    expect(screen.queryByRole('button', { name: 'Send a password-reset link' })).toBeNull();
  });
});
