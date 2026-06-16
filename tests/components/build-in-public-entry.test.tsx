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
import { BuildingInPublicHeaderLink } from '@/app/(authed)/_components/build-in-public/BuildingInPublicHeaderLink';
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

// The PUBLIC-state of the same header slot (Subtask 6.17.7 · design
// design/public-projects §6.17.6 · Panel 12): once a project IS building in
// public the slot becomes a clickable "Building in public" status indicator
// that links to the build-in-public settings (/settings/project/members), shown
// to all team members. It is a plain server-rendered <a> (no client write), so
// these render as a link — the toggle between the two slot states is asserted
// via their mutual exclusivity (the single slot shows exactly one, never both).
describe('BuildingInPublicHeaderLink (PUBLIC-state header indicator)', () => {
  it('renders the "Building in public" status indicator as a link to the manage settings', () => {
    render(<BuildingInPublicHeaderLink />);

    const link = screen.getByRole('link', { name: 'Building in public — manage' });
    expect(link).toBeTruthy();
    // Links to the build-in-public manage/stop home (View public page / Stop).
    expect(link.getAttribute('href')).toBe('/settings/project/members');
    // The visible status text is the same string the badge uses; the trailing
    // settings gear is decorative (aria-hidden), so the accessible name is the
    // single aria-label, not "Building in public — manage Building in public".
    expect(link.textContent).toContain('Building in public');
  });

  it('renders the native zh copy + accessible name when the locale is zh', () => {
    render(<BuildingInPublicHeaderLink />, { locale: 'zh', messages: zhMessages });

    const link = screen.getByRole('link', { name: '公开构建中 · 管理' });
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/settings/project/members');
  });

  // The single stateful slot shows exactly ONE affordance — never both. The
  // non-public state is the CTA button (no manage link); the public state is the
  // linked indicator (no CTA button).
  it('is mutually exclusive with the non-public CTA — the slot never shows both', () => {
    // Non-public state: the CTA button, and NO manage link.
    const { unmount } = render(withToast(<BuildInPublicButton projectKey="MOTIR" />));
    expect(screen.getByRole('button', { name: 'Build in public' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Building in public — manage' })).toBeNull();
    unmount();

    // Public state: the linked indicator, and NO CTA button.
    render(<BuildingInPublicHeaderLink />);
    expect(screen.getByRole('link', { name: 'Building in public — manage' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Build in public' })).toBeNull();
  });
});
