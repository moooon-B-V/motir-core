// @vitest-environment happy-dom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PasskeyManager } from '@/app/(authed)/settings/account/_components/PasskeyManager';
import { AccountSecurityPanes } from '@/app/(authed)/settings/account/_components/AccountSecurityPanes';
import type { PasskeyDTO } from '@/lib/dto/passkey';
import type { TwoFactorStatusDTO } from '@/lib/dto/twoFactor';

// The account Security pane's passkeys card (Story 8.12 · Subtask MOTIR-3612).
//
// What is worth asserting here is not "React renders" — it is the four places
// this surface makes a claim that has to stay true:
//
//   1. A DISMISSED browser sheet draws NOTHING. The natural implementation makes
//      it a red banner, which tells someone they did something wrong when they
//      changed their mind. It is asserted explicitly for that reason.
//   2. The two error CODE SPACES both land. The plugin's client surfaces a
//      ceremony failure with SimpleWebAuthn's `WebAuthnError.code` and a server
//      failure with its own key — reading only the documented set is how the
//      cancelled case ends up on the generic arm.
//   3. The CROSS-SURFACE transitions. Registering the first passkey has to change
//      two things in the component next door (the methods row, the hero's
//      callout) and removing the last has to change them back. Two islands each
//      holding their own copy of that fact is the defect the state lift prevents,
//      and only a test that drives BOTH components catches it.
//   4. An unnamed row is still addressable — a fallback LABEL, never a blank.

const addPasskey = vi.fn();
const updatePasskey = vi.fn();
const deletePasskey = vi.fn();

vi.mock('@/lib/auth/client', () => ({
  passkey: {
    addPasskey: (...a: unknown[]) => addPasskey(...a),
    updatePasskey: (...a: unknown[]) => updatePasskey(...a),
    deletePasskey: (...a: unknown[]) => deletePasskey(...a),
  },
  twoFactor: { enable: vi.fn(), disable: vi.fn(), verifyTotp: vi.fn() },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const LAPTOP: PasskeyDTO = {
  id: 'pk_1',
  name: 'MacBook Pro',
  deviceType: 'multiDevice',
  backedUp: true,
  createdAt: '2026-08-12T09:00:00.000Z',
};

const KEY: PasskeyDTO = {
  id: 'pk_2',
  name: 'YubiKey 5C',
  deviceType: 'singleDevice',
  backedUp: false,
  createdAt: '2026-09-03T09:00:00.000Z',
};

const OFF: TwoFactorStatusDTO = {
  enabled: false,
  methods: [],
  primaryMethod: null,
  backupCodesRemaining: 0,
  backupCodesTotal: 10,
};

/** The card alone, with the harness standing in for the state owner. */
function Card({ initial = [] as PasskeyDTO[] }) {
  const [passkeys, setPasskeys] = useState(initial);
  return <PasskeyManager passkeys={passkeys} onPasskeysChange={setPasskeys} />;
}

function renderCard(initial: PasskeyDTO[] = []) {
  return renderWithIntl(<Card initial={initial} />);
}

/** The whole pane — both islands under their real owner. */
function renderPane(passkeys: PasskeyDTO[] = [], status: TwoFactorStatusDTO = OFF) {
  return renderWithIntl(
    <AccountSecurityPanes
      initialStatus={status}
      initialPasskeys={passkeys}
      email="ada@example.com"
      hasPassword
      initialTrustedDevices={[]}
      backupCodeCount={10}
      otpPeriodMinutes={3}
      totpPeriodSeconds={30}
      trustDeviceDays={30}
    />,
  );
}

describe('the card at rest', () => {
  it('explains what a passkey IS when there are none', () => {
    renderCard();

    // The empty state spends its words on the concept, not on the button: most
    // readers have never knowingly used a passkey, and "Add a passkey" alone
    // answers nothing.
    expect(screen.getByText('No passkeys yet')).toBeTruthy();
    expect(screen.getByText(/unlocks with your fingerprint/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /add a passkey/i })).toBeTruthy();
  });

  it('renders a row per passkey, with the name, the device type and the date', () => {
    renderCard([LAPTOP, KEY]);

    expect(screen.getByText('MacBook Pro')).toBeTruthy();
    expect(screen.getByText('YubiKey 5C')).toBeTruthy();
    // `deviceType` in words rather than in the plugin's vocabulary.
    expect(screen.getByText('Synced')).toBeTruthy();
    expect(screen.getByText('This device only')).toBeTruthy();
    expect(screen.queryByText('No passkeys yet')).toBeNull();
  });

  it('gives an unnamed passkey a fallback LABEL, not a blank cell', () => {
    renderCard([{ ...LAPTOP, name: null }]);

    // The DTO keeps `name` null so an unnamed row stays distinguishable from one
    // somebody named; the fallback is the pane's job, and it has to be
    // addressable — a blank cell has nothing to click "Rename" about.
    expect(screen.getByText('Unnamed passkey')).toBeTruthy();
  });
});

describe('registering', () => {
  it('shows the pending row while the browser has its sheet open, then the new row', async () => {
    addPasskey.mockResolvedValue({
      data: {
        id: 'pk_new',
        name: 'Chrome on Linux',
        deviceType: 'multiDevice',
        backedUp: true,
        createdAt: new Date('2026-08-26T10:00:00.000Z'),
      },
      error: null,
    });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /add a passkey/i }));

    await waitFor(() => expect(screen.getByText('Chrome on Linux')).toBeTruthy());
    // Updated from the RESPONSE — no re-read, no router.refresh().
    expect(addPasskey).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('No passkeys yet')).toBeNull();
  });

  it('proposes a NAME rather than registering a blank one', async () => {
    addPasskey.mockResolvedValue({ data: null, error: null });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /add a passkey/i }));

    await waitFor(() => expect(addPasskey).toHaveBeenCalled());
    const [arg] = addPasskey.mock.calls[0] as [{ name?: string }];
    // Two rows have to be tellable apart and `name` is the only field that does
    // it, so the register call must not send an empty one.
    expect(arg.name).toBeTruthy();
  });
});

