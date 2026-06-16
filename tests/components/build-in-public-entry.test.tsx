// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { ToastProvider } from '@/components/ui/Toast';

// The discoverable build-in-public entry points (Story 6.17 · Subtask 6.17.3 ·
// design/public-projects Panel 10): the PRIMARY project-shell header button and
// the durable Settings → General promo card. Both open the reusable 6.17.2
// explainer/confirm dialog and, on confirm, run the shared `useGoPublic` write —
// PATCH /api/projects/[key]/access with accessLevel:'public', then toast +
// router.refresh (server-gated visibility, so the refresh is the whole
// page-state-after-mutation story).
// (The Panel-10b shell nudge is deferred — a global content-flow banner above
// the dnd board pushes swimlane drop targets off-screen; see the PR notes.)

const { refreshSpy } = vi.hoisted(() => ({ refreshSpy: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshSpy }),
}));

import { BuildInPublicButton } from '@/app/(authed)/_components/build-in-public/BuildInPublicButton';
import { BuildInPublicPromoCard } from '@/app/(authed)/settings/project/_components/BuildInPublicPromoCard';

function withToast(ui: React.ReactElement) {
  return <ToastProvider>{ui}</ToastProvider>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('BuildInPublicButton (PRIMARY header entry)', () => {
  it('opens the explainer/confirm dialog on click — never flips access on render', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    render(withToast(<BuildInPublicButton projectKey="MOTIR" />));

    // The promoted action labelled "Build in public"; the dialog is closed.
    expect(screen.getByRole('button', { name: 'Build in public' })).toBeTruthy();
    expect(screen.queryByText('Start building in public?')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Build in public' }));
    expect(screen.getByText('Start building in public?')).toBeTruthy();
    // Opening alone does not write.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('confirming PATCHes access to public, then toasts + router.refresh()', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    render(withToast(<BuildInPublicButton projectKey="MOTIR" />));

    fireEvent.click(screen.getByRole('button', { name: 'Build in public' }));
    // The dialog's footer CTA reads the same "Start building in public".
    fireEvent.click(screen.getByRole('button', { name: 'Start building in public' }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/projects/MOTIR/access');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ accessLevel: 'public' });
    await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));
  });

  it('does not refresh when the access write fails', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal('fetch', fetchSpy);
    render(withToast(<BuildInPublicButton projectKey="MOTIR" />));

    fireEvent.click(screen.getByRole('button', { name: 'Build in public' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start building in public' }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});

describe('BuildInPublicPromoCard (durable settings entry)', () => {
  it('renders the pitch + opens the confirm dialog from the primary CTA', () => {
    render(withToast(<BuildInPublicPromoCard projectKey="MOTIR" />));
    expect(screen.getByText('Build this project in public')).toBeTruthy();
    expect(screen.getByText(/indexable by search engines/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Start building in public' }));
    expect(screen.getByText('Start building in public?')).toBeTruthy();
  });

  it('renders the native zh copy when the locale is zh', () => {
    render(withToast(<BuildInPublicPromoCard projectKey="MOTIR" />), {
      locale: 'zh',
      messages: zhMessages,
    });
    expect(screen.getByText('公开构建这个项目')).toBeTruthy();
    expect(screen.getByText('了解更多')).toBeTruthy();
  });
});
