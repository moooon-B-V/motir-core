// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PublicSubdomainCard } from '@/app/(authed)/settings/project/public-address/_components/PublicSubdomainCard';
import type { PublicSubdomainDto } from '@/lib/dto/publicAddresses';

// THE WORKSPACE SUBDOMAIN CARD (Story MOTIR-3878 · MOTIR-4221) — design panels
// 1, 2 and 8, rendered.
//
// ⚠️ THE FOUR STATES ARE THE POINT, and three of them are reachable only by
// combining two inputs that come from DIFFERENT axes: whether a subdomain
// exists (the store) and whether the actor may change it (the WORKSPACE role,
// not the project permission the rail row is gated on). Panel 8 is the pair
// nobody would think to try — a claimed address the reader may not touch.

const refreshMock = vi.fn();
vi.mock('next/navigation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/navigation')>();
  return { ...actual, useRouter: () => ({ refresh: refreshMock, push: vi.fn() }) };
});

const toastMock = vi.fn();
vi.mock('@/components/ui/Toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/Toast')>();
  return { ...actual, useToast: () => ({ toast: toastMock }) };
});

const claimed: PublicSubdomainDto = {
  label: 'acme',
  hostname: 'acme.motir.site',
  url: 'https://acme.motir.site',
  claimedAt: '2026-09-01T00:00:00.000Z',
  aliases: [{ hostname: 'acme-old.motir.site', retiredAt: '2026-09-02T00:00:00.000Z' }],
  renamesLeft: 4,
};

function render(opts: { subdomain?: PublicSubdomainDto | null; canManage?: boolean } = {}) {
  return renderWithIntl(
    <PublicSubdomainCard
      workspaceId="ws_1"
      baseDomain="motir.site"
      projectIdentifier="ROADMAP"
      subdomain={opts.subdomain ?? null}
      canManage={opts.canManage ?? true}
    />,
  );
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  refreshMock.mockReset();
  toastMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('panel 1 — no subdomain claimed', () => {
  it('offers the field with a LIVE preview of the address being typed', () => {
    render();
    const field = screen.getByLabelText('Subdomain');
    fireEvent.change(field, { target: { value: 'acme' } });
    // The preview is the whole point of the field: it shows the address the
    // customer is about to own, path included.
    expect(screen.getByText(/acme\.motir\.site\/ROADMAP/)).toBeTruthy();
  });

  it('refuses to submit an empty label rather than asking the server', () => {
    render();
    expect(screen.getByRole('button', { name: 'Claim subdomain' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('says a RESERVED name is reserved, and a MALFORMED one is malformed', async () => {
    // ⚠️ THE DISCRIMINATOR EARNS ITS PLACE HERE. Telling someone `Admin` is
    // "reserved" sends them looking for a different name they do not need — the
    // real problem is the capital letter. MOTIR-4215 put `refusal` on the wire
    // for this, and one merged sentence would throw it away.
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ code: 'RESERVED_LABEL', refusal: 'reserved' }),
    });
    render();
    fireEvent.change(screen.getByLabelText('Subdomain'), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Claim subdomain' }));
    await waitFor(() => expect(screen.getByText(/is reserved/)).toBeTruthy());

    cleanup();
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ code: 'RESERVED_LABEL', refusal: 'bad_grammar' }),
    });
    render();
    fireEvent.change(screen.getByLabelText('Subdomain'), { target: { value: 'Admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Claim subdomain' }));
    await waitFor(() => expect(screen.getByText(/Lowercase letters/)).toBeTruthy());
  });

  it('CLEARS the refusal as soon as the label is edited, so the preview comes back', async () => {
    // ⚠️ THE `Input` RENDERS `error` INSTEAD OF `helperText`, so a refusal that
    // survived typing takes the LIVE PREVIEW away — the customer fixes the label
    // and is still looking at the old complaint, with no sight of the address
    // they are about to own. Found by the acceptance walk, which is the only
    // test that types twice.
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ code: 'RESERVED_LABEL', refusal: 'reserved' }),
    });
    render();
    fireEvent.change(screen.getByLabelText('Subdomain'), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Claim subdomain' }));
    await waitFor(() => expect(screen.getByText(/is reserved/)).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Subdomain'), { target: { value: 'acme' } });
    expect(screen.queryByText(/is reserved/)).toBeNull();
    expect(screen.getByText(/acme\.motir\.site\/ROADMAP/)).toBeTruthy();
  });

  it('explains a TAKEN name as a fact about somebody else, alias included', async () => {
    // The second sentence exists because *taken* and *taken by a retired alias*
    // are indistinguishable to the claimer, and the honest answer is to say so.
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ code: 'HOSTNAME_TAKEN' }),
    });
    render();
    fireEvent.change(screen.getByLabelText('Subdomain'), { target: { value: 'acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Claim subdomain' }));
    await waitFor(() => expect(screen.getByText(/already in use/)).toBeTruthy());
    expect(screen.getByText(/renamed away from also keeps its name/)).toBeTruthy();
  });

  it('re-reads on success rather than patching what it derived', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => claimed });
    render();
    fireEvent.change(screen.getByLabelText('Subdomain'), { target: { value: 'acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Claim subdomain' }));
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/workspaces/ws_1/public-subdomain');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'PUT' });
  });
});