describe('the refusals — and the one that says nothing', () => {
  it('draws NOTHING when the reader dismisses the browser sheet', async () => {
    // SimpleWebAuthn's code, not the plugin's `REGISTRATION_CANCELLED` — this is
    // the arm a code-space-blind implementation sends to the generic banner.
    addPasskey.mockResolvedValue({
      data: null,
      error: { code: 'ERROR_CEREMONY_ABORTED', message: 'aborted', status: 400, statusText: 'x' },
    });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /add a passkey/i }));

    await waitFor(() => expect(addPasskey).toHaveBeenCalled());
    expect(screen.queryByText(/already has a passkey/i)).toBeNull();
    expect(screen.queryByText(/took more than/i)).toBeNull();
    expect(screen.queryByText(/didn't work/i)).toBeNull();
    // Back exactly where they were.
    expect(screen.getByText('No passkeys yet')).toBeTruthy();
  });

  it('names the duplicate case, from EITHER code space', async () => {
    for (const code of ['ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED', 'PREVIOUSLY_REGISTERED']) {
      addPasskey.mockResolvedValue({
        data: null,
        error: { code, message: 'x', status: 400, statusText: 'x' },
      });
      const view = renderCard();
      fireEvent.click(screen.getByRole('button', { name: /add a passkey/i }));
      await waitFor(() => expect(screen.getByText(/already has a passkey/i)).toBeTruthy());
      view.unmount();
    }
  });

  it('explains a lapsed challenge in MINUTES, not as an error code', async () => {
    addPasskey.mockResolvedValue({
      data: null,
      error: { code: 'CHALLENGE_NOT_FOUND', message: 'x', status: 400, statusText: 'x' },
    });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /add a passkey/i }));

    // The number is the one the server enforces (PASSKEY_CHALLENGE_TTL_MINUTES),
    // not a second literal in the copy.
    await waitFor(() => expect(screen.getByText(/took more than 5 minutes/i)).toBeTruthy());
    expect(screen.queryByText(/CHALLENGE_NOT_FOUND/)).toBeNull();
  });

  it('falls back to a generic message rather than surfacing an unknown enum', async () => {
    addPasskey.mockResolvedValue({
      data: null,
      error: {
        code: 'ERROR_AUTHENTICATOR_NO_TRANSPORTS',
        message: 'x',
        status: 400,
        statusText: 'x',
      },
    });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /add a passkey/i }));

    await waitFor(() => expect(screen.getByText(/didn't work/i)).toBeTruthy());
    expect(screen.queryByText(/ERROR_AUTHENTICATOR_NO_TRANSPORTS/)).toBeNull();
  });

  it('falls back to generic when the failure carries no code at all', async () => {
    // The transport-failure arm of the union: no ceremony outcome to name.
    addPasskey.mockResolvedValue({
      data: null,
      error: { message: 'network', status: 500, statusText: 'x' },
    });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /add a passkey/i }));

    await waitFor(() => expect(screen.getByText(/didn't work/i)).toBeTruthy());
  });
});

