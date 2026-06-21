// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';

// Component test for the Account › Profile pane's AvatarField (Subtask 8.8.24a).
// Proves the Photo-row UX: initials fallback → upload (client validation +
// /api/upload/avatar + updateProfileAvatarAction + optimistic keep +
// router.refresh) → remove (confirm modal). The upload route (fetch) and the
// server action are mocked; the action's own DB behaviour is covered against
// real Postgres in tests/account-profile-actions.test.ts.

const { avatarSpy, refresh } = vi.hoisted(() => ({
  avatarSpy: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock('@/app/(authed)/settings/account/profile/actions', () => ({
  updateProfileAvatarAction: avatarSpy,
}));

import { AvatarField } from '@/app/(authed)/settings/account/_components/AvatarField';

function renderField(props?: { initialImage?: string | null; name?: string }) {
  return render(
    <ToastProvider>
      <AvatarField initialImage={props?.initialImage ?? null} name={props?.name ?? 'Zhu Yue'} />
    </ToastProvider>,
  );
}

function pngFile(name = 'me.png', bytes = 1024) {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' });
}

function selectFile(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  // happy-dom won't let us assign `files` directly; define it on the element.
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('AvatarField', () => {
  it('renders the initials fallback and only a Change control when no image', () => {
    renderField({ name: 'Zhu Yue', initialImage: null });
    expect(screen.getByText('Z')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Change/ })).toBeTruthy();
    // Remove only appears once an image is set.
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
  });

  it('renders the uploaded image and a Remove control when an image is set', () => {
    renderField({ initialImage: 'https://blob.example/avatars/u1/me.png' });
    const img = screen.getByAltText('Your avatar') as HTMLImageElement;
    expect(img.src).toContain('/avatars/u1/me.png');
    expect(screen.getByRole('button', { name: /Remove/ })).toBeTruthy();
  });

  it('uploads a valid file, then persists the returned url and refreshes', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'https://blob.example/avatars/u1/me.png' }),
    });
    avatarSpy.mockResolvedValue({ ok: true, image: 'https://blob.example/avatars/u1/me.png' });

    renderField({ initialImage: null });
    await act(async () => {
      selectFile(pngFile());
    });

    await waitFor(() =>
      expect(avatarSpy).toHaveBeenCalledWith('https://blob.example/avatars/u1/me.png'),
    );
    expect(fetch).toHaveBeenCalledWith(
      '/api/upload/avatar',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(refresh).toHaveBeenCalled();
    // The optimistic image now renders + the Remove control appears.
    expect(screen.getByAltText('Your avatar')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Remove/ })).toBeTruthy();
  });

  it('rejects a too-large file on the client without calling the upload route', async () => {
    renderField({ initialImage: null });
    await act(async () => {
      selectFile(pngFile('big.png', 3 * 1024 * 1024)); // 3 MB > 2 MB cap
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(avatarSpy).not.toHaveBeenCalled();
    expect(await screen.findByText('Image must be 2 MB or smaller.')).toBeTruthy();
  });

  it('rejects a non-image file type on the client', async () => {
    renderField({ initialImage: null });
    const pdf = new File([new Uint8Array(10)], 'doc.pdf', { type: 'application/pdf' });
    await act(async () => {
      selectFile(pdf);
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(avatarSpy).not.toHaveBeenCalled();
    expect(await screen.findByText('Choose a PNG or JPG image.')).toBeTruthy();
  });

  it('removes the avatar after confirming in the modal', async () => {
    avatarSpy.mockResolvedValue({ ok: true, image: null });
    renderField({ initialImage: 'https://blob.example/avatars/u1/me.png' });

    fireEvent.click(screen.getByRole('button', { name: /Remove/ }));
    // The confirm modal appears; click its destructive confirm (scope to the
    // dialog — the row's "Remove" button shares the accessible name).
    const dialog = await screen.findByRole('alertdialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    });

    await waitFor(() => expect(avatarSpy).toHaveBeenCalledWith(null));
    expect(refresh).toHaveBeenCalled();
    // Back to initials; Remove control gone.
    await waitFor(() => expect(screen.getByText('Z')).toBeTruthy());
  });

  it('surfaces an error toast when the upload route fails', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, json: async () => ({}) });
    renderField({ initialImage: null });
    await act(async () => {
      selectFile(pngFile());
    });
    expect(await screen.findByText("Couldn't update your photo. Try again.")).toBeTruthy();
    expect(avatarSpy).not.toHaveBeenCalled();
  });
});
