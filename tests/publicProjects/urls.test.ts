import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  derivePublicDescription,
  publicProjectPath,
  publicProjectUrl,
} from '@/lib/publicProjects/urls';

// The site-relative path helper backs the `?next=` return-to-this-page wiring in
// PublicTopBar (MOTIR-990 #3) and the absolute canonical/OpenGraph URL.

describe('publicProjectPath', () => {
  it('is the site-relative /p/<identifier> path', () => {
    expect(publicProjectPath('MOTIR')).toBe('/p/MOTIR');
  });

  it('URL-encodes the identifier so it is a safe path segment', () => {
    expect(publicProjectPath('a b/c')).toBe('/p/a%20b%2Fc');
  });
});

describe('publicProjectUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefixes the configured site origin to the public path (no double slash)', () => {
    vi.stubEnv('MOTIR_BASE_URL', 'https://motir.co/');
    expect(publicProjectUrl('MOTIR')).toBe('https://motir.co/p/MOTIR');
  });

  it('composes from the same path helper (identifier stays encoded)', () => {
    vi.stubEnv('MOTIR_BASE_URL', 'https://motir.co');
    expect(publicProjectUrl('a b')).toBe(`https://motir.co${publicProjectPath('a b')}`);
  });

  // MOTIR-4242 — the two arms of `publicSiteOrigin()`, read off THIS module,
  // because this is the accessor the settings room now depends on for the
  // address it hands a customer. The seam suite asserts the same split from the
  // consumer side (`tests/hosting/appUrlSeam.test.ts`); this is the unit half,
  // and the two are worth having separately: a change to the fallback would be
  // a change to the ordering guarantee, not a refactor.

  it('the PUBLIC variable OVERRIDES the application origin when it is set', () => {
    vi.stubEnv('MOTIR_BASE_URL', 'https://app.motir.co');
    vi.stubEnv('MOTIR_PUBLIC_SITE_URL', 'https://motir.co');
    expect(publicProjectUrl('MOTIR')).toBe('https://motir.co/p/MOTIR');
  });

  it('UNSET falls back to the application origin — the ordering guarantee (MOTIR-3881)', () => {
    // Deliberate, and load-bearing: until `motir.co` renders these pages the
    // canonical, `og:url` and sitemap entries must keep naming the host that is
    // actually serving them. So this is the state today, and the retargeted
    // settings room follows the variable rather than hard-coding a host — the
    // links become right at the cutover, with no second code change.
    vi.stubEnv('MOTIR_BASE_URL', 'https://app.motir.co');
    vi.stubEnv('MOTIR_PUBLIC_SITE_URL', undefined);
    expect(publicProjectUrl('MOTIR')).toBe('https://app.motir.co/p/MOTIR');
  });
});

// MOTIR-3885 — the story's gate found this function shipped with no test of its
// own: 45% of the module's statements and 25% of its branches, on the one helper
// that decides what a search result and a social card SAY about a project.
//
// It matters more than its size suggests. Both the `<meta name="description">`
// and the JSON-LD description are built here, from the same call, so a bug is
// visible to a crawler and a link preview at once and invisible to the person
// who wrote the README.
describe('derivePublicDescription', () => {
  const FALLBACK = 'A project on Motir.';

  it('uses the fallback when there is no README at all', () => {
    expect(derivePublicDescription(null, FALLBACK)).toBe(FALLBACK);
  });

  it('uses the fallback when the README strips down to nothing', () => {
    // A README that is only syntax — a rule, a heading marker, a code fence —
    // has no sentence in it, and an empty description is worse than a generic
    // one: a crawler shows the URL instead.
    expect(derivePublicDescription('## \n\n```\ncode\n```', FALLBACK)).toBe(FALLBACK);
  });

  it('strips Markdown syntax rather than publishing it', () => {
    const text = derivePublicDescription('# Title\n\n**Bold** and `code` and _more_.', FALLBACK);
    expect(text).not.toMatch(/[#*`_]/);
    expect(text).toContain('Bold');
  });

  it('keeps a link’s TEXT and drops its target', () => {
    const text = derivePublicDescription('See [the docs](https://example.test/docs).', FALLBACK);
    expect(text).toContain('the docs');
    expect(text).not.toContain('example.test');
  });

  it('drops fenced code blocks entirely', () => {
    const text = derivePublicDescription('Intro.\n\n```ts\nconst secret = 1;\n```', FALLBACK);
    expect(text).toContain('Intro.');
    expect(text).not.toContain('secret');
  });

  it('collapses whitespace, so a multi-line README is one line', () => {
    expect(derivePublicDescription('One\n\n\nTwo   three', FALLBACK)).toBe('One Two three');
  });

  it('truncates past 160 characters and ends with an ellipsis, not a cut word', () => {
    const long = `${'word '.repeat(60)}end`;
    const text = derivePublicDescription(long, FALLBACK);
    expect(text.length).toBeLessThanOrEqual(160);
    expect(text.endsWith('…')).toBe(true);
    // The trim happens BEFORE the ellipsis, so the result never reads
    // "word …" with a stranded space.
    expect(text).not.toMatch(/\s…$/);
  });

  it('leaves a description that already fits exactly as it is', () => {
    expect(derivePublicDescription('Short and complete.', FALLBACK)).toBe('Short and complete.');
  });
});
