// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { SavedFilterPageDto } from '@/lib/dto/savedFilters';
import { ToastProvider } from '@/components/ui/Toast';
import { renderWithIntl } from '../helpers/renderWithIntl';
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

  it('shows the actions menu for a row the viewer can manage, and hides it otherwise', async () => {
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
    expect(screen.queryByRole('button', { name: /Actions for Mine/ })).toBeTruthy();
    // Non-owner, non-admin: no menu on someone else's shared filter.
    expect(screen.queryByRole('button', { name: /Actions for Theirs/ })).toBeNull();
  });

  it('lists built-in defaults read-only — no actions menu', async () => {
    mockList({
      items: [],
      total: 0,
      builtins: [{ id: 'builtin:my-open', name: 'My open issues', builtin: true }],
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
});
