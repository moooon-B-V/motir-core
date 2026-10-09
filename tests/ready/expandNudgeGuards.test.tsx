// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// STORY GATE — THE GUARDS A PERCENTAGE CANNOT SEE (Story MOTIR-5266 · MOTIR-7877).
//
// `/ready`'s Expand is a LAUNCHER (MOTIR-7876): it opens the planning overlay on
// the stub and the overlay sends "Plan <KEY>" (MOTIR-7973). Coverage can be 100%
// while the page quietly grows back a second planner, or the address starts
// carrying the turn's TEXT. These rules hold the shape:
//
//   1. Nothing under `app/(authed)/ready/` reaches for the expand job, the plan
//      review or the decide clients, nor hand-writes an overlay parameter — the
//      address is composed by `withPlanningOverlay` alone.
//   2. The href Expand writes — captured from the REAL call — carries a start
//      REQUEST, never the turn's text, in any locale.
//   3. ✕ makes no request beyond the nudge read it was drawn from.
//   4. `ready.nudge` has one key set in en and zh, and neither interpolates `{code}`.

const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/ready',
  useSearchParams: () => new URLSearchParams('lane=main'),
}));

const { ExpansionNudgeBanner } =
  await import('@/app/(authed)/ready/_components/ExpansionNudgeBanner');

const READY_DIR = join(process.cwd(), 'app', '(authed)', 'ready');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const NUDGE = { nominatedKey: 'MOTIR-7', nominatedTitle: 'Billing', readyCount: 1 };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => NUDGE }));
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('1 · /ready runs no planner and writes no overlay parameter by hand', () => {
  const files = sourceFiles(READY_DIR);

  it('walks the real directory (a renamed tree cannot pass vacuously)', () => {
    const names = files.map((f) => relative(READY_DIR, f));
    expect(names).toContain(join('_components', 'ExpansionNudgeBanner.tsx'));
    expect(names).toContain('page.tsx');
  });

  const FORBIDDEN_IMPORTS = [
    'submitExpandJob',
    'fetchPlanReview',
    'readPendingProposal',
    'approvePlanRequest',
    'declinePlanRequest',
  ];
  const FORBIDDEN_LITERALS = ['planFrom', 'planItem', 'planSession'];

  it.each(FORBIDDEN_IMPORTS)('no file names `%s`', (name) => {
    const hits = files.filter((f) => new RegExp(`\\b${name}\\b`).test(readFileSync(f, 'utf8')));
    expect(hits.map((f) => relative(process.cwd(), f))).toEqual([]);
  });

  it.each(FORBIDDEN_LITERALS)('no file contains the literal `%s`', (literal) => {
    const hits = files.filter((f) => readFileSync(f, 'utf8').includes(literal));
    expect(hits.map((f) => relative(process.cwd(), f))).toEqual([]);
  });
});

describe('2 · the href Expand writes carries the REQUEST, never the turn text', () => {
  async function capturedHref(locale: 'en' | 'zh'): Promise<string> {
    renderWithIntl(<ExpansionNudgeBanner />, locale === 'zh' ? { locale, messages: zh } : {});
    const label = locale === 'zh' ? zh.ready.nudge.expandLabel : en.ready.nudge.expandLabel;
    fireEvent.click(await screen.findByRole('button', { name: label }));
    expect(shallowPush).toHaveBeenCalledTimes(1);
    return shallowPush.mock.calls[0]![0] as string;
  }

  it.each(['en', 'zh'] as const)(
    '%s — a start request on the stub, no turn text',
    async (locale) => {
      const href = await capturedHref(locale);
      const url = new URL(href, 'http://localhost');
      expect(url.pathname).toBe('/ready');
      expect(url.searchParams.get('lane')).toBe('main');
      expect(url.searchParams.get('planItem')).toBe('MOTIR-7');
      expect(url.searchParams.get('planStart')).toBe('1');
      expect(url.searchParams.has('planSession')).toBe(false);

      const decoded = decodeURIComponent(href.replace(/\+/g, ' '));
      for (const text of [
        en.planningWorkspace.startTurn.plan,
        zh.planningWorkspace.startTurn.plan,
      ]) {
        const prefix = text.replace('{key}', '');
        expect(decoded).not.toContain(prefix);
        expect(href).not.toContain(encodeURIComponent(prefix.trim()));
      }
      expect(decoded).not.toContain('Plan ');
      expect(decoded).not.toContain('规划');
      // No parameter VALUE carries anything but keys, flags and the lane.
      for (const value of url.searchParams.values()) expect(value).not.toMatch(/\s/);
    },
  );
});

describe('3 · ✕ makes no request', () => {
  it('only the nudge read goes out — before, during and after the dismissal', async () => {
    renderWithIntl(<ExpansionNudgeBanner />);
    const dismiss = await screen.findByRole('button', { name: en.ready.nudge.dismissAria });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/ready/nudge');

    await act(async () => {
      fireEvent.click(dismiss);
    });
    await act(async () => {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(shallowPush).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: en.ready.nudge.expandLabel })).toBeNull();
  });
});

describe('4 · the ready.nudge catalogue', () => {
  it('has the same key set in en and zh', () => {
    expect(Object.keys(zh.ready.nudge).sort()).toEqual(Object.keys(en.ready.nudge).sort());
  });

  it('interpolates no `{code}` in either locale (the retired error copy stays retired)', () => {
    for (const catalogue of [en.ready.nudge, zh.ready.nudge]) {
      for (const [key, value] of Object.entries(catalogue)) {
        expect(value, key).not.toContain('{code}');
      }
    }
  });

  it('the expand hint names the stub in both locales', () => {
    expect(en.ready.nudge.expandHint).toContain('{key}');
    expect(zh.ready.nudge.expandHint).toContain('{key}');
  });
});