describe('panel 2 — claimed', () => {
  it('shows the live address with its project path, and every retained alias', () => {
    render({ subdomain: claimed });
    expect(screen.getByText('acme.motir.site/ROADMAP')).toBeTruthy();
    // ⚠️ EVERY alias, drawn rather than counted: ADR §8's promise is about these
    // exact hostnames, and a customer deciding whether to rename again is
    // deciding about them.
    expect(screen.getByText('acme-old.motir.site')).toBeTruthy();
    expect(screen.getByText('Redirects here')).toBeTruthy();
  });

  it('shows how many renames remain — a cap you cannot see is a cap you meet as a refusal', () => {
    render({ subdomain: claimed });
    expect(screen.getByText('4 renames left.')).toBeTruthy();
  });

  it('the rename confirm carries the never-released promise and the count AFTER this one', () => {
    render({ subdomain: claimed });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(screen.getByText(/never released/)).toBeTruthy();
    expect(screen.getByText(/cannot be claimed by anyone else/)).toBeTruthy();
    // 4 remain now, so 3 remain after this one — the number the customer is
    // actually deciding with.
    expect(screen.getByText(/3 renames left after this one/)).toBeTruthy();
  });

  it('will not spend a rename on the name it already has', () => {
    render({ subdomain: claimed });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const confirm = screen.getAllByRole('button', { name: 'Rename' }).at(-1);
    expect(confirm).toHaveProperty('disabled', true);
  });

  it('offers no Rename at all once the cap is spent', () => {
    render({ subdomain: { ...claimed, renamesLeft: 0 } });
    expect(screen.getByRole('button', { name: 'Rename' })).toHaveProperty('disabled', true);
    expect(screen.getByText('No renames left.')).toBeTruthy();
  });
});

describe('panel 8 — the reader who holds the door key and not the write key', () => {
  it('shows the addresses and ABSENTS every control, rather than disabling them', () => {
    // A disabled control is a promise the actor cannot keep. The subdomain's
    // writes are gated on the WORKSPACE role, a different axis from the project
    // permission that opened this room.
    render({ subdomain: claimed, canManage: false });

    expect(screen.getByText('acme.motir.site/ROADMAP')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
    expect(screen.getByText('Managed by a workspace owner or admin.')).toBeTruthy();
    // Copy survives — it is a READ.
    expect(screen.getByLabelText('Copy address')).toBeTruthy();
  });

  it('says so plainly when there is nothing claimed and they cannot claim it', () => {
    render({ subdomain: null, canManage: false });
    expect(screen.getByText('No subdomain claimed yet.')).toBeTruthy();
    expect(screen.queryByLabelText('Subdomain')).toBeNull();
  });
});