describe('rename', () => {
  it('opens a modal seeded with the current name, states the bound, and saves', async () => {
    updatePasskey.mockResolvedValue({ data: {}, error: null });
    renderCard([LAPTOP]);

    fireEvent.click(screen.getByRole('button', { name: /rename/i }));

    expect(screen.getByText('Rename this passkey')).toBeTruthy();
    // The bound is STATED, which is the reason this is a modal rather than an
    // inline field on an already-dense row.
    expect(screen.getByText(/up to 64 characters/i)).toBeTruthy();

    const field = screen.getByLabelText('Name') as HTMLInputElement;
    expect(field.value).toBe('MacBook Pro');
    fireEvent.change(field, { target: { value: 'Work laptop' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(updatePasskey).toHaveBeenCalledWith({
        id: 'pk_1',
        name: 'Work laptop',
      }),
    );
    await waitFor(() => expect(screen.getByText('Work laptop')).toBeTruthy());
  });

  it('leaves the row alone when the rename is refused', async () => {
    updatePasskey.mockResolvedValue({
      data: null,
      error: { code: 'FAILED_TO_UPDATE_PASSKEY', message: 'x', status: 400, statusText: 'x' },
    });
    renderCard([LAPTOP]);

    fireEvent.click(screen.getByRole('button', { name: /rename/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nope' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(screen.getByText(/didn't work/i)).toBeTruthy());
    expect(screen.queryByText('Nope')).toBeNull();
  });
});

describe('remove', () => {
  it('warns about the consequence ONLY when it is the last passkey', () => {
    const view = renderCard([LAPTOP, KEY]);
    fireEvent.click(screen.getAllByRole('button', { name: /remove/i })[0]!);
    // Two left: removing one is not the interesting case, so no warning.
    expect(screen.queryByText(/last passkey/i)).toBeNull();
    view.unmount();

    renderCard([LAPTOP]);
    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    expect(screen.getByText(/this is your last passkey/i)).toBeTruthy();
  });

  it('removes the row on confirm', async () => {
    deletePasskey.mockResolvedValue({ data: {}, error: null });
    renderCard([LAPTOP, KEY]);

    fireEvent.click(screen.getAllByRole('button', { name: /^remove$/i })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /remove passkey/i }));

    await waitFor(() => expect(deletePasskey).toHaveBeenCalledWith({ id: 'pk_1' }));
    await waitFor(() => expect(screen.queryByText('MacBook Pro')).toBeNull());
    expect(screen.getByText('YubiKey 5C')).toBeTruthy();
  });

  it('keeps the row when the delete is refused', async () => {
    deletePasskey.mockResolvedValue({
      data: null,
      error: { code: 'PASSKEY_NOT_FOUND', message: 'x', status: 404, statusText: 'x' },
    });
    renderCard([LAPTOP]);

    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    fireEvent.click(screen.getByRole('button', { name: /remove passkey/i }));

    await waitFor(() => expect(screen.getByText(/didn't work/i)).toBeTruthy());
    expect(screen.getByText('MacBook Pro')).toBeTruthy();
  });
});

describe('the shapes the plugin can hand back', () => {
  it('normalises a row with no name and an ISO string date', async () => {
    // The client's `Passkey` carries `name?: string` and a `Date`; the server
    // read carries `name: string | null` and an ISO string. Both reach the same
    // list, so both have to normalise — an unnamed row must land on the fallback
    // LABEL rather than rendering `undefined`.
    addPasskey.mockResolvedValue({
      data: {
        id: 'pk_new',
        deviceType: 'singleDevice',
        backedUp: false,
        createdAt: '2026-08-26T10:00:00.000Z',
      },
      error: null,
    });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /add a passkey/i }));

    await waitFor(() => expect(screen.getByText('Unnamed passkey')).toBeTruthy());
    expect(screen.getByText('This device only')).toBeTruthy();
  });

  it('proposes a BROWSER-and-platform name when the browser reports both', async () => {
    const nav = navigator as Navigator & { userAgentData?: unknown };
    const original = nav.userAgentData;
    Object.defineProperty(nav, 'userAgentData', {
      value: {
        platform: 'macOS',
        brands: [{ brand: 'Not/A)Brand' }, { brand: 'Chromium' }],
      },
      configurable: true,
    });
    addPasskey.mockResolvedValue({ data: null, error: null });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /add a passkey/i }));

    await waitFor(() => expect(addPasskey).toHaveBeenCalled());
    const [arg] = addPasskey.mock.calls[0] as [{ name?: string }];
    // The placeholder brand every Chromium sends is skipped, not proposed.
    expect(arg.name).toBe('Chromium on macOS');

    Object.defineProperty(nav, 'userAgentData', { value: original, configurable: true });
  });

  it('still proposes SOMETHING when the browser reports nothing', async () => {
    // The last arm of the name proposal. A browser with no `userAgentData` and
    // an empty `platform` is unusual and not impossible, and the register call
    // must not send an empty name — the whole point of proposing one is that a
    // list of unnamed credentials is unreadable.
    const nav = navigator as Navigator & { userAgentData?: unknown };
    const originalUa = nav.userAgentData;
    const originalPlatform = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(nav),
      'platform',
    );
    Object.defineProperty(nav, 'userAgentData', { value: undefined, configurable: true });
    Object.defineProperty(nav, 'platform', { value: '', configurable: true });

    addPasskey.mockResolvedValue({ data: null, error: null });
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /add a passkey/i }));

    await waitFor(() => expect(addPasskey).toHaveBeenCalled());
    const [arg] = addPasskey.mock.calls[0] as [{ name?: string }];
    expect(arg.name).toBe('Passkey');

    Object.defineProperty(nav, 'userAgentData', { value: originalUa, configurable: true });
    if (originalPlatform) Object.defineProperty(nav, 'platform', originalPlatform);
  });

  it('treats an error with a NON-STRING code as uncoded', async () => {
    // Defensive rather than hypothetical: the code arrives from a third-party
    // client's union, and a `code` that is not a string must not be indexed into
    // the copy map as one.
    addPasskey.mockResolvedValue({ data: null, error: { code: 42, status: 400 } });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /add a passkey/i }));

    await waitFor(() => expect(screen.getByText(/didn't work/i)).toBeTruthy());
  });

  it('treats a NON-OBJECT error as uncoded', async () => {
    addPasskey.mockResolvedValue({ data: null, error: 'boom' });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /add a passkey/i }));

    await waitFor(() => expect(screen.getByText(/didn't work/i)).toBeTruthy());
  });
});

