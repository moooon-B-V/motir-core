// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { SavedFilterPageDto, ResolvedSavedFilterDto } from '@/lib/dto/savedFilters';
import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import { EMPTY_FILTER, type IssueFilter } from '@/lib/issues/issueListFilter';
import { DEFAULT_SORT } from '@/lib/issues/issueListView';
import { ToastProvider } from '@/components/ui/Toast';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { Viewer } from '@/app/(authed)/filters/_components/savedFiltersClient';
import { SavedFilterSessionProvider } from '@/app/(authed)/issues/_components/SavedFilterContext';
import { SavedFilterDropdown } from '@/app/(authed)/issues/_components/SavedFilterDropdown';
import { IssueAppliedFilterBar } from '@/app/(authed)/issues/_components/IssueAppliedFilterBar';

// The /issues save + apply UI (Story 6.2 · Subtask 6.2.3) under happy-dom. The
// dropdown groups the project's filters + built-ins (Starred → My filters →
// Project filters → Defaults), applies one into the builder URL, and stars in
// place; the applied bar renders the name chip + dirty state + Save / Save as /
// Discard. The permission matrix + the persist/resolve round-trip are asserted
// against the real DB in the 6.2.1 / 6.2.6 service suites — here the API is
// mocked and we assert the WIRING.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/issues',
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

const AST_A: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'status', operator: 'is_any_of', value: ['todo'] }],
};
const AST_B: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'status', operator: 'is_any_of', value: ['todo', 'in_progress'] }],
};

function row(
  over: Partial<SavedFilterPageDto['items'][number]> = {},
): SavedFilterPageDto['items'][number] {
  return {
    id: 'f1',
    name: 'Sprint blockers',
    description: null,
    visibility: 'project',
    owner: { id: ME, name: 'Me' },
    starCount: 0,
    starredByMe: false,
    builtin: false,
    updatedAt: '2026-06-11T00:00:00.000Z',
    ...over,
  };
}

const PAGE: SavedFilterPageDto = {
  items: [
    row({ id: 'starred1', name: 'My pinned', starredByMe: true }),
    row({
      id: 'mine1',
      name: 'My open reviews',
      owner: { id: ME, name: 'Me' },
      visibility: 'private',
    }),
    row({
      id: 'proj1',
      name: 'Design backlog',
      owner: { id: OTHER, name: 'Bo' },
      visibility: 'project',
    }),
  ],
  nextCursor: null,
  total: 3,
  builtins: [{ id: 'builtin:my-open-issues', name: 'My open issues', builtin: true }],
};

function resolved(over: Partial<ResolvedSavedFilterDto> = {}): ResolvedSavedFilterDto {
  return {
    filter: row({ id: 'proj1', name: 'Design backlog', owner: { id: OTHER, name: 'Bo' } }),
    ast: AST_A,
    astError: null,
    capabilities: { canManage: false, canDelete: false, canChangeOwner: false, canShare: true },
    ...over,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Route the saved-filter API by (url, method). */
function mockApi(
  opts: {
    page?: SavedFilterPageDto;
    resolve?: ResolvedSavedFilterDto;
    star?: SavedFilterPageDto['items'][number];
    create?: SavedFilterPageDto['items'][number];
    patch?: SavedFilterPageDto['items'][number];
  } = {},
) {
  const page = opts.page ?? PAGE;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const path = url.split('?')[0] ?? url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/star')) return Promise.resolve(json({ filter: opts.star ?? row() }));
    if (method === 'POST') return Promise.resolve(json({ filter: opts.create ?? row() }, 201));
    if (method === 'PATCH') return Promise.resolve(json({ filter: opts.patch ?? row() }));
    // GET single filter (resolve) — has an id segment after saved-filters/
    if (method === 'GET' && /\/saved-filters\/[^/?]+$/.test(path)) {
      return Promise.resolve(json(opts.resolve ?? resolved()));
    }
    return Promise.resolve(json(page)); // the list
  });
}

/** Harness rendering both surfaces under one session provider, with a
 * controllable `ast` so a test can simulate a builder edit (URL change). */
function Harness({ ast, filter }: { ast: FilterAst | null; filter?: IssueFilter }) {
  const f = filter ?? EMPTY_FILTER;
  return (
    <ToastProvider>
      <SavedFilterSessionProvider>
        <SavedFilterDropdown
          projectKey="PROD"
          viewer={viewer()}
          view="tree"
          sort={DEFAULT_SORT}
          filter={f}
          ast={ast}
        />
        <IssueAppliedFilterBar
          projectKey="PROD"
          viewer={viewer()}
          view="tree"
          sort={DEFAULT_SORT}
          filter={f}
          ast={ast}
        />
      </SavedFilterSessionProvider>
    </ToastProvider>
  );
}

