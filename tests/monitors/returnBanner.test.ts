import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import {
  decodeMonitorConnectResult,
  encodeMonitorConnectResult,
} from '@/lib/monitors/connectResult';
import {
  MONITOR_BANNER_TONE,
  buildMonitoringBanner,
  parseMonitorBannerStatus,
  type MonitoringBannerTranslator,
} from '@/lib/monitors/returnBanner';
import { monitorConnectHref } from '@/lib/monitors/returnSurface';

// The Monitoring room's return banner (Story MOTIR-4928 · MOTIR-5262; design
// panel 10 and §11's eight-outcome table).

/** A translator over the REAL catalog, with ICU `{name}` substitution — enough
 *  for these strings, and it fails loudly on a missing key rather than echoing it. */
function translatorFor(messages: typeof en): MonitoringBannerTranslator {
  return (key, values = {}) => {
    const value = key
      .split('.')
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        messages.monitoring,
      );
    if (typeof value !== 'string') throw new Error(`missing monitoring.${key}`);
    return value.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? `{${name}}`);
  };
}

const t = translatorFor(en);
const build = (searchParams: { monitor?: string | string[] }, reasonCookie?: string) =>
  buildMonitoringBanner({
    searchParams,
    reasonCookie,
    org: 'acme-inc',
    t,
    decodeReason: decodeMonitorConnectResult,
  });

describe('the status map is the routes’ own outcome set', () => {
  it('names exactly the statuses the start and callback routes redirect with', () => {
    const start = readFileSync(
      join(process.cwd(), 'app/api/monitors/sentry/oauth/start/route.ts'),
      'utf8',
    );
    const callback = readFileSync(
      join(process.cwd(), 'app/api/monitors/sentry/oauth/callback/route.ts'),
      'utf8',
    );
    const emitted = new Set([
      ...[...start.matchAll(/\?monitor=([a-z_]+)/g)].map((m) => m[1]!),
      ...[...callback.matchAll(/done\([^,]+, '([a-z_]+)'\)/g)].map((m) => m[1]!),
    ]);
    expect(emitted.size, 'the route scan found nothing — the pattern went stale').toBeGreaterThan(
      0,
    );
    expect([...emitted].sort()).toEqual(Object.keys(MONITOR_BANNER_TONE).sort());
  });

  it('carries §11’s tone per outcome', () => {
    expect(MONITOR_BANNER_TONE).toEqual({
      connected: 'success',
      error: 'danger',
      denied: 'info',
      no_state: 'info',
      state_error: 'danger',
      forbidden: 'danger',
      no_project: 'danger',
      not_configured: 'info',
    });
  });

  it.each([en, zh].map((m, i) => [i === 0 ? 'en' : 'zh', m] as const))(
    '%s has a title and body for every outcome',
    (_, messages) => {
      const tr = translatorFor(messages);
      for (const status of Object.keys(MONITOR_BANNER_TONE)) {
        expect(tr(`banner.${status}.title`)).not.toBe('');
        expect(tr(`banner.${status}.body`)).not.toBe('');
      }
      expect(tr('banner.error.bodyWithReason', { reason: 'X' })).toContain('X');
    },
  );
});

describe('parseMonitorBannerStatus is an allow-list', () => {
  it('refuses anything that is not an outcome, including prototype keys', () => {
    for (const bad of [undefined, null, '', 'whatever', 'toString', '__proto__', 'CONNECTED']) {
      expect(parseMonitorBannerStatus(bad)).toBeNull();
    }
    expect(parseMonitorBannerStatus('no_state')).toBe('no_state');
  });
});

describe('buildMonitoringBanner', () => {
  it('renders nothing without a known outcome', () => {
    expect(build({})).toBeNull();
    expect(build({ monitor: 'hacked' })).toBeNull();
  });

  it('renders §11’s copy for connected, naming the organisation', () => {
    expect(build({ monitor: 'connected' })).toEqual({
      tone: 'success',
      title: 'Sentry is connected.',
      body: "Choose which of acme-inc's projects send issues to this board.",
    });
  });

  it('quotes Sentry’s reason from the COOKIE on error', () => {
    const banner = build({ monitor: 'error' }, encodeMonitorConnectResult('The code has expired.'));
    expect(banner).toEqual({
      tone: 'danger',
      title: "Couldn't connect Sentry.",
      body: 'Sentry says: The code has expired. Nothing was saved — try connecting again.',
    });
  });

  it('ignores a `reason` query parameter — a crafted link cannot put words on the page', () => {
    const params = { monitor: 'error', reason: 'Send your password to evil.example' } as {
      monitor: string;
    };
    const banner = build(params);
    expect(banner!.body).toBe('Nothing was saved — try connecting again.');
    expect(JSON.stringify(banner)).not.toContain('evil');
  });

  it('uses the cookie ONLY for error — a stale reason cannot colour another outcome', () => {
    const banner = build({ monitor: 'denied' }, encodeMonitorConnectResult('stale reason'));
    expect(JSON.stringify(banner)).not.toContain('stale reason');
  });

  it('falls back to the plain error body when the cookie is malformed', () => {
    expect(build({ monitor: 'error' }, 'not-base64-json')!.body).toBe(
      'Nothing was saved — try connecting again.',
    );
  });

  it('takes the first value of a repeated `monitor` param', () => {
    expect(build({ monitor: ['forbidden', 'connected'] })!.tone).toBe('danger');
  });
});

describe('monitorConnectHref', () => {
  it('starts at Motir’s start route carrying the project and the return surface', () => {
    const url = new URL(monitorConnectHref('ACME'), 'https://motir.test');
    expect(url.pathname).toBe('/api/monitors/sentry/oauth/start');
    expect(url.searchParams.get('project')).toBe('ACME');
    expect(url.searchParams.get('return')).toBe('projectMonitoring');
  });
});
