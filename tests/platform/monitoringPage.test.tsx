// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFormatter, createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import type { PlatformHealthDTO, PlatformSignalDTO } from '@/lib/dto/platformHealth';
import { renderToHtml } from '../helpers/serverPageHarness';

// THE MONITORING BOARD'S RENDER (Story 10.2 · MOTIR-743) — the three changed
// cards in every state the 10.2.1 delta draws, rendered with the REAL `en`
// catalogue, because the property under test is the words: a card that cannot
// read its source names the reason and shows no digit.
//
// The service is stubbed at its seam: what the cards SAY for each DTO is this
// suite's question, and `platformHealthService.test.ts` owns what the service
// returns. The staff gate is mocked the way that suite mocks it.

const { read } = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock('@/lib/platform/auth', () => ({
  requirePlatformStaff: vi.fn(async () => ({
    userId: 'u1',
    email: 'ops@moooon.net',
    role: 'support',
  })),
}));
vi.mock('@/lib/services/platformHealthService', () => ({ platformHealthService: { read } }));
vi.mock('@/lib/services/platformIndexAllowanceService', () => ({
  platformIndexAllowanceService: { read: vi.fn(async () => null) },
}));
vi.mock('@/app/(admin)/admin/monitoring/_components/IndexAllowanceSection', () => ({
  IndexAllowanceSection: () => null,
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: en, namespace: namespace as 'platformAdmin' }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));

const { default: AdminMonitoringPage } = await import('@/app/(admin)/admin/monitoring/page');

const UNCHANGED: PlatformSignalDTO[] = [
  { id: 'database', state: 'healthy', values: { ms: 4, region: 'iad' }, linkOut: null },
  {
    id: 'gateway',
    state: 'healthy',
    values: { ms: 42, version: 'v1', since: '2026-10-01T00:00:00Z', threshold: 1000 },
    linkOut: null,
  },
  { id: 'schedules', state: 'healthy', values: { overdue: 0, total: 5 }, linkOut: null },
  { id: 'failedJobs', state: 'healthy', values: { standing: 0, count: 0 }, linkOut: null },
  {
    id: 'lastHealthCheck',
    state: 'healthy',
    values: { ranAt: '2026-10-02T06:00:00Z', status: 'ok' },
    linkOut: null,
  },
];

const HOSTING_IDENTITY = { app: 'motir-core', region: 'iad', machineId: 'web1' };
const HOSTING_COUNTS = { appStarted: 2, appExpected: 2, workerStarted: 1, workerExpected: 1 };

function board(hosting: PlatformSignalDTO, errors: PlatformSignalDTO): PlatformHealthDTO {
  return {
    checkedAt: '2026-10-02T12:00:00Z',
    signals: [
      UNCHANGED[0],
      hosting,
      UNCHANGED[1],
      UNCHANGED[2],
      UNCHANGED[3],
      errors,
      UNCHANGED[4],
    ],
    overdue: [],
    overdueTotal: 0,
    schedulesChecked: 5,
  };
}

const HEALTHY_HOSTING: PlatformSignalDTO = {
  id: 'hosting',
  state: 'healthy',
  values: { ...HOSTING_IDENTITY, ...HOSTING_COUNTS, release: 'deployment-01K6' },
  linkOut: 'https://fly.io/apps/motir-core',
};
const HEALTHY_ERRORS: PlatformSignalDTO = {
  id: 'errors',
  state: 'healthy',
  values: { count: 12, windowHours: 24, threshold: 100 },
  linkOut: null,
};

async function render(hosting = HEALTHY_HOSTING, errors = HEALTHY_ERRORS): Promise<string> {
  read.mockResolvedValue(board(hosting, errors));
  const html = await renderToHtml(await AdminMonitoringPage({ searchParams: Promise.resolve({}) }));
  // Decode the entities React escapes, so the copy reads as written.
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');
}

/** The text of the card titled `title` — from its title to the next card's. */
function card(html: string, title: string): string {
  const text = html.replace(/<[^>]+>/g, '|');
  const start = text.indexOf(`|${title}|`);
  expect(start, `no ${title} card`).toBeGreaterThanOrEqual(0);
  return text.slice(start, start + 900);
}

beforeEach(() => {
  read.mockReset();
});

