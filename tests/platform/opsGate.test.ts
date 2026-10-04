import { describe, expect, it } from 'vitest';
import {
  adjustAmount,
  adjustReady,
  grantAmount,
  grantReady,
  newRequestId,
  parseWholeCredits,
  reasonReady,
  slugConfirmed,
} from '@/app/(admin)/admin/tenants/[orgId]/_components/ops/opsGate';

/**
 * The ops toolkit's client-side gates (MOTIR-752, design `platform-admin`
 * AMENDMENT 2026-10-03 § The safe-action pattern): the reason gate, the typed
 * slug, the large-grant threshold and the adjustment's below-zero refusal.
 */
describe('reason and slug', () => {
  it('a reason counts only once it holds a non-blank character', () => {
    expect(reasonReady('')).toBe(false);
    expect(reasonReady('   \n ')).toBe(false);
    expect(reasonReady(' ticket #4512 ')).toBe(true);
  });

  it('the slug must match exactly; surrounding whitespace is forgiven', () => {
    expect(slugConfirmed('acme-corp', 'acme-corp')).toBe(true);
    expect(slugConfirmed('  acme-corp ', 'acme-corp')).toBe(true);
    expect(slugConfirmed('Acme-Corp', 'acme-corp')).toBe(false);
    expect(slugConfirmed('acme', 'acme-corp')).toBe(false);
  });
});

describe('parseWholeCredits', () => {
  it('reads whole numbers, signs (including U+2212) and thousands separators', () => {
    expect(parseWholeCredits('500')).toBe(500);
    expect(parseWholeCredits('+500')).toBe(500);
    expect(parseWholeCredits('-100')).toBe(-100);
    expect(parseWholeCredits('−100')).toBe(-100);
    expect(parseWholeCredits('10,000')).toBe(10_000);
  });

  it('refuses fractions, words and empty input', () => {
    for (const raw of ['', ' ', '1.5', 'abc', '1e3', '--1', '12345678901']) {
      expect(parseWholeCredits(raw)).toBeNull();
    }
  });
});

describe('grant', () => {
  it('previews the balance after and asks for the slug at or above the threshold', () => {
    expect(grantAmount('500', 10_000, 11_900)).toEqual({
      credits: 500,
      needsSlug: false,
      balanceAfter: 12_400,
    });
    expect(grantAmount('10000', 10_000, 0).needsSlug).toBe(true);
    expect(grantAmount('0', 10_000, 5)).toEqual({
      credits: null,
      needsSlug: false,
      balanceAfter: null,
    });
    expect(grantAmount('-5', 10_000, 5).credits).toBeNull();
  });

  it('is ready only with an amount, a reason and — when large — the typed slug', () => {
    const base = {
      amountRaw: '500',
      reason: 'goodwill',
      typedSlug: '',
      slug: 'acme',
      threshold: 10_000,
    };
    expect(grantReady(base)).toBe(true);
    expect(grantReady({ ...base, reason: ' ' })).toBe(false);
    expect(grantReady({ ...base, amountRaw: '' })).toBe(false);
    expect(grantReady({ ...base, amountRaw: '12000' })).toBe(false);
    expect(grantReady({ ...base, amountRaw: '12000', typedSlug: 'acme' })).toBe(true);
  });
});

describe('adjust', () => {
  it('takes a signed, non-zero amount and refuses to go below zero', () => {
    expect(adjustAmount('-100', 11_942)).toEqual({
      credits: -100,
      balanceAfter: 11_842,
      belowZero: false,
      valid: true,
    });
    expect(adjustAmount('−50', 20)).toMatchObject({ belowZero: true, valid: false });
    expect(adjustAmount('0', 20)).toMatchObject({ credits: null, valid: false });
  });

  it('is ready only with a valid amount and a reason', () => {
    expect(adjustReady({ amountRaw: '25', reason: 'double charge', balance: 0 })).toBe(true);
    expect(adjustReady({ amountRaw: '25', reason: '', balance: 0 })).toBe(false);
    expect(adjustReady({ amountRaw: '-25', reason: 'x', balance: 0 })).toBe(false);
  });
});

describe('newRequestId', () => {
  it('mints a fresh adm_ key per call, within motir-ai’s 150-character ceiling', () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).toMatch(/^adm_[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(150);
  });
});
