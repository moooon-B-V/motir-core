'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { PasskeyManager } from './PasskeyManager';
import { TwoFactorManager } from './TwoFactorManager';
import { withPasskeyMethod } from './twoFactorMethods';
import type { PasskeyDTO } from '@/lib/dto/passkey';
import type { TrustedDeviceDTO, TwoFactorStatusDTO } from '@/lib/dto/twoFactor';

// The Security pane's state OWNER (Story 8.12 · Subtask MOTIR-3612).
//
// ── WHY THIS COMPONENT EXISTS AT ALL ──────────────────────────────────────
// `TwoFactorManager` used to own `status` outright, and its header comment said
// why that was safe: *"There is no second surface on this page for a refresh to
// be needed by."* MOTIR-3612 creates one. Because MOTIR-3611 makes `'passkey'` a
// member of `TwoFactorStatusDTO.methods`, the passkey COUNT now decides two
// things `TwoFactorManager` renders — the read-only `Passkey` row in the methods
// card, and the hero's "already counts as a second factor" callout — while the
// thing that CHANGES that count lives in `PasskeyManager`.
//
// The card asked for a decision between lifting the status and merging the two
// islands. **Lifted, not merged**, for two reasons: `TwoFactorManager` is 800
// lines of enrolment, recovery-code and trusted-device flow that has nothing to
// do with WebAuthn, and merging would put the story's own argument — a passkey is
// not a second factor, it is a replacement for the password — inside the
// component named after second factors. So there are still two islands, both
// CONTROLLED, and exactly one owner of the truth they share.
//
// ── AND WHY IT IS ONE PIECE OF STATE, NOT TWO KEPT IN STEP ────────────────
// `passkeys` is the source; `status.methods` is DERIVED from it on every change
// (`withPasskeyMethod`). Two `useState`s each updated by hand at three call sites
// is the shape that drifts — a rename that forgot to touch the status, a removal
// that updated the list and left the row. One writer, one derivation.
//
// No `router.refresh()`, here or in either child: both islands seed from a server
// read at mount, so a refresh cannot reach them (CLAUDE.md's page-state contract,
// case 3), and every mutation already holds the response that supersedes it.

interface Props {
  initialStatus: TwoFactorStatusDTO;
  initialPasskeys: PasskeyDTO[];
  email: string;
  hasPassword: boolean;
  initialTrustedDevices: TrustedDeviceDTO[];
  backupCodeCount: number;
  otpPeriodMinutes: number;
  totpPeriodSeconds: number;
  trustDeviceDays: number;
  /**
   * OPTIONAL, and only the forced-enrolment screen passes it (MOTIR-3648).
   *
   * Fires when the account's second-factor state CHANGES — `false → true` the
   * moment a first method lands, `true → false` if the last one is removed. Not
   * on mount: a caller wants the transition, not the initial value it already
   * has as a prop.
   *
   * ⚠️ WHY IT EXISTS. `/two-factor-required` mounts these panes to hold somebody
   * out of the product until they enrol, and it is a Server Component: it cannot
   * see a client island's state, and this file deliberately does not
   * `router.refresh()` (see the header). Without a signal the person enrols
   * successfully and the screen does not move — the dead screen the design of
   * record's panel 6 exists to prevent. The account Security pane passes
   * nothing and is unchanged.
   */
  onSecondFactorChange?: (hasSecondFactor: boolean) => void;
}

export function AccountSecurityPanes({
  initialStatus,
  initialPasskeys,
  email,
  hasPassword,
  initialTrustedDevices,
  backupCodeCount,
  otpPeriodMinutes,
  totpPeriodSeconds,
  trustDeviceDays,
  onSecondFactorChange,
}: Props) {
  const [status, setStatus] = useState<TwoFactorStatusDTO>(initialStatus);
  const [passkeys, setPasskeys] = useState<PasskeyDTO[]>(initialPasskeys);

  // The second-factor transition, reported to a caller that asked for it.
  //
  // ⚠️ `methods.length > 0` IS THE CONTRACT (`lib/dto/twoFactor.ts`), not
  // `status.enabled` — a passkey counts with that flag false, which is the whole
  // regression Story MOTIR-1215 was named for. `handlePasskeys` below keeps
  // `methods` derived from the passkey list, so this reads one value rather than
  // re-deriving from two.
  //
  // The ref seeds from the INITIAL value so mounting never fires the callback;
  // only a change does.
  const hasSecondFactor = status.methods.length > 0;
  const lastReported = useRef(hasSecondFactor);
  useEffect(() => {
    if (lastReported.current === hasSecondFactor) return;
    lastReported.current = hasSecondFactor;
    onSecondFactorChange?.(hasSecondFactor);
  }, [hasSecondFactor, onSecondFactorChange]);

  /**
   * The ONE place the two surfaces meet: a passkey list change re-derives
   * whether `'passkey'` is in the method set.
   *
   * `withPasskeyMethod` is idempotent and leaves `primaryMethod` alone, so this
   * runs on every mutation without having to know which one it was.
   */
  const handlePasskeys = useCallback((next: PasskeyDTO[]) => {
    setPasskeys(next);
    setStatus((current) => withPasskeyMethod(current, next.length > 0));
  }, []);

  return (
    <TwoFactorManager
      status={status}
      onStatusChange={setStatus}
      email={email}
      hasPassword={hasPassword}
      initialTrustedDevices={initialTrustedDevices}
      backupCodeCount={backupCodeCount}
      otpPeriodMinutes={otpPeriodMinutes}
      totpPeriodSeconds={totpPeriodSeconds}
      trustDeviceDays={trustDeviceDays}
      // The passkeys card sits BETWEEN the two-factor state card and the methods
      // list — `design/settings/passkeys.mock.html` panels 1 and 2 — and both of
      // those are rendered by `TwoFactorManager`. So it is passed as a slot
      // rather than as a JSX sibling: the alternative is splitting a shipped
      // component in half to put one card between its two halves, which is a
      // bigger change to the surface this card is meant to extend.
      passkeySection={<PasskeyManager passkeys={passkeys} onPasskeysChange={handlePasskeys} />}
    />
  );
}