describe('the Errors card', () => {
  it('shows the 24-hour count and the threshold when healthy', async () => {
    const errors = card(await render(), 'Errors');
    expect(errors).toContain('12 errors · 24h');
    expect(errors).toContain('Under the 100-error threshold');
  });

  it('shows the count and the threshold in the degraded copy', async () => {
    const errors = card(
      await render(HEALTHY_HOSTING, {
        ...HEALTHY_ERRORS,
        state: 'degraded',
        values: { count: 140, windowHours: 24, threshold: 100 },
      }),
      'Errors',
    );
    expect(errors).toContain('140 errors · 24h');
    expect(errors).toContain('Over the 100-error threshold');
    expect(errors).toContain('Degraded');
  });

  it.each([
    ['noReadCredential', 'No reading from Sentry'],
    ['notConfigured', 'Error reporting is off'],
    ['readFailed', 'No response from Sentry'],
  ])('unreachable / %s names the reason and renders no digit', async (reason, headline) => {
    const errors = card(
      await render(HEALTHY_HOSTING, {
        id: 'errors',
        state: 'unreachable',
        values: { reason },
        linkOut: null,
      }),
      'Errors',
    );
    // Everything up to the card's own "…not an error count of zero".
    const body = errors.slice(0, errors.indexOf('zero') + 4);
    expect(body).toContain(headline);
    expect(body).toContain('not an error count of zero');
    expect(body).not.toMatch(/\d/);
  });
});

describe('the Hosting card', () => {
  it('shows both groups and the release when healthy', async () => {
    const hosting = card(await render(), 'Hosting');
    expect(hosting).toMatch(/app 2\/2\|* · \|*worker 1\/1/);
    expect(hosting).toContain('all on release deployment-01K6');
    expect(hosting).toContain('Fly app motir-core · iad');
  });

  it('a short group is named in the detail and set in weight in the headline', async () => {
    const html = await render({
      ...HEALTHY_HOSTING,
      state: 'degraded',
      values: {
        ...HEALTHY_HOSTING.values,
        appStarted: 1,
        reason: 'shortGroup',
        group: 'app',
        started: 1,
        expected: 2,
      },
    });
    expect(card(html, 'Hosting')).toContain(
      'app is short: 1 of 2 machines started. Release deployment-01K6.',
    );
    expect(html).toMatch(/<span class="font-semibold">app 1\/2<\/span>/);
    expect(html).not.toMatch(/<span class="font-semibold">worker/);
  });

  it('mixed releases show the release count', async () => {
    const hosting = card(
      await render({
        ...HEALTHY_HOSTING,
        state: 'degraded',
        values: {
          ...HEALTHY_HOSTING.values,
          release: 'deployment-new',
          reason: 'mixedReleases',
          count: 2,
        },
      }),
      'Hosting',
    );
    expect(hosting).toContain('running 2 different releases');
    expect(hosting).toContain('Newest deployment-new');
  });

  it('noReadCredential still shows app and region, with no machine counts', async () => {
    const hosting = card(
      await render({
        id: 'hosting',
        state: 'unreachable',
        values: { reason: 'noReadCredential', ...HOSTING_IDENTITY },
        linkOut: 'https://fly.io/apps/motir-core',
      }),
      'Hosting',
    );
    expect(hosting).toContain('Answering from iad');
    expect(hosting).toContain('Fly app motir-core · machine web1');
    // Everything up to the card's own "…not a count of zero" — no N/M count.
    const body = hosting.slice(0, hosting.indexOf('count of zero') + 13);
    expect(body).toContain('This is not a count of zero');
    expect(body).not.toMatch(/\d+\/\d+/);
  });

  it('readFailed names the reason and renders no digit', async () => {
    const hosting = card(
      await render({
        id: 'hosting',
        state: 'unreachable',
        values: { reason: 'readFailed' },
        linkOut: null,
      }),
      'Hosting',
    );
    const body = hosting.slice(0, hosting.indexOf('count of zero') + 13);
    expect(body).toContain('No answer from Fly');
    expect(body).not.toMatch(/\d/);
  });
});

describe('the board', () => {
  it('renders seven cards and offers no remediation control', async () => {
    const html = await render();
    for (const title of [
      'Database',
      'Hosting',
      'Gateway',
      'Scheduled jobs',
      'Failed jobs',
      'Errors',
      'Last health check',
    ]) {
      expect(html).toContain(`>${title}<`);
    }
    expect(html).not.toMatch(/<button|<form/);
  });

  it('announces load-complete and how many cards need a look', async () => {
    const green = await render();
    expect(green).toMatch(/role="status"[^>]*>System health loaded\. All 7 signals are healthy\./);

    const red = await render(
      { id: 'hosting', state: 'unreachable', values: { reason: 'readFailed' }, linkOut: null },
      { ...HEALTHY_ERRORS, state: 'degraded' },
    );
    expect(red).toContain("System health loaded. 2 of 7 signals are degraded or can't be reached.");
  });
});
