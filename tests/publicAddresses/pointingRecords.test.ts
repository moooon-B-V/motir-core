import { afterEach, describe, expect, it } from 'vitest';

import {
  POINTING_A_RECORDS_ENV_VAR,
  POINTING_AAAA_RECORDS_ENV_VAR,
  POINTING_CNAME_TARGET_ENV_VAR,
  isApexHostname,
  pointingRecordsFor,
} from '@/lib/publicAddresses/pointingRecords';

// THE POINTING RECORDS — Story MOTIR-3878 · MOTIR-4278 · MOTIR-4315.
//
// The defect this module closes was invisible because every layer was
// individually right: the adapter parsed the requirements, the DTO's type union
// allowed all three record types, and the pane rendered whatever it was handed.
// Nothing asserted that the array a customer READS is ever non-trivially
// populated. So these tests are written against the RECORD SET a customer would
// copy into their zone, never against the shape of a function's return value.

afterEach(() => {
  delete process.env[POINTING_CNAME_TARGET_ENV_VAR];
  delete process.env[POINTING_A_RECORDS_ENV_VAR];
  delete process.env[POINTING_AAAA_RECORDS_ENV_VAR];
});

function configure(): void {
  process.env[POINTING_CNAME_TARGET_ENV_VAR] = 'motir-marketing.fly.dev';
  process.env[POINTING_A_RECORDS_ENV_VAR] = '66.241.125.217';
  process.env[POINTING_AAAA_RECORDS_ENV_VAR] = '2a09:8280:1::17d:93fd:0';
}

describe('isApexHostname — which side of RFC 1034 §3.6.2 a hostname is on', () => {
  it('reads a two-label hostname as a ROOT domain', () => {
    for (const apex of ['acme.com', 'acme-roadmap.com', 'ACME.COM', 'acme.com.']) {
      expect(isApexHostname(apex), apex).toBe(true);
    }
  });

  it('reads three or more labels as a subdomain', () => {
    for (const sub of ['roadmap.acme.com', 'a.b.c.acme.com']) {
      expect(isApexHostname(sub), sub).toBe(false);
    }
  });

  it('a MULTI-LABEL public suffix IS a root domain — the label count\u2019s limit, inverted (MOTIR-4315)', () => {
    // This case is the previous one turned round rather than a new one. It used
    // to assert `acme.co.uk` reading as a SUBDOMAIN — the label count's
    // documented limit, written down so that the day the detection improved,
    // the expectation would say where to look. This is that day, so it says the
    // true thing instead: each of these is three or four labels and every one of
    // them is a zone apex a registrant bought, so none of them can take a CNAME.
    for (const apex of ['acme.co.uk', 'acme.com.au', 'acme.co.jp', 'acme.org.uk']) {
      expect(isApexHostname(apex), apex).toBe(true);
    }
  });

  it('a subdomain UNDER a multi-label public suffix is still a subdomain', () => {
    // The half the fix must not break: `roadmap.acme.co.uk` has four labels and
    // sits inside `acme.co.uk`'s zone, so it takes a CNAME. A rule that read
    // "three or more labels" would have got this right by accident and
    // `acme.co.uk` wrong for the same reason.
    for (const sub of ['roadmap.acme.co.uk', 'a.b.acme.com.au']) {
      expect(isApexHostname(sub), sub).toBe(false);
    }
  });

  it('reads the ICANN section ONLY — a name under a PRIVATE suffix takes a CNAME', () => {
    // `github.io` is on the PSL's PRIVATE section: nobody delegated
    // `myapp.github.io` as its own zone, so it is an ordinary record inside
    // GitHub's and a CNAME there is legal. Honouring the private section would
    // call it an apex and hand it address records — this bug pointing the other
    // way, which is why `allowPrivateDomains: false` is a decision and not a
    // default left in place.
    expect(isApexHostname('myapp.github.io')).toBe(false);
    expect(isApexHostname('github.io')).toBe(true);
  });

  // ── the NEW mechanism's own limits, asserted the way the old one's was ─────

  it('\u26a0\ufe0f a public suffix NEWER than our list degrades to the label count — limit 1', () => {
    // A suffix the pinned `tldts` has never heard of falls back to "the last
    // label is the suffix", which is exactly the rule MOTIR-4315 replaced. So a
    // registrable domain under a multi-label suffix added to the PSL after our
    // version still reads as a subdomain and is still offered a CNAME it cannot
    // create. Asserted, not merely written in the doc comment, so that the
    // refresh (`pnpm up tldts`) has something that says where to look — and so
    // that the limit cannot come back as a surprise.
    expect(isApexHostname('acme.co.example-suffix-not-in-the-list')).toBe(false);
    // The one-label half of the same fallback is right for the same reason it
    // was right before: two labels under an unknown suffix IS the apex.
    expect(isApexHostname('acme.example-suffix-not-in-the-list')).toBe(true);
  });

  it('\u26a0\ufe0f a privately DELEGATED subzone is invisible to any list — limit 2', () => {
    // A customer who delegated `roadmap.acme.co.uk` with NS records has a zone
    // apex there, carrying SOA, and it cannot take a CNAME either. No public
    // list can know a delegation nobody published; only a live SOA lookup on the
    // name can, which is the option MOTIR-4315 weighed and did not take. This
    // asserts the WRONG answer on purpose, so that it is a decision on the
    // record rather than a case nobody enumerated.
    expect(isApexHostname('roadmap.acme.co.uk')).toBe(false);
  });
});

