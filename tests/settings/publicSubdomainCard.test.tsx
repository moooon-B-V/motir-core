// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PublicSubdomainCard } from '@/app/(authed)/settings/project/public-address/_components/PublicSubdomainCard';
import type { PublicSubdomainDto } from '@/lib/dto/publicAddresses';
import zhMessages from '@/messages/zh.json';

// THE WORKSPACE SUBDOMAIN CARD (Story MOTIR-3878 · MOTIR-4221) — design panels
// 1, 2 and 8, rendered. **Panels 10-13 are the RELEASE control** (Story
// MOTIR-4451 · MOTIR-4455), at the bottom of this file.
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

function render(
  opts: {
    subdomain?: PublicSubdomainDto | null;
    canManage?: boolean;
    messages?: Record<string, unknown>;
  } = {},
) {
  return renderWithIntl(
    <PublicSubdomainCard
      workspaceId="ws_1"
      baseDomain="motir.site"
      projectIdentifier="ROADMAP"
      publicSiteHost="motir.co"
      fallbackAddress="motir.co/p/ROADMAP"
      subdomain={opts.subdomain ?? null}
      canManage={opts.canManage ?? true}
    />,
    opts.messages ? { locale: 'zh', messages: opts.messages } : {},
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

// ── PANELS 10-13 — RELEASE (Story MOTIR-4451 · Subtask MOTIR-4455) ─────────
//
// The element these exist for is the HOSTNAME LIST. Every instinct in UI work
// says to collapse three hostnames into "and any previous addresses", and that
// is exactly the failure the confirm prevents: somebody who renamed twice months
// ago does not think of the old label as theirs until it is gone. So the list is
// asserted per-hostname — and the WRAP is asserted too, because a truncating row
// compiles, renders, and passes a happy-path assertion while hiding the second
// half of the name it is about to take for ever.

/** Two aliases, one of them with no hyphen to break at — the wrap's hard case. */
const LONG_ALIAS = 'averyverylongworkspacesubdomainlabelnobodyshouldhavetyped.motir.site';
const claimedWithTwoAliases: PublicSubdomainDto = {
  ...claimed,
  aliases: [
    { hostname: 'acme-old.motir.site', retiredAt: '2026-09-02T00:00:00.000Z' },
    { hostname: LONG_ALIAS, retiredAt: '2026-09-03T00:00:00.000Z' },
  ],
  renamesLeft: 3,
};

function openRelease(name = 'Remove'): void {
  fireEvent.click(screen.getByRole('button', { name }));
}

describe('panel 10 — the Remove control', () => {
  it('offers Remove BEFORE Rename, so the pointer never crosses it', () => {
    render({ subdomain: claimedWithTwoAliases });
    const remove = screen.getByRole('button', { name: 'Remove' });
    const rename = screen.getByRole('button', { name: 'Rename' });
    expect(remove.compareDocumentPosition(rename) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is ABSENT for a reader who may not change the address', () => {
    render({ subdomain: claimedWithTwoAliases, canManage: false });
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('is still offered once the rename cap is spent — the cap bounds coming BACK, not leaving', () => {
    // ADR §8 Amendment 2: release is not a claim and is not capped. Rename is
    // disabled at zero; Remove must not be.
    render({ subdomain: { ...claimedWithTwoAliases, renamesLeft: 0 } });
    expect(screen.getByRole('button', { name: 'Remove' })).not.toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Rename' })).toHaveProperty('disabled', true);
  });
});

describe('panel 10 — the confirm', () => {
  it('LISTS every hostname individually — the live one and BOTH aliases', () => {
    render({ subdomain: claimedWithTwoAliases });
    openRelease();
    expect(screen.getByText('Remove acme.motir.site?')).toBeTruthy();
    expect(screen.getByText('These 3 addresses will stop answering:')).toBeTruthy();
    for (const host of ['acme.motir.site', 'acme-old.motir.site', LONG_ALIAS]) {
      expect(screen.getAllByText(host).length).toBeGreaterThan(0);
    }
    // The sentence this list exists INSTEAD of.
    expect(screen.queryByText(/any previous addresses/i)).toBeNull();
  });

  it('WRAPS the hostname rows rather than truncating them', () => {
    // The long, hyphen-less label is the one this matters for: `truncate` would
    // render it as an ellipsis, and the name is the whole message here.
    render({ subdomain: claimedWithTwoAliases });
    openRelease();
    const row = screen.getAllByText(LONG_ALIAS).at(-1)!;
    expect(row.className).toContain('break-words');
    expect(row.className).not.toContain('truncate');
  });

  it('carries the permanence sentence, the cap sentence and the fallback', () => {
    render({ subdomain: claimedWithTwoAliases });
    openRelease();
    expect(
      screen.getByText(
        'These names are held for ever. Nobody can claim them again — including you.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/keeps every released name out of its namespace permanently/),
    ).toBeTruthy();
    // ⚠️ THE NUMBER IS THE DTO'S. `renamesLeft` counts names BURNT (ADR §8
    // Amendment 2) and is no longer a function of the alias rows, so two aliases
    // with `renamesLeft: 3` must render 3 — a browser-side re-derivation would
    // print 3 here by coincidence and the wrong number after a release.
    expect(
      screen.getByText(/You will have 3 renames left if you claim a subdomain again/),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Your public projects go back to motir.co/p/ROADMAP, and appear on motir.co again.',
      ),
    ).toBeTruthy();
  });

  it('reads in the SINGULAR for a workspace that never renamed', () => {
    render({ subdomain: { ...claimed, aliases: [], renamesLeft: 5 } });
    openRelease();
    expect(screen.getByText('This address will stop answering:')).toBeTruthy();
    expect(
      screen.getByText('This name is held for ever. Nobody can claim it again — including you.'),
    ).toBeTruthy();
  });

  it("says 'no renames' rather than '0 renames' at the cap", () => {
    render({ subdomain: { ...claimedWithTwoAliases, renamesLeft: 0 } });
    openRelease();
    expect(screen.getByText(/You will have no renames left/)).toBeTruthy();
  });

  it('renders in zh, with the COUNT rendered rather than a bare plural', () => {
    // zh carries no plural morphology, so the number is the message.
    render({
      subdomain: claimedWithTwoAliases,
      messages: zhMessages as unknown as Record<string, unknown>,
    });
    openRelease('移除');
    expect(screen.getByText('要移除 acme.motir.site 吗？')).toBeTruthy();
    expect(screen.getByText('以下 3 个地址将停止提供访问：')).toBeTruthy();
    expect(
      screen.getByText('这些名称将被永久保留，任何人都无法再认领它们——包括你自己。'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: '移除子域名' })).toBeTruthy();
  });
});

describe('panel 11 — confirming, cancelling, and the three refusals', () => {
  it('CANCEL changes nothing — no request, no refresh', () => {
    render({ subdomain: claimedWithTwoAliases });
    openRelease();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('DELETEs the route and REFRESHES rather than patching what it derived', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    render({ subdomain: claimedWithTwoAliases });
    openRelease();
    fireEvent.click(screen.getByRole('button', { name: 'Remove subdomain' }));
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/ws_1/public-subdomain', {
      method: 'DELETE',
    });
    // Release empties BOTH server-derived fields at once, and `renamesLeft` is
    // not a function of the alias rows any more — so there is nothing a browser
    // could correctly reconstruct.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a 404 as a STALE TAB — refreshes, and shows no complaint', async () => {
    // `SUBDOMAIN_NOT_FOUND` means somebody already released it. An error about a
    // subdomain that no longer exists is a worse answer than the current state.
    // It is also a DIFFERENT code from the rename path's NO_SUBDOMAIN_CLAIMED.
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ code: 'SUBDOMAIN_NOT_FOUND' }) });
    render({ subdomain: claimedWithTwoAliases });
    openRelease();
    fireEvent.click(screen.getByRole('button', { name: 'Remove subdomain' }));
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders the permission refusal, and does NOT refresh', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ code: 'SUBDOMAIN_FORBIDDEN' }) });
    render({ subdomain: claimedWithTwoAliases });
    openRelease();
    fireEvent.click(screen.getByRole('button', { name: 'Remove subdomain' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'Only a workspace owner or admin can change this address.',
      ),
    );
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('renders the generic refusal for an unknown code, and for a thrown request', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ code: 'SOMETHING_NEW' }) });
    const first = render({ subdomain: claimedWithTwoAliases });
    openRelease();
    fireEvent.click(screen.getByRole('button', { name: 'Remove subdomain' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'That did not work. Try again in a moment.',
      ),
    );
    first.unmount();

    fetchMock.mockRejectedValue(new Error('offline'));
    render({ subdomain: claimedWithTwoAliases });
    openRelease();
    fireEvent.click(screen.getByRole('button', { name: 'Remove subdomain' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'That did not work. Try again in a moment.',
      ),
    );
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('clears a refusal when the confirm closes, so re-opening starts clean', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ code: 'SUBDOMAIN_FORBIDDEN' }) });
    render({ subdomain: claimedWithTwoAliases });
    openRelease();
    fireEvent.click(screen.getByRole('button', { name: 'Remove subdomain' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    openRelease();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
