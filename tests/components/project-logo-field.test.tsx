// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { PROJECT_IMAGE_MAX_BYTES } from '@/lib/projects/imageUpload';

// The project LOGO row (MOTIR-2678). Three things are worth asserting and only
// one of them is the happy path:
//
//   1. THE EMPTY STATE RENDERS NOTHING — no image, no placeholder box, no
//      monogram, and no LABEL. That is the visible half of
//      docs/decisions/entity-marks.md §3 and the thing a later well-meant commit
//      is most likely to soften.
//   2. Both client rejections fire WITHOUT a network call, against the same
//      constants the server enforces.
//   3. Remove is gated by the confirm, and only exists when there is something
//      to remove.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const updateLogo = vi.fn();
vi.mock('@/app/(authed)/settings/project/actions', () => ({
  updateProjectLogoAction: (...args: unknown[]) => updateLogo(...args),
}));

const { ProjectLogoField } =
  await import('@/app/(authed)/settings/project/_components/ProjectLogoField');

function render(initialLogo: string | null) {
  return renderWithIntl(
    <ToastProvider>
      <ProjectLogoField initialLogo={initialLogo} projectIdentifier="PROD" />
    </ToastProvider>,
  );
}

function pick(file: File) {
  const input = screen.getByTestId('project-logo-input');
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  refresh.mockClear();
  updateLogo.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ProjectLogoField', () => {
  it('renders NOTHING for a project with no logo — no image, no placeholder, no label', () => {
    const { container } = render(null);

    expect(container.querySelector('img')).toBeNull();
    // The one control, and it carries the noun because nothing else can.
    expect(screen.getByRole('button', { name: 'Upload logo' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    // No label text anywhere in the row — not "Image", not "Logo".
    expect(container.textContent).not.toMatch(/\bImage\b/);
    expect(container.textContent).not.toMatch(/^Logo/);
  });

  it('renders the logo and both controls when one is set', () => {
    render('https://cdn.test.invalid/projects/p1/logo.png');

    const img = screen.getByAltText('Project logo') as HTMLImageElement;
    expect(img.src).toContain('/projects/p1/logo.png');
    // With a picture beside it the button needs no noun.
    expect(screen.getByRole('button', { name: 'Change' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
  });

  it('rejects a wrong type on the client, with NO request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(null);

    pick(new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }));

    expect(await screen.findByText(/not supported/i)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(updateLogo).not.toHaveBeenCalled();
  });

  it('rejects an over-ceiling file on the client, with NO request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(null);

    pick(new File([new Uint8Array(PROJECT_IMAGE_MAX_BYTES + 1)], 'big.png', { type: 'image/png' }));

    expect(await screen.findByText(/over 2 MB/i)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(updateLogo).not.toHaveBeenCalled();
  });

  it('uploads, persists the returned KEY, and shows the resolved URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ key: 'projects/p1/logo-abc.png' }), { status: 200 }),
    );
    updateLogo.mockResolvedValue({
      ok: true,
      image: 'https://cdn.test.invalid/projects/p1/logo-abc.png',
    });
    render(null);

    pick(new File([new Uint8Array(8)], 'logo.png', { type: 'image/png' }));

    await waitFor(() => expect(updateLogo).toHaveBeenCalledWith('projects/p1/logo-abc.png'));
    const img = (await screen.findByAltText('Project logo')) as HTMLImageElement;
    expect(img.src).toContain('logo-abc.png');
    // The server-rendered surfaces (top bar, settings rail) must be told too.
    expect(refresh).toHaveBeenCalled();
  });

  it('leaves the existing logo in place when the persist fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ key: 'projects/p1/new.png' }), { status: 200 }),
    );
    updateLogo.mockResolvedValue({ ok: false, code: 'UNKNOWN' });
    render('https://cdn.test.invalid/projects/p1/old.png');

    pick(new File([new Uint8Array(8)], 'new.png', { type: 'image/png' }));

    expect(await screen.findByText(/Couldn’t update/i)).toBeTruthy();
    expect((screen.getByAltText('Project logo') as HTMLImageElement).src).toContain('old.png');
  });

  it('the Upload button opens the file picker — the hidden input is not decorative', () => {
    render(null);
    const input = screen.getByTestId('project-logo-input') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');

    fireEvent.click(screen.getByRole('button', { name: 'Upload logo' }));

    // Without this the row LOOKS complete and does nothing at all when pressed —
    // the input is `hidden`, so there is no second way in.
    expect(click).toHaveBeenCalled();
  });

  it('the confirm cannot be dismissed while the remove is IN FLIGHT', async () => {
    // A destructive action that is already running must not be escapable: closing
    // the dialog would leave the person with no indication of what happened to
    // the request they started, and the row updates underneath them either way.
    let settle: (v: { ok: true; image: null }) => void = () => {};
    updateLogo.mockReturnValue(
      new Promise<{ ok: true; image: null }>((resolve) => {
        settle = resolve;
      }),
    );
    render('https://cdn.test.invalid/projects/p1/logo.png');

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove logo' }));
    await waitFor(() => expect(updateLogo).toHaveBeenCalledWith(null));

    // Escape while the transition is pending — the dialog holds.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.getByText('Remove project logo?')).toBeTruthy();

    // …and once it resolves, it closes on its own.
    await act(async () => {
      settle({ ok: true, image: null });
    });
    await waitFor(() => expect(screen.queryByText('Remove project logo?')).toBeNull());
  });

  // ── The failure arms MOTIR-2681 measured as uncovered ────────────────────
  // Coverage put this file at 79% branches / 75% functions before these four:
  // every one of them is a path where something went wrong, which is exactly
  // the half of a row nobody exercises by hand.

  it('a cancelled file picker fires the change event with NO file — and does nothing', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(null);

    // Dismissing the OS dialog fires `change` with an empty FileList. Treating
    // that as an upload would either throw or POST an empty body.
    fireEvent.change(screen.getByTestId('project-logo-input'), { target: { files: [] } });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(updateLogo).not.toHaveBeenCalled();
  });

  it('shows the error and keeps the old logo when the UPLOAD ROUTE refuses', async () => {
    // The server's own gate firing — an over-ceiling file the client somehow let
    // through, a type it rejects, a revoked permission. The client pre-checks are
    // a courtesy; this is the arm that runs when the authority disagrees.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'nope' }), { status: 400 }),
    );
    render('https://cdn.test.invalid/projects/p1/old.png');

    pick(new File([new Uint8Array(8)], 'new.png', { type: 'image/png' }));

    expect(await screen.findByText(/Couldn’t update/i)).toBeTruthy();
    // Never persisted, and the row still shows what it showed before.
    expect(updateLogo).not.toHaveBeenCalled();
    expect((screen.getByAltText('Project logo') as HTMLImageElement).src).toContain('old.png');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('survives a THROWN request — a dropped connection is an error toast, not a crash', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    render(null);

    pick(new File([new Uint8Array(8)], 'logo.png', { type: 'image/png' }));

    expect(await screen.findByText(/Couldn’t update/i)).toBeTruthy();
    // And the control is usable again: the `finally` cleared the in-flight flag,
    // so a person can retry without reloading the page.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Upload logo' }).hasAttribute('disabled')).toBe(
        false,
      ),
    );
  });

  it('keeps the logo AND the open modal when the REMOVE fails', async () => {
    // The destructive arm's failure. Closing the modal on a failed remove would
    // read as success, and the logo would appear to come back on the next load.
    updateLogo.mockResolvedValue({ ok: false, code: 'NOT_ADMIN' });
    render('https://cdn.test.invalid/projects/p1/logo.png');

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove logo' }));

    await waitFor(() => expect(updateLogo).toHaveBeenCalledWith(null));
    expect(await screen.findByText(/Couldn’t update/i)).toBeTruthy();
    expect(screen.getByAltText('Project logo')).toBeTruthy();
    expect(screen.getByText('Remove project logo?')).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('gates Remove behind the confirm, and clears on confirm', async () => {
    updateLogo.mockResolvedValue({ ok: true, image: null });
    render('https://cdn.test.invalid/projects/p1/logo.png');

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Remove project logo?')).toBeTruthy();
    // Cancelling changes nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(updateLogo).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove logo' }));

    await waitFor(() => expect(updateLogo).toHaveBeenCalledWith(null));
    await waitFor(() => expect(screen.queryByAltText('Project logo')).toBeNull());
    expect(screen.getByRole('button', { name: 'Upload logo' })).toBeTruthy();
  });
});
