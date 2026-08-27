import { describe, expect, it } from 'vitest';
import {
  hasPasskeyMethod,
  withPasskeyMethod,
} from '@/app/(authed)/settings/account/_components/twoFactorMethods';
import type { TwoFactorStatusDTO } from '@/lib/dto/twoFactor';

// Story 8.12 · Subtask MOTIR-3612 — the one client-side rule about `'passkey'`
// in a status DTO.
//
// It is a four-line function and it gets its own suite because it is the thing
// standing between a registered passkey and two local rebuilds that predate
// passkeys (`TwoFactorManager`'s disable and confirm-enrolment handlers, both of
// which write a whole new status object). The component tests exercise it
// through a click path; this exercises the rule itself, including the two
// no-op arms a click path cannot reach twice.

const BASE: TwoFactorStatusDTO = {
  enabled: false,
  methods: [],
  primaryMethod: null,
  backupCodesRemaining: 0,
  backupCodesTotal: 10,
};

describe('withPasskeyMethod', () => {
  it('adds `passkey` when the account has one and the set does not say so', () => {
    const next = withPasskeyMethod({ ...BASE, methods: ['totp', 'email'] }, true);
    expect(next.methods).toEqual(['totp', 'email', 'passkey']);
  });

  it('removes `passkey` when the last one is gone', () => {
    const next = withPasskeyMethod({ ...BASE, methods: ['totp', 'email', 'passkey'] }, false);
    expect(next.methods).toEqual(['totp', 'email']);
  });

  it('is a NO-OP when the set already agrees, in both directions', () => {
    // Identity, not just equality: the caller runs this on every passkey
    // mutation, so an agreeing status must not produce a new object and a new
    // render on a rename.
    const present: TwoFactorStatusDTO = { ...BASE, methods: ['passkey'] };
    expect(withPasskeyMethod(present, true)).toBe(present);

    const absent: TwoFactorStatusDTO = { ...BASE, methods: ['email'] };
    expect(withPasskeyMethod(absent, false)).toBe(absent);
  });

  it('NEVER touches `primaryMethod`, which is the whole distinction', () => {
    // `methods` answers "what is this account enrolled in"; `primaryMethod`
    // answers "what will the CHALLENGE ask for" — and a passkey mints a session
    // outright, so it can never be the second. `lib/mappers/twoFactorMappers.ts`
    // makes the same split server-side and the two must not drift.
    const on: TwoFactorStatusDTO = {
      ...BASE,
      enabled: true,
      methods: ['totp', 'email'],
      primaryMethod: 'totp',
    };
    expect(withPasskeyMethod(on, true).primaryMethod).toBe('totp');

    const off = withPasskeyMethod(BASE, true);
    expect(off.primaryMethod).toBeNull();
    expect(off.methods).toEqual(['passkey']);
  });

  it('leaves every other field alone', () => {
    const next = withPasskeyMethod({ ...BASE, backupCodesRemaining: 7 }, true);
    expect(next.enabled).toBe(false);
    expect(next.backupCodesRemaining).toBe(7);
    expect(next.backupCodesTotal).toBe(10);
  });
});

describe('hasPasskeyMethod', () => {
  it('reads the account’s passkey standing off the method set', () => {
    expect(hasPasskeyMethod(BASE)).toBe(false);
    expect(hasPasskeyMethod({ ...BASE, methods: ['totp', 'email'] })).toBe(false);
    // ⚠️ TRUE with two-factor OFF, and that is the point: the passkey plugin
    // never touches `user.twoFactorEnabled`, so an account can be genuinely
    // multi-factor with that flag down (MOTIR-3611).
    expect(hasPasskeyMethod({ ...BASE, methods: ['passkey'] })).toBe(true);
  });
});
