// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { SavedFilterPageDto } from '@/lib/dto/savedFilters';
import { ToastProvider } from '@/components/ui/Toast';
import { renderWithIntl, enMessages } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { BUILTIN_FILTERS } from '@/lib/savedFilters/builtins';
import { toBuiltinFilterSummaryDto } from '@/lib/mappers/savedFilterMappers';
import {
  rowCapabilities,
  type Viewer,
} from '@/app/(authed)/filters/_components/savedFiltersClient';
import { FiltersDirectory } from '@/app/(authed)/filters/_components/FiltersDirectory';

// The Filters directory (Story 6.2 · Subtask 6.2.4) under happy-dom. The card's
// UI AC: the table lists rows + read-only built-ins, gates row actions by the
// 6.2.1 matrix, and renders the designed empty state. The data comes through
// the bounded list API (mocked here); the permission matrix + 403 paths are
// asserted against the real DB in the 6.2.1 service/route suite.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/filters',
}));

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto['hasPointerCapture'] = vi.fn(() => false);
  proto['setPointerCapture'] = vi.fn();
  proto['releasePointerCapture'] = vi.fn();
  proto['scrollIntoView'] = vi.fn();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  push.mockReset();
  vi.restoreAllMocks();
  cleanup();
});

const ME = 'user-me';
const OTHER = 'user-other';

function viewer(partial: Partial<Viewer> = {}): Viewer {
  return { userId: ME, canBrowse: true, canShare: true, isAdmin: false, ...partial };
}

function row(
  over: Partial<SavedFilterPageDto['items'][number]> = {},
): SavedFilterPageDto['items'][number] {
  return {
    id: 'f1',
    name: 'Sprint blockers',
    description: null,
    visibility: 'project',
    owner: { id: ME, name: 'Me' },
    starCount: 2,
    starredByMe: false,
    builtin: false,
    updatedAt: '2026-06-11T00:00:00.000Z',
    ...over,
  };
}

