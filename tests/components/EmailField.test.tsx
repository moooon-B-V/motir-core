// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';

// Component test for the Account › Profile pane's Email row (Story 8.8 · Subtask
// 8.8.24b): the EmailField (resting → pending) hosting the ChangeEmailModal.
// Proves the change-with-confirmation UX — open the modal, client-side
// validation, the 8.8.22 endpoint wiring (mocked at the thin fetch client), the
// email-taken server error in the inline box, and the confirmation-pending banner
// + toast on success (the page-state contract: a client island, no tree refresh).
// The route's own DB behaviour is covered by the 8.8.22 backend tests.

const { requestEmailChange } = vi.hoisted(() => ({ requestEmailChange: vi.fn() }));

// Mock only the network call; keep the REAL EmailChangeError class so the
// modal's `err instanceof EmailChangeError` branch resolves the typed code.
vi.mock('@/app/(authed)/settings/account/profile/emailChangeClient', async (importActual) => {
  const actual =
    await importActual<
      typeof import('@/app/(authed)/settings/account/profile/emailChangeClient')
    >();
  return { ...actual, requestEmailChange };
});

import { EmailField } from '@/app/(authed)/settings/account/_components/EmailField';
import { EmailChangeError } from '@/app/(authed)/settings/account/profile/emailChangeClient';

function renderField(email = 'zhuyue@motir.co') {
  return render(
    <ToastProvider>
      <EmailField email={email} />
    </ToastProvider>,
  );
}

/** Open the modal and type `value` into the New email field. */
function openAndType(value: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Change email' }));
  fireEvent.change(screen.getByLabelText('New email'), { target: { value } });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('EmailField', () => {
  it('renders the current email and the Change email control at rest', () => {
    renderField();
    expect(screen.getByText('zhuyue@motir.co')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change email' })).toBeTruthy();
  });

  it('rejects a malformed address client-side without calling the endpoint', async () => {
    renderField();
    openAndType('not-an-email');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send confirmation' }));
    });
    expect(screen.getByText('Enter a valid email address.')).toBeTruthy();
    expect(requestEmailChange).not.toHaveBeenCalled();
  });

  it('rejects the current address as SAME client-side', async () => {
    renderField();
    openAndType('ZhuYue@motir.co'); // case-insensitive match of the current email
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send confirmation' }));
    });
    expect(screen.getByText("That's already your email address.")).toBeTruthy();
    expect(requestEmailChange).not.toHaveBeenCalled();
  });

  it('surfaces the email-taken server error in the inline box and stays open', async () => {
    requestEmailChange.mockRejectedValue(new EmailChangeError('EMAIL_TAKEN'));
    renderField();
    openAndType('yue@acme.com');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send confirmation' }));
    });
    expect(requestEmailChange).toHaveBeenCalledWith('yue@acme.com');
    expect(
      await screen.findByText('That email is already in use by another account.'),
    ).toBeTruthy();
    // Still in the modal — the new-email field is present.
    expect(screen.getByLabelText('New email')).toBeTruthy();
  });

  it('shows the confirmation-pending banner and closes the modal on success', async () => {
    requestEmailChange.mockResolvedValue(undefined);
    renderField();
    openAndType('yue@acme.com');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send confirmation' }));
    });
    expect(requestEmailChange).toHaveBeenCalledWith('yue@acme.com');
    // Pending banner: the new address + the helper + Resend/Cancel actions.
    await waitFor(() => expect(screen.getByText('Pending → yue@acme.com')).toBeTruthy());
    expect(screen.getByText('Confirmation sent. Applies once confirmed.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resend' })).toBeTruthy();
    // The old address is shown struck-through; the modal has closed.
    expect(screen.getByText('zhuyue@motir.co')).toBeTruthy();
    expect(screen.queryByLabelText('New email')).toBeNull();
  });

  it('Cancel dismisses the local pending banner back to rest', async () => {
    requestEmailChange.mockResolvedValue(undefined);
    renderField();
    openAndType('yue@acme.com');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send confirmation' }));
    });
    await waitFor(() => expect(screen.getByText('Pending → yue@acme.com')).toBeTruthy());
    // The modal has closed on success, so the pending banner's Cancel
    // (a link-styled button) is the only "Cancel" left — it clears the banner.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    await waitFor(() => expect(screen.queryByText('Pending → yue@acme.com')).toBeNull());
    expect(screen.getByRole('button', { name: 'Change email' })).toBeTruthy();
  });
});