describe('pointingRecordsFor — the record set follows the hostname’s SHAPE (ADR §5)', () => {
  it('a SUBDOMAIN gets exactly one CNAME, at its own name, pointing at the app', () => {
    configure();
    expect(pointingRecordsFor('roadmap.acme.com')).toEqual([
      { type: 'CNAME', name: 'roadmap.acme.com', value: 'motir-marketing.fly.dev' },
    ]);
  });

  it('an APEX gets A + AAAA and NEVER a CNAME — the whole reason the shapes differ', () => {
    configure();
    expect(pointingRecordsFor('acme-roadmap.com')).toEqual([
      { type: 'A', name: 'acme-roadmap.com', value: '66.241.125.217' },
      { type: 'AAAA', name: 'acme-roadmap.com', value: '2a09:8280:1::17d:93fd:0' },
    ]);
  });

  it('a multi-label-suffix ROOT domain gets A + AAAA and no CNAME (MOTIR-4315)', () => {
    // The customer-facing statement of the defect: this is the record set
    // `acme.co.uk` was NOT being offered, and a CNAME is what it was offered
    // instead — a record its DNS provider refuses at an apex.
    configure();
    for (const apex of ['acme.co.uk', 'acme.com.au']) {
      expect(pointingRecordsFor(apex), apex).toEqual([
        { type: 'A', name: apex, value: '66.241.125.217' },
        { type: 'AAAA', name: apex, value: '2a09:8280:1::17d:93fd:0' },
      ]);
    }
  });

  it('a subdomain under a multi-label suffix still gets exactly one CNAME', () => {
    configure();
    expect(pointingRecordsFor('roadmap.acme.co.uk')).toEqual([
      { type: 'CNAME', name: 'roadmap.acme.co.uk', value: 'motir-marketing.fly.dev' },
    ]);
  });

  it('an app holding SEVERAL addresses yields one row each, in order', () => {
    // `fly ips list` reports a SET. A customer pointed at one address of several
    // is pointed at a subset of the platform, so every configured address is a
    // record the customer creates.
    process.env[POINTING_A_RECORDS_ENV_VAR] = '66.241.125.217, 66.241.125.218';
    process.env[POINTING_AAAA_RECORDS_ENV_VAR] = '2a09:8280:1::17d:93fd:0';
    expect(pointingRecordsFor('acme.com')).toEqual([
      { type: 'A', name: 'acme.com', value: '66.241.125.217' },
      { type: 'A', name: 'acme.com', value: '66.241.125.218' },
      { type: 'AAAA', name: 'acme.com', value: '2a09:8280:1::17d:93fd:0' },
    ]);
  });

  it('normalises the hostname it was handed — case and a trailing dot', () => {
    configure();
    expect(pointingRecordsFor('Roadmap.ACME.com.')).toEqual([
      { type: 'CNAME', name: 'roadmap.acme.com', value: 'motir-marketing.fly.dev' },
    ]);
  });

  // ── the unconfigured arms: OMIT, never invent ────────────────────────────

  it('UNSET yields no record at all rather than a guessed target', () => {
    // The value a customer copies out of this table goes into a zone they own.
    // A default would point a domain they control at something we do not
    // operate — `tenantDomain.ts`'s rule, and the reason it has no default
    // either.
    expect(pointingRecordsFor('roadmap.acme.com')).toEqual([]);
    expect(pointingRecordsFor('acme.com')).toEqual([]);
  });

  it("an EMPTY value counts as unset — a secret cleared to '' is a misconfiguration", () => {
    process.env[POINTING_CNAME_TARGET_ENV_VAR] = '   ';
    process.env[POINTING_A_RECORDS_ENV_VAR] = '';
    expect(pointingRecordsFor('roadmap.acme.com')).toEqual([]);
    expect(pointingRecordsFor('acme.com')).toEqual([]);
  });

  it('a PARTIALLY configured apex yields the half that is known', () => {
    // An app with no dedicated IPv6 address is an ordinary state, and it must
    // not suppress the IPv4 record the customer can act on.
    process.env[POINTING_A_RECORDS_ENV_VAR] = '66.241.125.217';
    expect(pointingRecordsFor('acme.com')).toEqual([
      { type: 'A', name: 'acme.com', value: '66.241.125.217' },
    ]);
  });

  it('an EMPTY hostname yields nothing rather than a record with no name', () => {
    // Reachable in principle and never in practice: `normaliseCustomHostname`
    // refuses one at the door. Guarded anyway because the alternative is a row
    // in the pane whose Name column is blank — an instruction a customer would
    // try to follow.
    configure();
    expect(pointingRecordsFor('   ')).toEqual([]);
  });

  it('the CNAME target does NOT leak into the apex arm, nor the addresses into a subdomain', () => {
    // The two arms read different variables on purpose. A cross-wire would hand
    // an apex customer a CNAME they cannot create — the exact record shape §5's
    // table exists to keep apart.
    configure();
    expect(pointingRecordsFor('acme.com').map((r) => r.type)).toEqual(['A', 'AAAA']);
    expect(pointingRecordsFor('roadmap.acme.com').map((r) => r.type)).toEqual(['CNAME']);
  });
});
