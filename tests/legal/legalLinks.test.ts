import { afterEach, describe, expect, it } from 'vitest';
import { legalDocumentUrl, legalIndexUrl, signUpLegalLinks } from '@/lib/legal/links';
import { PUBLISHED_FIXTURE, clearLegalManifest, setLegalManifest } from '../helpers/legalManifest';

// WHERE THE LEGAL LINKS POINT (MOTIR-4010).
//
// Every answer here is NULLABLE, and `null` is not an error case — it is the
// unconfigured build, which is what every self-hoster runs on day one and the
// arm `design/auth/legal-agreement.mock.html` panels 12–14 draw. So the
// unconfigured assertions are as load-bearing as the configured ones.

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe('legalDocumentUrl', () => {
  it('answers the configured absolute url', () => {
    restore = setLegalManifest();
    expect(legalDocumentUrl('terms')).toBe('https://motir.co/legal/terms');
  });

  it('answers null for a slug the manifest does not carry', () => {
    restore = setLegalManifest([PUBLISHED_FIXTURE[0]!]);
    expect(legalDocumentUrl('privacy')).toBeNull();
  });

  it('answers null when nothing is configured', () => {
    restore = clearLegalManifest();
    expect(legalDocumentUrl('terms')).toBeNull();
  });
});

describe('signUpLegalLinks — BOTH or NEITHER', () => {
  it('answers both urls when both are configured', () => {
    restore = setLegalManifest();
    expect(signUpLegalLinks()).toEqual({
      termsUrl: 'https://motir.co/legal/terms',
      privacyUrl: 'https://motir.co/legal/privacy',
    });
  });

  // ⚠️ THE HALF-CONFIGURED ARM IS THE ONE WORTH ASSERTING. The notice is ONE
  // sentence naming TWO documents, so rendering it with one link and one bare
  // phrase asserts agreement to a document nobody published — the same falseness
  // AMENDMENT 2 §D rejects for the fully-unconfigured case, in a narrower form.
  it.each([
    ['only terms', ['terms']],
    ['only privacy', ['privacy']],
  ])('answers null with %s configured', (_label, slugs) => {
    restore = setLegalManifest(
      PUBLISHED_FIXTURE.filter((doc) => (slugs as string[]).includes(doc.slug)),
    );
    expect(signUpLegalLinks()).toBeNull();
  });

  it('answers null when nothing is configured', () => {
    restore = clearLegalManifest();
    expect(signUpLegalLinks()).toBeNull();
  });
});

describe('legalIndexUrl — derived, or absent', () => {
  it('derives the base every document shares', () => {
    restore = setLegalManifest();
    expect(legalIndexUrl()).toBe('https://motir.co/legal');
  });

  it('derives it from a SINGLE document too — a set of one still has a home', () => {
    restore = setLegalManifest([PUBLISHED_FIXTURE[0]!]);
    expect(legalIndexUrl()).toBe('https://motir.co/legal');
  });

  it('answers null when nothing is configured', () => {
    restore = clearLegalManifest();
    expect(legalIndexUrl()).toBeNull();
  });

  // ⚠️ THE ARM THAT MATTERS: an operator publishing at unrelated addresses has
  // no index for the rail row to point at, and inventing one would send a reader
  // somewhere nobody published. Absent beats guessed — sign-up and the
  // re-consent rows still link each document directly, so nothing is
  // unreachable; what is missing is a single door, which is what is missing in
  // reality.
  it('answers null when the documents do NOT share one base', () => {
    restore = setLegalManifest([
      { ...PUBLISHED_FIXTURE[0]!, url: 'https://acme.example/terms' },
      { ...PUBLISHED_FIXTURE[1]!, url: 'https://legal.acme.example/privacy' },
    ]);
    expect(legalIndexUrl()).toBeNull();
  });

  it('answers null when ANY url does not end in its own slug', () => {
    // A url that is not `<base>/<slug>` cannot contribute a base, and skipping it
    // would leave the row pointing at the base of SOME of the documents — worse
    // than no row, because it looks like an index and is not one.
    restore = setLegalManifest([
      PUBLISHED_FIXTURE[0]!,
      { ...PUBLISHED_FIXTURE[1]!, url: 'https://motir.co/legal/privacy-policy' },
    ]);
    expect(legalIndexUrl()).toBeNull();
  });

  it('is not fooled by a slug appearing earlier in the url', () => {
    restore = setLegalManifest([
      { ...PUBLISHED_FIXTURE[0]!, url: 'https://motir.co/terms/legal/terms' },
    ]);
    expect(legalIndexUrl()).toBe('https://motir.co/terms/legal');
  });
});
