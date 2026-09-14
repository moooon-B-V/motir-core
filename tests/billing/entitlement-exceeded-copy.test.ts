import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import { ENTITLEMENT_KINDS, isEntitlementKind } from '@/lib/billing/entitlements';
import { EntitlementExceededError } from '@/lib/billing/errors';
import { entitlementExceededMessage } from '@/lib/billing/entitlementCopy';

// MOTIR-5133 — a §4 cap refusal reaches a reader in THEIR language.
//
// `EntitlementExceededError` builds an English sentence at the throw site, and
// every reader-facing consumer used to show it verbatim, so a `zh` reader hit a
// cap in English. The sentence now lives in the catalogue under
// `errors.entitlementExceeded.<kind>`, selected by the error's discriminator.
//
// The guard iterates the RUNTIME list `EntitlementKind` is derived from, so an
// eighth kind cannot be added to the type without being checked here — and a
// kind with no sentence in either catalogue fails, rather than rendering a key
// path at the one moment a customer is trying to do more.

type Catalogue = { errors: { entitlementExceeded: Record<string, string> } };
const CATALOGUES = { en: enMessages, zh: zhMessages } as unknown as Record<'en' | 'zh', Catalogue>;

describe('errors.entitlementExceeded — one sentence per EntitlementKind', () => {
  for (const [locale, messages] of Object.entries(CATALOGUES)) {
    it(`${locale}: every kind has a non-empty sentence`, () => {
      const copy = messages.errors.entitlementExceeded;
      for (const kind of ENTITLEMENT_KINDS) {
        expect(copy[kind], `${locale} errors.entitlementExceeded.${kind}`).toEqual(
          expect.stringMatching(/\S/),
        );
      }
    });

    it(`${locale}: carries no key that is not a kind`, () => {
      // Tight in the other direction too: a renamed kind must not leave its old
      // sentence behind as dead copy nobody can select.
      expect(Object.keys(messages.errors.entitlementExceeded).sort()).toEqual(
        [...ENTITLEMENT_KINDS].sort(),
      );
    });
  }

  it('en re-homes the server sentence unchanged — this moves words, it does not rewrite them', () => {
    for (const kind of ENTITLEMENT_KINDS) {
      const serverMessage = new EntitlementExceededError(kind, { limit: 1 }).message;
      expect(enMessages.errors.entitlementExceeded[kind]).toBe(serverMessage);
    }
  });

  it('zh is actually translated, not the English sentence copied across', () => {
    for (const kind of ENTITLEMENT_KINDS) {
      expect(zhMessages.errors.entitlementExceeded[kind]).not.toBe(
        enMessages.errors.entitlementExceeded[kind],
      );
    }
  });

  it("the server's own default message survives as the log / API string", () => {
    // Nothing depends on removing it: it is still what `err.message` says.
    expect(new EntitlementExceededError('storage', { limit: 1 }).message).toBe(
      "Your plan's storage limit has been reached.",
    );
  });
});

describe('entitlementExceededMessage', () => {
  it('selects the sentence by kind through an errors-scoped translator, per locale', () => {
    const en = createTranslator({ locale: 'en', messages: enMessages, namespace: 'errors' });
    const zh = createTranslator({ locale: 'zh', messages: zhMessages, namespace: 'errors' });
    expect(entitlementExceededMessage(en, 'workspaces')).toBe(
      "Your plan's workspaces limit has been reached.",
    );
    expect(entitlementExceededMessage(zh, 'workspaces')).toBe(
      zhMessages.errors.entitlementExceeded.workspaces,
    );
  });
});

describe('isEntitlementKind', () => {
  it('accepts every kind and nothing else', () => {
    for (const kind of ENTITLEMENT_KINDS) expect(isEntitlementKind(kind)).toBe(true);
    for (const value of ['', 'seats', 'WORKSPACES', null, undefined, 7, {}]) {
      expect(isEntitlementKind(value)).toBe(false);
    }
  });
});