function mockList(page: Partial<SavedFilterPageDto>) {
  const full: SavedFilterPageDto = {
    items: [],
    nextCursor: null,
    total: 0,
    builtins: [],
    ...page,
  };
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(full), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function renderDirectory(node: ReactElement) {
  return renderWithIntl(<ToastProvider>{node}</ToastProvider>);
}

describe('rowCapabilities — the pure matrix the UI gates on', () => {
  it('the owner can manage but not change owner', () => {
    expect(rowCapabilities(viewer(), row({ owner: { id: ME, name: 'Me' } }))).toEqual({
      canManage: true,
      canChangeOwner: false,
    });
  });

  it('a non-owner non-admin can do neither', () => {
    expect(
      rowCapabilities(viewer({ isAdmin: false }), row({ owner: { id: OTHER, name: 'Other' } })),
    ).toEqual({ canManage: false, canChangeOwner: false });
  });

  it('an admin manages + changes owner of a project-shared filter they do not own', () => {
    expect(
      rowCapabilities(
        viewer({ isAdmin: true }),
        row({ visibility: 'project', owner: { id: OTHER, name: 'Other' } }),
      ),
    ).toEqual({ canManage: true, canChangeOwner: true });
  });
});

describe('FiltersDirectory — rendering + gating', () => {
  it('lists saved rows with owner, visibility, and star count', async () => {
    mockList({ items: [row({ name: 'Sprint blockers' })], total: 1 });
    renderDirectory(<FiltersDirectory projectKey="PROD" viewer={viewer()} />);

    expect(await screen.findByText('Sprint blockers')).toBeTruthy();
    expect(screen.getByText('Me')).toBeTruthy();
    // Project visibility pill.
    expect(screen.getByText('Project')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('shows a row actions menu for every visible row (Subscribe… is universal), gating manage actions inside (6.2.5)', async () => {
    mockList({
      items: [
        row({ id: 'mine', name: 'Mine', owner: { id: ME, name: 'Me' } }),
        row({
          id: 'theirs',
          name: 'Theirs',
          owner: { id: OTHER, name: 'Other' },
          visibility: 'project',
        }),
      ],
      total: 2,
    });
    renderDirectory(<FiltersDirectory projectKey="PROD" viewer={viewer({ isAdmin: false })} />);

    await screen.findByText('Mine');
    // Subscriptions (6.2.5) are a read-layer action available to ANYONE who can
    // see the row, so every row now carries a menu trigger — including a
    // non-owner's shared filter (which previously had none).
    expect(screen.getByRole('button', { name: /Actions for Mine/ })).toBeTruthy();
    const theirsTrigger = screen.getByRole('button', { name: /Actions for Theirs/ });
    expect(theirsTrigger).toBeTruthy();

    // But the MANAGE actions stay gated: a non-owner, non-admin on someone
    // else's shared filter gets Subscribe… alone — no Edit details / Delete.
    fireEvent.click(theirsTrigger);
    expect(await screen.findByRole('menuitem', { name: 'Subscribe…' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Edit details' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
  });

  it('lists built-in defaults read-only — no actions menu', async () => {
    mockList({
      items: [],
      total: 0,
      builtins: [
        { id: 'builtin:my-open', slug: 'my-open-issues', name: 'My open issues', builtin: true },
      ],
    });
    renderDirectory(<FiltersDirectory projectKey="PROD" viewer={viewer()} />);

    expect(await screen.findByText('My open issues')).toBeTruthy();
    expect(screen.getByText('Built-in')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Actions for My open issues/ })).toBeNull();
  });

  it('renders the empty state when the project has no saved filters', async () => {
    mockList({ items: [], total: 0, builtins: [] });
    renderDirectory(<FiltersDirectory projectKey="PROD" viewer={viewer()} />);

    expect(await screen.findByText('No saved filters yet')).toBeTruthy();
  });

  // The built-in defaults are real rows in the table, so the footer total must
  // count them — not just the paginated saved-filter `total`. Regression: with
  // 0 saved filters the footer read "0 filters" while eight built-in rows were
  // visible.
  it('counts the built-in defaults in the footer total, not just saved filters', async () => {
    const builtinCount = BUILTIN_FILTERS.length;
    mockList({
      items: [row({ name: 'Sprint blockers' })],
      total: 1,
      builtins: BUILTIN_FILTERS.map(toBuiltinFilterSummaryDto),
    });
    renderDirectory(<FiltersDirectory projectKey="PROD" viewer={viewer()} />);

    await screen.findByText('Sprint blockers');
    // 1 saved + N built-ins — the footer must not report just "1 filter".
    expect(screen.getByRole('status').textContent).toContain(`${1 + builtinCount} filters`);
  });
});

// Regression for bug-filters-directory-builtins-i18n-and-layout (defect 1): the
// /filters directory is a SECOND consumer of the built-in DTO that the dropdown
// i18n fix (bug-builtin-filter-names-not-localized) audit missed. BuiltinFilterRow
// must thread `t('builtinNames.<slug>')` over the slug (not render the English
// registry literal), so all eight built-in rows localise under `zh` and stay
// English under `en` — mirroring the SavedFilterDropdown localisation test.
describe('FiltersDirectory — built-in name localisation (zh/en)', () => {
  // The full registry → DTO list (carries `slug`), all eight builtins, no rows.
  const ALL_BUILTINS = BUILTIN_FILTERS.map(toBuiltinFilterSummaryDto);
  const enNames = enMessages.savedFilters.builtinNames as Record<string, string>;
  const zhNames = zhMessages.savedFilters.builtinNames as Record<string, string>;

  function renderLocale(locale: 'en' | 'zh') {
    return renderWithIntl(
      <ToastProvider>
        <FiltersDirectory projectKey="PROD" viewer={viewer()} />
      </ToastProvider>,
      {
        locale,
        messages: locale === 'zh' ? (zhMessages as Record<string, unknown>) : enMessages,
      },
    );
  }

  it('renders all eight built-in rows in Chinese under the zh locale (no English leak)', async () => {
    mockList({ items: [], total: 0, builtins: ALL_BUILTINS });
    renderLocale('zh');

    // The directory lists built-ins inline (no dropdown to open) — wait for the
    // first row to settle on its zh label, then assert all eight…
    await screen.findByText(zhNames['my-open-issues']!);
    for (const def of ALL_BUILTINS) {
      expect(screen.getByText(zhNames[def.slug]!)).toBeTruthy();
    }
    // …and none of the English registry literals leaks through.
    for (const def of ALL_BUILTINS) {
      expect(screen.queryByText(def.name)).toBeNull();
    }
  });

  it('renders all eight built-in rows in English under the en locale (green path)', async () => {
    mockList({ items: [], total: 0, builtins: ALL_BUILTINS });
    renderLocale('en');

    await screen.findByText(enNames['my-open-issues']!);
    for (const def of ALL_BUILTINS) {
      // The en catalog value equals the registry English name (byte-identical).
      expect(enNames[def.slug]).toBe(def.name);
      expect(screen.getByText(def.name)).toBeTruthy();
    }
  });
});