describe('the modals close without acting', () => {
  it('Cancel leaves the rename alone', () => {
    renderCard([LAPTOP]);

    fireEvent.click(screen.getByRole('button', { name: /rename/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Discarded' } });
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(screen.queryByText('Rename this passkey')).toBeNull();
    expect(updatePasskey).not.toHaveBeenCalled();
    expect(screen.getByText('MacBook Pro')).toBeTruthy();
  });

  it('“Keep it” leaves the passkey alone', () => {
    renderCard([LAPTOP]);

    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    fireEvent.click(screen.getByRole('button', { name: /keep it/i }));

    expect(deletePasskey).not.toHaveBeenCalled();
    expect(screen.getByText('MacBook Pro')).toBeTruthy();
  });

  it('Escape dismisses each modal — the dialog primitive’s own affordance', () => {
    renderCard([LAPTOP]);

    fireEvent.click(screen.getByRole('button', { name: /rename/i }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByText('Rename this passkey')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: /remove passkey/i })).toBeNull();
  });

  it('names an UNNAMED passkey in the remove confirmation', () => {
    // The title interpolates the name, and a null one has to reach the same
    // fallback the row uses — "Remove “”?" is the alternative.
    renderCard([{ ...LAPTOP, name: null }]);

    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));

    expect(screen.getByText(/Remove “Unnamed passkey”\?/)).toBeTruthy();
  });
});

describe('the two surfaces next door move with the passkey count', () => {
  it('adds the Passkey method row and the hero callout on the FIRST registration', async () => {
    addPasskey.mockResolvedValue({
      data: {
        id: 'pk_new',
        name: 'Chrome on Linux',
        deviceType: 'multiDevice',
        backedUp: true,
        createdAt: new Date('2026-08-26T10:00:00.000Z'),
      },
      error: null,
    });
    renderPane([], OFF);

    // Before: two-factor is off, so neither exists.
    expect(screen.queryByText('Counts as two factors')).toBeNull();
    expect(screen.queryByText(/already counts as a second factor/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /add a passkey/i }));

    // After: both, with no page reload and no router.refresh().
    await waitFor(() => expect(screen.getByText('Counts as two factors')).toBeTruthy());
    expect(screen.getByText(/already counts as a second factor/i)).toBeTruthy();
    expect(screen.getByText('Managed above')).toBeTruthy();
  });

  it('takes both away again when the LAST passkey is removed', async () => {
    deletePasskey.mockResolvedValue({ data: {}, error: null });
    renderPane([LAPTOP], { ...OFF, methods: ['passkey'] });

    expect(screen.getByText('Counts as two factors')).toBeTruthy();
    expect(screen.getByText(/already counts as a second factor/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    fireEvent.click(screen.getByRole('button', { name: /remove passkey/i }));

    await waitFor(() => expect(screen.queryByText('Counts as two factors')).toBeNull());
    expect(screen.queryByText(/already counts as a second factor/i)).toBeNull();
  });

  it('never shows the hero callout when two-factor is ON', () => {
    // The callout answers "you already have a second factor" to someone the hero
    // is telling they have none. With 2FA on there is no such contradiction, and
    // the hero is not rendered at all.
    renderPane([LAPTOP], {
      enabled: true,
      methods: ['totp', 'email', 'passkey'],
      primaryMethod: 'totp',
      backupCodesRemaining: 7,
      backupCodesTotal: 10,
    });

    expect(screen.queryByText(/already counts as a second factor/i)).toBeNull();
    // The read-only method row is still there — the account holds the method.
    expect(screen.getByText('Counts as two factors')).toBeTruthy();
  });
});
