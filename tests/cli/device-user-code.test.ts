import { describe, expect, it } from 'vitest';
import {
  USER_CODE_LENGTH,
  formatUserCode,
  isCompleteUserCode,
  normalizeUserCode,
  readDeviceUserCode,
} from '@/lib/cliDevice/userCode';

// The `/device` page's pure string layer (Story MOTIR-1863 · Subtask MOTIR-1867).
// Small, but it sits on two paths that matter: the code a human types has to resolve
// the SAME row the CLI opened, and the sign-in hand-off banner has to be unlightable
// by a destination Motir does not own.

describe('normalizeUserCode', () => {
  it('accepts the grouping dash, lower case, and a terminal copy’s stray whitespace', () => {
    expect(normalizeUserCode('k4tp-9rxm')).toBe('K4TP9RXM');
    expect(normalizeUserCode('  K4TP 9RXM  ')).toBe('K4TP9RXM');
    expect(normalizeUserCode('K4TP9RXM')).toBe('K4TP9RXM');
  });

  it('leaves the canonical form the server matches on untouched', () => {
    // The generator's charset is uppercase-only, so folding case can only rescue a
    // typist — it can never collide two distinct codes.
    expect(normalizeUserCode(normalizeUserCode('k4tp-9rxm'))).toBe('K4TP9RXM');
  });
});

describe('formatUserCode', () => {
  it('groups as the user types rather than reformatting under them at the end', () => {
    expect(formatUserCode('')).toBe('');
    expect(formatUserCode('k4t')).toBe('K4T');
    expect(formatUserCode('k4tp')).toBe('K4TP');
    expect(formatUserCode('k4tp9')).toBe('K4TP-9');
    expect(formatUserCode('k4tp9rxm')).toBe('K4TP-9RXM');
  });

  it('shows an over-long paste instead of truncating it — a visible code is a fixable one', () => {
    expect(formatUserCode('K4TP9RXMZZ')).toBe('K4TP-9RXMZZ');
  });
});

describe('isCompleteUserCode', () => {
  it('is true at exactly the length the generator emits, in any presentation', () => {
    expect(USER_CODE_LENGTH).toBe(8);
    expect(isCompleteUserCode('k4tp-9rxm')).toBe(true);
    expect(isCompleteUserCode('K4TP9RXM')).toBe(true);
  });

  it('is false for anything shorter or longer, so a round trip is never spent on it', () => {
    expect(isCompleteUserCode('K4TP')).toBe(false);
    expect(isCompleteUserCode('')).toBe(false);
    expect(isCompleteUserCode('K4TP9RXMZ')).toBe(false);
  });
});

describe('readDeviceUserCode', () => {
  it('reads the pending code out of a `/device` return', () => {
    expect(readDeviceUserCode('/device?user_code=k4tp-9rxm')).toBe('K4TP9RXM');
  });

  it('reports a bare `/device` return as a hand-off with no code yet', () => {
    expect(readDeviceUserCode('/device')).toBe('');
  });

  it('is null for any destination that is not the device page', () => {
    expect(readDeviceUserCode('/dashboard')).toBeNull();
    expect(readDeviceUserCode('/onboarding')).toBeNull();
    expect(readDeviceUserCode('/devices')).toBeNull();
  });

  it('cannot be lit by a destination Motir does not own', () => {
    // `next=` is attacker-controlled. A substring match would let a foreign origin
    // borrow Motir's own CLI-connect chrome for a phishing hop, so only a
    // same-origin relative path counts — including the protocol-relative form,
    // which is absolute despite its leading slash.
    expect(readDeviceUserCode('https://evil.example/device?user_code=AAAABBBB')).toBeNull();
    expect(readDeviceUserCode('//evil.example/device?user_code=AAAABBBB')).toBeNull();
    expect(readDeviceUserCode('javascript:alert(1)')).toBeNull();
  });
});
