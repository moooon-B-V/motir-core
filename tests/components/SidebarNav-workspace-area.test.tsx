// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';

// Story MOTIR-4843 · MOTIR-4846 — the FOURTH settings area's rail branch.
//
// This is the SMOKE the first card that renders the surface owes: the
// instrument that OPENS it. Without it every later card in the story has a
// green suite against a page nobody loaded.
//
// Two properties, and the second is the one the re-plan turned on:
//
//   1. ABOVE the reveal — three rows, and EXACTLY ONE reads active on each of
//      the three routes. The area root is `exact`, which is what stops it
//      reading as current on all three at once.
//   2. BELOW the reveal — NO rows at all. Not fewer rows: none. All three
//      routes `notFound()` there and their capabilities are hosted on
//      `/settings/organization`, gated per SECTION (§6d), so an empty rail is
//      the honest rendering. Nothing marks the gap — no empty heading, no
//      disabled row.

let pathname = '/settings/workspace';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

import { SidebarNav } from '@/app/(authed)/_components/SidebarNav';

const USER = { name: 'Yue', email: 'yue@example.com' };
const WORKSPACE = { name: 'Engineering' };

function renderRail(workspaceTierRevealed: boolean) {
  return renderWithIntl(
    <SidebarNav
      activeProject={null}
      user={USER}
      workspace={WORKSPACE}
      workspaceTierRevealed={workspaceTierRevealed}
    />,
  );
}

const ROWS = [
  { label: 'Workspace', href: '/settings/workspace' },
  { label: 'Security', href: '/settings/workspace/security' },
  { label: 'Job runs', href: '/settings/workspace/jobs' },
];

afterEach(() => {
  cleanup();
  pathname = '/settings/workspace';
});

describe('the workspace-settings AREA rail — above the reveal', () => {
  it.each(ROWS)('renders all three rows at $href', ({ href }) => {
    pathname = href;
    renderRail(true);
    for (const row of ROWS) {
      expect(
        screen.getByRole('link', { name: row.label }).getAttribute('href'),
        `${row.label} at ${href}`,
      ).toBe(row.href);
    }
  });

  it.each(ROWS)('marks EXACTLY ONE row current at $href — and no other', ({ href, label }) => {
    pathname = href;
    renderRail(true);
    const current = ROWS.filter(
      (row) =>
        screen.getByRole('link', { name: row.label }).getAttribute('aria-current') === 'page',
    );
    expect(current.map((r) => r.label)).toEqual([label]);
  });

  it('names the WORKSPACE in the rail head, with the area eyebrow', () => {
    renderRail(true);
    expect(screen.getByText('Engineering')).toBeTruthy();
    expect(screen.getByText('Workspace settings')).toBeTruthy();
  });

  it('groups the three rows under General · Access · Operations, in that order', () => {
    renderRail(true);
    const headings = screen
      .getAllByText(/^(General|Access|Operations)$/)
      .map((el) => el.textContent);
    expect(headings).toEqual(['General', 'Access', 'Operations']);
  });
});

describe('the workspace-settings AREA rail — BELOW the reveal', () => {
  it.each(ROWS)('renders NO workspace rows at $href', ({ href }) => {
    pathname = href;
    renderRail(false);
    for (const row of ROWS) {
      expect(screen.queryByRole('link', { name: row.label }), row.label).toBeNull();
    }
  });

  it('renders no group heading either — the groups are ABSENT, not empty', () => {
    renderRail(false);
    for (const heading of ['General', 'Access', 'Operations']) {
      expect(screen.queryByText(heading), heading).toBeNull();
    }
  });

  it('⚠️ `Job runs` is absent too — the axis is UNIFORM, and that is the re-plan', () => {
    // An earlier shape of this registry exempted `jobs`, because
    // `/settings/workspace/jobs` answered 200 at every workspace count while its
    // siblings 404'd (MOTIR-3502 AC 6). That was an UNFINISHED COLLAPSE rather
    // than a decision: it was the one workspace surface with no fold-in.
    // MOTIR-4861 gives it one on `/settings/organization`. MOTIR-4859 is the
    // planning bug. This assertion is what keeps the exception from returning.
    pathname = '/settings/workspace/jobs';
    renderRail(false);
    expect(screen.queryByRole('link', { name: 'Job runs' })).toBeNull();
  });
});
