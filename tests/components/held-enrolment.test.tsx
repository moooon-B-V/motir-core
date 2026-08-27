// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { PasskeyDTO } from '@/lib/dto/passkey';
import type { TwoFactorStatusDTO } from '@/lib/dto/twoFactor';

// Story MOTIR-1215 · Subtask MOTIR-3648 — THE WIRE BETWEEN THE ENROLMENT ISLAND
// AND THE SERVER GATE, and the two halves of it.
//
// ⚠️ THE FAILURE THIS FILE EXISTS FOR IS SILENT. `/two-factor-required` is a
// Server Component: it asks `resolveRequirement` once, at render. The panes it
// mounts are a client island that deliberately never `router.refresh()`es. Put
// those together and a held person enrols SUCCESSFULLY and the screen does not
// move — no error, no failed request, just a page that stays held while the
// account behind it is compliant. Nothing about that is visible to a test of
// either piece alone.

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push, refresh }),
  usePathname: () => '/two-factor-required',
}));

/**
 * `PasskeyManager` stands in for the WebAuthn ceremony — the one thing a
 * happy-dom test cannot perform — and nothing else. Its contract is one prop
 * (`onPasskeysChange`), so the stub is that prop behind two buttons, and every
 * layer above it is the real component: `AccountSecurityPanes` derives the
 * method set for real, and `HeldEnrolment` decides for real. The real ceremony
 * is driven end to end in `tests/e2e/two-factor-enforcement.spec.ts`.
 */
const PASSKEY: PasskeyDTO = {
  id: 'pk_1',
  name: 'YubiKey',
  createdAt: new Date('2026-08-27T00:00:00.000Z').toISOString(),
  deviceType: 'singleDevice',
  backedUp: false,
} as PasskeyDTO;

vi.mock('@/app/(authed)/settings/account/_components/PasskeyManager', () => ({
  PasskeyManager: ({
    passkeys,
    onPasskeysChange,
  }: {
    passkeys: PasskeyDTO[];
    onPasskeysChange: (next: PasskeyDTO[]) => void;
  }) => (
    <div>
      <span>passkeys:{passkeys.length}</span>
      <button onClick={() => onPasskeysChange([PASSKEY])}>register</button>
      <button onClick={() => onPasskeysChange([])}>remove</button>
    </div>
  ),
}));

// `TwoFactorManager` is 800 lines of enrolment flow this file is not about; it
// renders its slot and nothing else here.
vi.mock('@/app/(authed)/settings/account/_components/TwoFactorManager', () => ({
  TwoFactorManager: ({
    status,
    passkeySection,
  }: {
    status: TwoFactorStatusDTO;
    passkeySection: React.ReactNode;
  }) => (
    <div>
      <span>methods:{status.methods.join(',') || 'none'}</span>
      {passkeySection}
    </div>
  ),
}));

const { HeldEnrolment } =
  await import('@/app/(auth)/two-factor-required/_components/HeldEnrolment');

const STATUS: TwoFactorStatusDTO = {
  enabled: false,
  methods: [],
  primaryMethod: null,
  backupCodesRemaining: 0,
  backupCodesTotal: 10,
};

function mount(overrides: Partial<React.ComponentProps<typeof HeldEnrolment>> = {}) {
  return render(
    <HeldEnrolment
      initialStatus={STATUS}
      initialPasskeys={[]}
      email="ada@example.com"
      hasPassword
      initialTrustedDevices={[]}
      backupCodeCount={10}
      otpPeriodMinutes={10}
      totpPeriodSeconds={30}
      trustDeviceDays={30}
      {...overrides}
    />,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('the held-enrolment island tells the server gate to look again', () => {
  it('⚠️ refreshes the ROUTE when a first second factor lands', async () => {
    // The whole point. Without this the person is compliant and the screen is
    // still holding them.
    mount();
    expect(refresh).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'register' }));
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    // …and the derivation really ran: the method set gained `passkey`, which is
    // what makes the server's next answer `compliant: true`.
    expect(screen.getByText('methods:passkey')).toBeTruthy();
  });

  it('does NOT refresh on mount — an already-compliant person is the SERVER’s answer', async () => {
    // A refresh here would be a wasted round trip on every render of a screen
    // whose verdict the server already computed. The transition is the signal,
    // not the value.
    mount({
      initialStatus: { ...STATUS, methods: ['passkey'] },
      initialPasskeys: [PASSKEY],
    });
    await act(async () => {});
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does NOT refresh when the LAST factor is removed — that is already held state', async () => {
    // Re-rendering the same held screen is noise, and the gate below it has not
    // changed its mind about anything.
    mount({
      initialStatus: { ...STATUS, methods: ['passkey'] },
      initialPasskeys: [PASSKEY],
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'remove' }));
    });

    expect(screen.getByText('methods:none')).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('reports the transition ONCE, not on every subsequent change', async () => {
    // The ref that guards it is what stops a second passkey — or any later
    // mutation — from re-refreshing a route already showing the satisfied panel.
    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'register' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'register' }));
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('⚠️ the account Security pane passes NO callback, so it is unchanged', async () => {
    // The prop is optional for exactly this reason: `AccountSecurityPanes` is the
    // shipped account surface, and MOTIR-3612's contract there is that a mutation
    // is confirmed by its own response and never by a tree refresh
    // (`inline-edit-no-tree-refresh`). Adding a refresh there would cause the
    // revert that rule records.
    const source = await import('node:fs').then(({ readFileSync }) =>
      readFileSync('app/(authed)/settings/account/security/page.tsx', 'utf8'),
    );
    expect(source).not.toContain('onSecondFactorChange');
    expect(source).not.toContain('router.refresh');
  });
});