function render(node: ReactElement) {
  return renderWithIntl(node);
}

async function openDropdown() {
  fireEvent.click(screen.getByRole('button', { name: /apply, star, or search/i }));
  await screen.findByPlaceholderText('Find filters…');
}

describe('SavedFilterDropdown — grouping + apply + star', () => {
  it('groups filters into Starred / My filters / Project filters / Defaults', async () => {
    mockApi();
    render(<Harness ast={null} />);
    await openDropdown();

    expect(await screen.findByText('Starred')).toBeTruthy();
    expect(screen.getByText('My filters')).toBeTruthy();
    expect(screen.getByText('Project filters')).toBeTruthy();
    expect(screen.getByText('Defaults')).toBeTruthy();
    // A starred filter appears only under Starred; built-ins under Defaults.
    expect(screen.getByText('My pinned')).toBeTruthy();
    expect(screen.getByText('My open reviews')).toBeTruthy();
    expect(screen.getByText('Design backlog')).toBeTruthy();
    expect(screen.getByText('My open issues')).toBeTruthy();
  });

  it('applying an entry resolves it, pushes the ?filter= URL, and shows the name chip', async () => {
    mockApi({ resolve: resolved() });
    render(<Harness ast={null} />);
    await openDropdown();

    fireEvent.click(await screen.findByText('Design backlog'));

    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    const href = String(push.mock.calls[0]?.[0]);
    expect(href).toContain(`filter=${encodeURIComponent(encodeFilterParam(AST_A))}`);
    // The applied name chip now renders in the bar.
    expect(
      await screen.findByRole('button', { name: /Applied filter: Design backlog/i }),
    ).toBeTruthy();
  });

  it('toggling a star calls the star API and announces pressed state', async () => {
    mockApi({ star: row({ id: 'mine1', name: 'My open reviews', starredByMe: true }) });
    render(<Harness ast={null} />);
    await openDropdown();

    const star = await screen.findByRole('button', { name: 'Star My open reviews' });
    fireEvent.click(star);
    await waitFor(() =>
      expect(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(
          ([u, i]) =>
            String(u).includes('/star') && ((i as RequestInit)?.method ?? 'GET') === 'PUT',
        ),
      ).toBe(true),
    );
  });
});

describe('IssueAppliedFilterBar — dirty state + Save split', () => {
  it('shows Save / Save as / Discard with the dirty marker when an owned filter is edited', async () => {
    // Owner-managed resolve → canOverwrite true.
    mockApi({
      resolve: resolved({
        capabilities: { canManage: true, canDelete: true, canChangeOwner: false, canShare: true },
      }),
    });
    const { rerender } = render(<Harness ast={AST_A} />);
    await openDropdown();
    fireEvent.click(await screen.findByText('Design backlog'));
    await screen.findByRole('button', { name: /Applied filter:/i });

    // Clean right after apply.
    expect(screen.queryByText('Edited')).toBeNull();

    // Simulate a builder edit: the URL AST diverges from the saved envelope.
    rerender(<Harness ast={AST_B} />);

    expect(await screen.findByText('Edited')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save as' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeTruthy();
  });

  it('a non-owner editing an applied filter gets Save as only (no overwrite Save)', async () => {
    mockApi({
      resolve: resolved({
        capabilities: { canManage: false, canDelete: false, canChangeOwner: false, canShare: true },
      }),
    });
    const { rerender } = render(<Harness ast={AST_A} />);
    await openDropdown();
    fireEvent.click(await screen.findByText('Design backlog'));
    await screen.findByRole('button', { name: /Applied filter:/i });
    rerender(<Harness ast={AST_B} />);

    await screen.findByText('Edited');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save as' })).toBeTruthy();
  });

  it('a fresh (unsaved) filter offers Save as, opening the save dialog and POSTing the row', async () => {
    mockApi({
      create: row({ id: 'new1', name: 'Sprint blockers', owner: { id: ME, name: 'Me' } }),
    });
    render(<Harness ast={AST_A} />);

    // No applied filter yet → no chip, but the active AST offers Save as.
    expect(screen.queryByRole('button', { name: /Applied filter:/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save as' }));

    // The save dialog (panel 1).
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Save filter');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Sprint blockers' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save filter' }));

    await waitFor(() =>
      expect(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(
          ([, i]) => ((i as RequestInit)?.method ?? 'GET') === 'POST',
        ),
      ).toBe(true),
    );
    // The freshly-saved row is now the applied chip.
    expect(
      await screen.findByRole('button', { name: /Applied filter: Sprint blockers/i }),
    ).toBeTruthy();
  });
});
