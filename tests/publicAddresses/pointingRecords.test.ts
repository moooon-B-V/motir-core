import { afterEach, describe, expect, it } from 'vitest';

import {
  POINTING_A_RECORDS_ENV_VAR,
  POINTING_AAAA_RECORDS_ENV_VAR,
  POINTING_CNAME_TARGET_ENV_VAR,
  isApexHostname,
  pointingRecordsFor,
} from '@/lib/publicAddresses/pointingRecords';

// THE POINTING RECORDS — Story MOTIR-3878 · MOTIR-4278.
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

  it('⚠️ a MULTI-LABEL public suffix reads as a subdomain — the documented limit', () => {
    // `acme.co.uk` IS a root domain and cannot take a CNAME, and a label count
    // cannot know that without a public-suffix list. Asserted rather than left
    // implicit so the day the detection improves, this expectation is what says
    // where to look — and so the limitation cannot be quietly re-introduced as a
    // surprise. Logged as its own bug against MOTIR-4278.
    expect(isApexHostname('acme.co.uk')).toBe(false);
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
