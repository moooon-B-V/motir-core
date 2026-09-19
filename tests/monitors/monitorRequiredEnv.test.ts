import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MONITOR_CONFIG_BLIND_SPOT,
  fakeMonitorProvider,
  getMonitorProvider,
  missingProviderEnv,
  registerMonitorProvider,
  registeredMonitorProviderIds,
  sentryMonitorProvider,
  verifyMonitorProviderConfig,
} from '@/lib/monitors';
import { SENTRY_REQUIRED_ENV } from '@/lib/monitors/providers/sentry';

// THE DECLARATION MATCHES THE READS (MOTIR-5831).
//
// `MonitorProvider.requiredEnv` is a list of names written by a person, and the
// reads are `process.env[...]` expressions somewhere else. A list and its reads
// drifting apart is the ENTIRE failure this card is about, one level up — the
// deployment's record said four values were set and the platform disagreed for
// seven days — so a declaration nothing checks would reproduce the defect inside
// the fix.
//
// ⚠️ THE CARD ASKED FOR THIS TEST IN A FORM THAT IS FALSE FOR ONE OF THE THREE
// NAMES, and the amendment is on the work item with its evidence. Its criterion
// read: "unsetting each declared name in turn makes `appCredentials()` throw".
// `appCredentials()` (`lib/monitors/providers/sentry.ts`) reads
// `SENTRY_APP_CLIENT_ID` and `SENTRY_APP_CLIENT_SECRET` and nothing else;
// `SENTRY_APP_SLUG` is read by `externalInstallUrl()` in
// `app/api/monitors/sentry/oauth/start/route.ts`. Measured on `origin/main` at
// dab92792 with `grep -rn 'SENTRY_APP_SLUG' --include='*.ts' .`, which returns
// that route, `.env.example`, the Playwright acceptance config and two tests —
// and no adapter read at all.
//
// So the criterion's INTENT is kept and its mechanism is corrected: every
// declared name is pinned to the read that actually consumes it, in BOTH
// directions. A name declared with no read fails, and a read with no declaration
// fails.

