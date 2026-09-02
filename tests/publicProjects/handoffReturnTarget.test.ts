import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HANDOFF_FALLBACK_PATH,
  resolveHandoffDestination,
  resolvePublicReturnTarget,
} from '@/lib/publicProjects/returnTarget';

// The HAND-OFF's return destination (MOTIR-4114 · `public-surface-hosts.md`
// AMENDMENT 4 §F) — the one piece of this card that takes a value from another
// origin and turns it into a redirect.
//
// ⚠️ THE HOSTILE CASES ARE THE POINT, and they are enumerated rather than
// sampled. `proxy.ts`'s `CURRENT_PATH_HEADER` doc calls an unvalidated redirect
// target "the one way this small piece of plumbing could ship a vulnerability",
// and every case below is a value that a `startsWith`, a `hostname` check or a
// deny-list would have let through while an ORIGIN comparison refuses it.

const PUBLIC_ORIGIN = 'https://motir.co';

describe('resolvePublicReturnTarget', () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env['MOTIR_PUBLIC_SITE_URL'];
    process.env['MOTIR_PUBLIC_SITE_URL'] = PUBLIC_ORIGIN;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env['MOTIR_PUBLIC_SITE_URL'];
    else process.env['MOTIR_PUBLIC_SITE_URL'] = previous;
  });

  it('admits a URL on the configured public origin', () => {
    expect(resolvePublicReturnTarget('https://motir.co/p/ACME')).toBe('https://motir.co/p/ACME');
  });

  it('admits a path, a query and a fragment on that origin', () => {
    expect(resolvePublicReturnTarget('https://motir.co/p/ACME/items?page=2#top')).toBe(
      'https://motir.co/p/ACME/items?page=2#top',
    );
  });

  it('takes the FIRST value of a repeated parameter, then judges it on its merits', () => {
    // The same rule `sanitizeNextPath` applies. Note the second value is
    // hostile: taking the last one would be a way past the check.
    expect(resolvePublicReturnTarget(['https://motir.co/p/ACME', 'https://evil.example'])).toBe(
      'https://motir.co/p/ACME',
    );
    expect(
      resolvePublicReturnTarget(['https://evil.example', 'https://motir.co/p/ACME']),
    ).toBeNull();
  });

  describe('refuses — each of these defeats a check somebody would plausibly write', () => {
    const HOSTILE: Array<[string, string]> = [
      ['https://evil.example/', 'a different origin outright'],
      ['//evil.example', 'protocol-relative — no scheme, so it is not even a URL'],
      ['/../', 'a relative path — it would resolve against THIS origin'],
      ['/p/ACME', 'a bare path — same reason: it is not the public site'],
      [
        'https://motir.co.evil.test/p/ACME',
        'a SUFFIX attack — `startsWith(origin)` fails here, `origin` equality does not',
      ],
      [
        'https://motir.co@evil.test/p/ACME',
        'userinfo — the URL parser reads the host as evil.test, which is why the ' +
          'comparison is against `origin` and not against the raw string',
      ],
      ['http://motir.co/p/ACME', 'the right host on the WRONG SCHEME — `origin` includes it'],
      ['https://motir.co:8443/p/ACME', 'the right host on the wrong PORT — likewise'],
      ['https://sub.motir.co/p/ACME', 'a subdomain is a different origin'],
      ['javascript:alert(1)', 'a scheme that is not a location at all'],
      ['data:text/html,<script>alert(1)</script>', 'the same, in the form people forget'],
      ['', 'empty'],
      ['   ', 'whitespace — not a URL, so it parses as nothing'],
      ['not a url at all', 'unparseable'],
    ];

    for (const [value, why] of HOSTILE) {
      it(`${JSON.stringify(value)} — ${why}`, () => {
        expect(resolvePublicReturnTarget(value)).toBeNull();
      });
    }

    it('undefined and an empty array', () => {
      expect(resolvePublicReturnTarget(undefined)).toBeNull();
      expect(resolvePublicReturnTarget([])).toBeNull();
    });
  });

  it('the allowed origin MOVES with the configuration — it is not a literal', () => {
    process.env['MOTIR_PUBLIC_SITE_URL'] = 'https://public.example';

    expect(resolvePublicReturnTarget('https://public.example/p/ACME')).toBe(
      'https://public.example/p/ACME',
    );
    expect(resolvePublicReturnTarget('https://motir.co/p/ACME')).toBeNull();
  });
});

describe('resolveHandoffDestination', () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env['MOTIR_PUBLIC_SITE_URL'];
    process.env['MOTIR_PUBLIC_SITE_URL'] = PUBLIC_ORIGIN;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env['MOTIR_PUBLIC_SITE_URL'];
    else process.env['MOTIR_PUBLIC_SITE_URL'] = previous;
  });

  it('returns the destination when it is allowed', () => {
    expect(resolveHandoffDestination('https://motir.co/p/ACME')).toBe('https://motir.co/p/ACME');
  });

  it('falls back to a FIXED path when it is not — never to something nearby', () => {
    // Salvaging a refused URL into "the same path on our own host" would be
    // trusting a value we have just decided not to trust.
    expect(resolveHandoffDestination('https://evil.example/p/ACME')).toBe(HANDOFF_FALLBACK_PATH);
    expect(resolveHandoffDestination(undefined)).toBe(HANDOFF_FALLBACK_PATH);
    expect(HANDOFF_FALLBACK_PATH.startsWith('/')).toBe(true);
  });
});
