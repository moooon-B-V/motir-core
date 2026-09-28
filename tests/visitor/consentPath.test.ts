import { describe, expect, it } from 'vitest';
import {
  visitorConsentNext,
  visitorConsentPath,
  visitorGoBackHref,
  visitorSignInPath,
} from '@/lib/visitor/consentPath';
import { sanitizeNextPath } from '@/lib/navigation/nextDestination';

// The consent screen's addresses (Story MOTIR-6170 · MOTIR-6669): where it sends a
// reader afterwards, the two-hop sign-in hand-off, and where Go back leaves to.

describe('visitorConsentNext — only this project’s Visitor views', () => {
  it('keeps a view inside the project, query included', () => {
    expect(visitorConsentNext('ACME', '/p/ACME/board')).toBe('/p/ACME/board');
    expect(visitorConsentNext('ACME', '/p/ACME/items/ACME-7')).toBe('/p/ACME/items/ACME-7');
    expect(visitorConsentNext('ACME', '/p/ACME/items?view=tree')).toBe('/p/ACME/items?view=tree');
  });

  it('falls back to the board for anything else', () => {
    for (const bad of [
      undefined,
      '',
      'https://evil.example/p/ACME/board',
      '//evil.example/p/ACME/board',
      '/p/OTHER/board',
      '/p/ACME',
      '/p/ACME/',
      '/p/ACME/consent',
      '/p/ACME/consent?next=/p/ACME/board',
      '/p/ACME/../ADMIN/board',
      '/items',
      '/p/ACMEX/board',
    ]) {
      expect(visitorConsentNext('ACME', bad), String(bad)).toBe('/p/ACME/board');
    }
  });
});

describe('the sign-in hand-off carries two hops', () => {
  it('sign-in → consent → the view, each hop admitted by sanitizeNextPath', () => {
    const signIn = visitorSignInPath('ACME', '/p/ACME/roadmap');
    const url = new URL(signIn, 'https://app.motir.co');
    expect(url.pathname).toBe('/sign-in');
    const consent = sanitizeNextPath(url.searchParams.get('next') ?? undefined);
    expect(consent).toBe(visitorConsentPath('ACME', '/p/ACME/roadmap'));
    const consentUrl = new URL(consent!, 'https://app.motir.co');
    expect(consentUrl.pathname).toBe('/p/ACME/consent');
    expect(visitorConsentNext('ACME', consentUrl.searchParams.get('next') ?? undefined)).toBe(
      '/p/ACME/roadmap',
    );
  });
});

describe('visitorGoBackHref', () => {
  const base = {
    identifier: 'ACME',
    publicOrigin: 'https://motir.co',
    appOrigin: 'https://app.motir.co',
  };

  it('returns to the project’s motir.co page when the reader came from there', () => {
    expect(visitorGoBackHref({ ...base, referer: 'https://motir.co/p/ACME' })).toBe(
      'https://motir.co/p/ACME',
    );
  });

  it('otherwise leaves to the app root', () => {
    expect(visitorGoBackHref({ ...base, referer: null })).toBe('/');
    expect(visitorGoBackHref({ ...base, referer: 'https://evil.example/p/ACME' })).toBe('/');
    expect(visitorGoBackHref({ ...base, referer: 'not a url' })).toBe('/');
  });

  it('never counts the app itself as motir.co while the public origin is unconfigured', () => {
    expect(
      visitorGoBackHref({
        identifier: 'ACME',
        referer: 'https://app.motir.co/p/ACME/board',
        publicOrigin: 'https://app.motir.co',
        appOrigin: 'https://app.motir.co',
      }),
    ).toBe('/');
  });
});