const ROOT = process.cwd();
const ADAPTER = 'lib/monitors/providers/sentry.ts';
const START_ROUTE = 'app/api/monitors/sentry/oauth/start/route.ts';

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/** Every `process.env['X']` / `process.env.X` name a source file reads. */
function envNamesReadBy(path: string): Set<string> {
  const source = read(path);
  const names = new Set<string>();
  for (const m of source.matchAll(/process\.env\[\s*['"]([A-Z0-9_]+)['"]\s*\]/g)) names.add(m[1]!);
  for (const m of source.matchAll(/process\.env\.([A-Z0-9_]+)\b/g)) names.add(m[1]!);
  return names;
}

describe('a monitor provider DECLARES the environment it needs', () => {
  it('sentry declares exactly its three names, and the fake declares none', () => {
    expect(sentryMonitorProvider.requiredEnv).toEqual([
      'SENTRY_APP_CLIENT_ID',
      'SENTRY_APP_CLIENT_SECRET',
      'SENTRY_APP_SLUG',
    ]);
    // The fake opens no socket and has no credential to install. This is what
    // keeps every acceptance run green under `MOTIR_MONITOR_FAKE_PROVIDER=1`,
    // which re-registers it UNDER `sentry`.
    expect(fakeMonitorProvider.requiredEnv).toEqual([]);
  });

  it('every DECLARED name is actually READ by the module that consumes it', () => {
    const adapterReads = envNamesReadBy(ADAPTER);
    const routeReads = envNamesReadBy(START_ROUTE);
    const allReads = new Set([...adapterReads, ...routeReads]);

    for (const name of SENTRY_REQUIRED_ENV) {
      expect(allReads.has(name), `${name} is declared but nothing reads it`).toBe(true);
    }
    // And the two halves are pinned individually, so a name silently moving
    // between them is a failure rather than a wash.
    expect(adapterReads).toContain('SENTRY_APP_CLIENT_ID');
    expect(adapterReads).toContain('SENTRY_APP_CLIENT_SECRET');
    expect(routeReads).toContain('SENTRY_APP_SLUG');
  });

  it('every REQUIRED read has a declaration — the direction that catches a new variable', () => {
    // The reverse sweep. A `SENTRY_*` read WITHOUT a fallback and WITHOUT a
    // default is required by definition, so it owes a declaration; the two
    // documented exceptions are named here rather than pattern-matched, because
    // "has a default" is a property of the code and not of the name.
    const OPTIONAL = new Set([
      // Both have a literal default in the expression that reads them.
      'SENTRY_API_BASE_URL',
      'SENTRY_WEB_BASE_URL',
    ]);
    const sentryReads = [...envNamesReadBy(ADAPTER), ...envNamesReadBy(START_ROUTE)].filter((n) =>
      n.startsWith('SENTRY_'),
    );
    const undeclared = sentryReads.filter(
      (n) => !OPTIONAL.has(n) && !SENTRY_REQUIRED_ENV.includes(n as never),
    );
    expect(undeclared, 'a required SENTRY_* read carries no requiredEnv declaration').toEqual([]);
  });

  it('unsetting a CREDENTIAL name makes the grant exchange refuse, naming the variables', async () => {
    // The half of the card's criterion that IS about `appCredentials()`. It is
    // reached through the seam rather than called directly, because
    // `appCredentials` is module-private — which is the honest way to assert "the
    // read depends on this name".
    const saved = {
      id: process.env['SENTRY_APP_CLIENT_ID'],
      secret: process.env['SENTRY_APP_CLIENT_SECRET'],
    };
    try {
      for (const missing of ['SENTRY_APP_CLIENT_ID', 'SENTRY_APP_CLIENT_SECRET'] as const) {
        process.env['SENTRY_APP_CLIENT_ID'] = 'id';
        process.env['SENTRY_APP_CLIENT_SECRET'] = 'secret';
        delete process.env[missing];
        await expect(
          sentryMonitorProvider.exchangeGrant({ installationId: 'inst', code: 'code' }),
        ).rejects.toThrow(/SENTRY_APP_CLIENT_ID and SENTRY_APP_CLIENT_SECRET are not set/);
      }
    } finally {
      if (saved.id === undefined) delete process.env['SENTRY_APP_CLIENT_ID'];
      else process.env['SENTRY_APP_CLIENT_ID'] = saved.id;
      if (saved.secret === undefined) delete process.env['SENTRY_APP_CLIENT_SECRET'];
      else process.env['SENTRY_APP_CLIENT_SECRET'] = saved.secret;
    }
  });

  it('`appCredentials()` is still a CALL-TIME read — the boundary the card forbids crossing', () => {
    // A module-load read would crash a deployment that never registered the
    // integration, which is the property MOTIR-5831 explicitly does not change.
    // The tell is structural: the names are read INSIDE a function body.
    const source = read(ADAPTER);
    const body = source.slice(source.indexOf('function appCredentials'));
    expect(body).toContain("process.env['SENTRY_APP_CLIENT_ID']");
    // And no top-level `const … = process.env['SENTRY_APP_CLIENT_…']` anywhere.
    expect(source).not.toMatch(/^const\s+\w+\s*=\s*process\.env\[\s*['"]SENTRY_APP_CLIENT/m);
  });
});

describe('the configuration preflight', () => {
  const SENTRY_NAMES = ['SENTRY_APP_CLIENT_ID', 'SENTRY_APP_CLIENT_SECRET', 'SENTRY_APP_SLUG'];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(SENTRY_NAMES.map((n) => [n, process.env[n]]));
    for (const n of SENTRY_NAMES) delete process.env[n];
    // The suite may have left the fake registered under `sentry`; this describe
    // is about the REAL adapter's declaration.
    registerMonitorProvider(sentryMonitorProvider, 'sentry');
  });

  afterEach(() => {
    for (const [n, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
    registerMonitorProvider(sentryMonitorProvider, 'sentry');
  });

  it('reads EVERY registered provider, through the registry', () => {
    const verdict = verifyMonitorProviderConfig();
    expect(verdict.providers.map((p) => p.providerId).sort()).toEqual(
      registeredMonitorProviderIds().sort(),
    );
    for (const report of verdict.providers) {
      expect(report.required).toEqual(getMonitorProvider(report.providerId).requiredEnv);
    }
  });

  it('is QUIET when a provider has none of its names — a deployment that never connected one', () => {
    const verdict = verifyMonitorProviderConfig();
    expect(verdict.verdict).toBe('not_applicable');
  });

  it('is COMPLETE when every name a configured provider declares is set', () => {
    for (const n of SENTRY_NAMES) process.env[n] = 'value';
    const verdict = verifyMonitorProviderConfig();
    expect(verdict.verdict).toBe('complete');
  });

  it('is INCOMPLETE — and names the variable and the provider — when ONE is missing', () => {
    // ⚠️ THE CARD'S CENTRAL FIXTURE, reproduced: three of the four values
    // MOTIR-5257 staged were present and `SENTRY_APP_CLIENT_SECRET` was not, for
    // seven days, with every surface reporting normally.
    process.env['SENTRY_APP_CLIENT_ID'] = 'id';
    process.env['SENTRY_APP_SLUG'] = 'motir';

    const verdict = verifyMonitorProviderConfig();
    expect(verdict.verdict).toBe('incomplete');
    if (verdict.verdict !== 'incomplete') return;
    expect(verdict.offenders).toHaveLength(1);
    expect(verdict.offenders[0]!.providerId).toBe('sentry');
    expect(verdict.offenders[0]!.missing).toEqual(['SENTRY_APP_CLIENT_SECRET']);
    expect(verdict.detail).toContain('SENTRY_APP_CLIENT_SECRET');
    expect(verdict.detail).toContain('sentry');
  });

  it('treats an EMPTY STRING as absent — the shape a dropped line break leaves', () => {
    process.env['SENTRY_APP_CLIENT_ID'] = 'id';
    process.env['SENTRY_APP_SLUG'] = 'motir';
    process.env['SENTRY_APP_CLIENT_SECRET'] = '';
    const verdict = verifyMonitorProviderConfig();
    expect(verdict.verdict).toBe('incomplete');
  });

  it('NEVER reports a value, a length or a digest — only whether the name is set', () => {
    // A distinctive value, so a leak anywhere in the serialized verdict is
    // findable by substring rather than by inspection.
    const SECRET = 'zzq-do-not-leak-me-5831';
    process.env['SENTRY_APP_CLIENT_ID'] = SECRET;
    process.env['SENTRY_APP_SLUG'] = 'motir';

    const verdict = verifyMonitorProviderConfig();
    const serialized = JSON.stringify(verdict);
    expect(serialized).not.toContain(SECRET);
    // And no length of it either — the value is 23 characters, and nothing in the
    // verdict should be reporting a size at all.
    expect(serialized).not.toContain(String(SECRET.length));
    expect(serialized).not.toMatch(/sha256|digest|length/i);
  });

  it('carries the blind spot on EVERY arm, including the green ones', () => {
    expect(verifyMonitorProviderConfig().blindSpot).toBe(MONITOR_CONFIG_BLIND_SPOT);
    for (const n of SENTRY_NAMES) process.env[n] = 'value';
    expect(verifyMonitorProviderConfig().blindSpot).toBe(MONITOR_CONFIG_BLIND_SPOT);
    expect(MONITOR_CONFIG_BLIND_SPOT).toContain('EVERY declared name');
  });

  it('`missingProviderEnv` answers for ONE provider, and an all-absent one is missing everything', () => {
    // The route's question is NOT the probe's: for the provider a person is
    // trying to connect right now, an all-absent declaration is the most definite
    // refusal there is — which is why the route does not reuse the verdict.
    expect(missingProviderEnv('sentry')).toEqual(SENTRY_NAMES);
    process.env['SENTRY_APP_CLIENT_ID'] = 'id';
    expect(missingProviderEnv('sentry')).toEqual(['SENTRY_APP_CLIENT_SECRET', 'SENTRY_APP_SLUG']);
    for (const n of SENTRY_NAMES) process.env[n] = 'value';
    expect(missingProviderEnv('sentry')).toEqual([]);
  });

  it('a provider declaring NOTHING is never an offender — the E2E fake under `sentry`', () => {
    registerMonitorProvider(fakeMonitorProvider, 'sentry');
    const verdict = verifyMonitorProviderConfig();
    expect(verdict.verdict).toBe('not_applicable');
    expect(verdict.providers.every((p) => p.missing.length === 0)).toBe(true);
  });
});
