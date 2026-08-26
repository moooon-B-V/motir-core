// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { TwoFactorManager } from '@/app/(authed)/settings/account/_components/TwoFactorManager';
import type { TwoFactorStatusDTO } from '@/lib/dto/twoFactor';

// The account Security pane's island (Story 8.11 · Subtask MOTIR-1220).
//
// What is worth asserting here is not "React renders" — it is the handful of
// places where this surface makes a CLAIM that has to stay true of the backend:
//
//   1. The step-up appears for an account that HAS a password and is SKIPPED for
//      one that does not. That branch is the whole reason MOTIR-1217 sets
//      `allowPasswordless: true`; getting it backwards locks a Google-only user
//      out of the feature with no visible symptom.
//   2. The email row is a STATE, not a toggle. Better-Auth's OTP arm is
//      server-level, so a switch here would write nowhere — and a control that
//      writes nowhere is exactly what a screenshot review does not catch.
//   3. The recovery counter escalates. `0 of 10` with 2FA on is a dangerous
//      state, and the card says so rather than rendering a quiet zero.

const twoFactorEnable = vi.fn();
const twoFactorDisable = vi.fn();
const twoFactorVerifyTotp = vi.fn();

vi.mock('@/lib/auth/client', () => ({
  twoFactor: {
    enable: (...a: unknown[]) => twoFactorEnable(...a),
    disable: (...a: unknown[]) => twoFactorDisable(...a),
    verifyTotp: (...a: unknown[]) => twoFactorVerifyTotp(...a),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const OFF: TwoFactorStatusDTO = {
  enabled: false,
  methods: [],
  primaryMethod: null,
  backupCodesRemaining: 0,
  backupCodesTotal: 10,
};

const ON: TwoFactorStatusDTO = {
  enabled: true,
  methods: ['totp', 'email'],
  primaryMethod: 'totp',
  backupCodesRemaining: 7,
  backupCodesTotal: 10,
};

function render(status: TwoFactorStatusDTO, overrides: Partial<{ hasPassword: boolean }> = {}) {
  return renderWithIntl(
    <TwoFactorManager
      initialStatus={status}
      email="ada@example.com"
      hasPassword={overrides.hasPassword ?? true}
      backupCodeCount={10}
      otpPeriodMinutes={3}
      totpPeriodSeconds={30}
      trustDeviceDays={30}
    />,
  );
}

describe('the pane at rest', () => {
  it('offers the authenticator as the first step when 2FA is off', () => {
    render(OFF);

    expect(screen.getByText(/Two-factor authentication is off/i)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Set up/i }).length).toBeGreaterThan(0);
  });

  it('does NOT show a recovery counter or a way to turn it off when it is off', () => {
    // Both cards are meaningless before enrolment, and drawing a "Turn off"
    // control for something that is already off is the kind of thing a static
    // mock lets through.
    render(OFF);

    expect(screen.queryByText(/of 10 left/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Turn off/i })).toBeNull();
  });

  it('shows the method list, the counter and the way out when it is on', () => {
    render(ON);

    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText(/of 10 left/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Turn off/i })).toBeTruthy();
    expect(screen.getByText(/Authenticator app/i)).toBeTruthy();
  });

  it('keeps the "lower security" caveat on email even when it is ON', () => {
    // The caveat does not stop being true once the method is in use, and it is
    // worded identically here and at the challenge.
    render(ON);

    expect(screen.getByText(/Lower security/i)).toBeTruthy();
  });
});

describe('the email row is a STATE, not a toggle', () => {
  it('renders no switch — the plugin has no per-user enable to write to', () => {
    render(ON);

    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText(/^Available$/)).toBeTruthy();
  });

  it('says WHY it is unavailable before an authenticator exists', () => {
    render(OFF);

    expect(screen.getByText(/Set up an authenticator first/i)).toBeTruthy();
  });
});

describe('the recovery counter escalates', () => {
  it('warns at two remaining', () => {
    render({ ...ON, backupCodesRemaining: 2 });

    expect(screen.getByText(/2 recovery codes left/i)).toBeTruthy();
  });

  it('names the CONSEQUENCE at zero, not the number', () => {
    render({ ...ON, backupCodesRemaining: 0 });

    expect(screen.getByText(/only an emailed code can get you back in/i)).toBeTruthy();
  });

  it('says nothing at seven', () => {
    render(ON);

    expect(screen.queryByText(/recovery codes left/i)).toBeNull();
    expect(screen.queryByText(/used every recovery code/i)).toBeNull();
  });
});

describe('the step-up branches on whether the account HAS a password', () => {
  it('asks a credential user for one before enrolling', () => {
    render(OFF, { hasPassword: true });

    fireEvent.click(screen.getAllByRole('button', { name: /Set up authenticator app/i })[0]!);

    expect(screen.getByText(/Confirm it's you/i)).toBeTruthy();
    // Nothing has been minted yet — the password gates the call that mints.
    expect(twoFactorEnable).not.toHaveBeenCalled();
  });

  it('SKIPS the prompt for a Google-only account and calls enable directly', () => {
    // The branch MOTIR-1217's `allowPasswordless: true` exists for. Asking a
    // user without a password for their password is a dead end with no wording
    // that could explain it.
    twoFactorEnable.mockResolvedValue({ data: { totpURI: null, backupCodes: [] }, error: null });
    render(OFF, { hasPassword: false });

    fireEvent.click(screen.getAllByRole('button', { name: /Set up authenticator app/i })[0]!);

    expect(screen.queryByText(/Confirm it's you/i)).toBeNull();
    expect(twoFactorEnable).toHaveBeenCalledTimes(1);
  });

  it('gates turning 2FA OFF behind the same prompt, with its own warning', () => {
    render(ON, { hasPassword: true });

    fireEvent.click(screen.getByRole('button', { name: /Turn off/i }));

    expect(screen.getByText(/Turn off two-factor authentication\?/i)).toBeTruthy();
    expect(screen.getByText(/remaining recovery codes are deleted/i)).toBeTruthy();
    expect(twoFactorDisable).not.toHaveBeenCalled();
  });
});
