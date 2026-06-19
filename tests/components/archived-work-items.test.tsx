// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { ProjectAccessProvider } from '@/app/(authed)/_components/ProjectAccessProvider';
import type { ArchivedRowData } from '@/app/(authed)/issues/archived/_components/archivedRows';
import { toArchivedRows } from '@/app/(authed)/issues/archived/_components/archivedRows';
import { ArchivedWorkItemsList } from '@/app/(authed)/issues/archived/_components/ArchivedWorkItemsList';
import type { ArchivedWorkItemDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';

// The archived work items view + Restore + Delete (Story 2.9 · Subtasks 2.9.3 /
// 2.9.5) under happy-dom — the client island's render, the canEdit (Restore) /
// canManage (Delete) gate matrix, and the page-state-after-mutation contract
// (both Restore and Delete remove the row on the authoritative 200/204). The
// route is URL-driven, so we stub next/navigation; the actions POST/DELETE via
// fetch, so we stub fetch and assert the row leaves the DOM only AFTER the
// authoritative response, never on the optimistic click alone. `canManage` comes
// from `useProjectAccess()`, so we wrap renders in a ProjectAccessProvider.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/issues/archived',
}));

// `canManage` is read from the provider (the WorkItemRowActions pattern), so
// every render wraps one — defaulting to NOT manageable, so the 2.9.3 tests keep
// their pre-Delete behaviour (the actions column is then canEdit-only).
function render(ui: ReactElement, { canManage = false }: { canManage?: boolean } = {}) {
  return renderWithIntl(
    <ToastProvider>
      <ProjectAccessProvider canEdit canManage={canManage}>
        {ui}
      </ProjectAccessProvider>
    </ToastProvider>,
  );
}

const ROWS: ArchivedRowData[] = [
  {
    id: 'wi_49',
    identifier: 'PROD-49',
    title: 'OAuth callback drops the state param',
    kind: 'bug',
    statusLabel: 'In Review',
    statusCategory: 'in_progress',
    archivedByName: 'Dana Kim',
    archivedAtLabel: 'Jun 15, 2026',
  },
  {
    id: 'wi_28',
    identifier: 'PROD-28',
    title: 'SAML SSO (dropped from Q3 scope)',
    kind: 'story',
    statusLabel: 'To Do',
    statusCategory: 'todo',
    archivedByName: null,
    archivedAtLabel: 'Jun 11, 2026',
  },
];

afterEach(() => {
  push.mockReset();
  vi.unstubAllGlobals();
  cleanup();
});

describe('ArchivedWorkItemsList', () => {
  it('renders archived rows with identity + archive provenance', () => {
    render(<ArchivedWorkItemsList rows={ROWS} total={2} page={1} pageSize={50} canEdit />);

    const first = screen.getByTestId('archived-row-PROD-49');
    expect(within(first).getByText('PROD-49')).toBeTruthy();
    expect(within(first).getByText('OAuth callback drops the state param')).toBeTruthy();
    expect(within(first).getByText('In Review')).toBeTruthy();
    expect(within(first).getByText('Dana Kim')).toBeTruthy();
    expect(within(first).getByText('Jun 15, 2026')).toBeTruthy();
    // The row links to the item detail (the whole row minus the action cell).
    expect(within(first).getByRole('link', { name: /PROD-49/ })).toBeTruthy();
    // An unresolved archived-by actor renders the muted em dash, never a crash.
    expect(within(screen.getByTestId('archived-row-PROD-28')).getByText('—')).toBeTruthy();
  });

  it('canEdit: Restore removes the row only after the unarchive 200 (page-state)', async () => {
    let resolveFetch: (v: { ok: boolean }) => void = () => {};
    const fetchMock = vi.fn(
      (..._args: unknown[]) =>
        new Promise((res) => {
          resolveFetch = res;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<ArchivedWorkItemsList rows={ROWS} total={2} page={1} pageSize={50} canEdit />);

    fireEvent.click(screen.getByRole('button', { name: 'Restore PROD-49' }));

    // Optimistic-only: the row is still present + marked busy until the 200.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toContain('/api/work-items/wi_49/archive');
    expect(call?.[1]).toMatchObject({ method: 'DELETE' });
    expect(screen.getByTestId('archived-row-PROD-49').getAttribute('aria-busy')).toBe('true');

    // The authoritative 200 — NOW the row leaves the list + a success toast shows.
    resolveFetch({ ok: true });
    await waitFor(() => {
      expect(screen.queryByTestId('archived-row-PROD-49')).toBeNull();
    });
    expect(screen.getByText('PROD-49 restored')).toBeTruthy();
    // The other row is untouched.
    expect(screen.getByTestId('archived-row-PROD-28')).toBeTruthy();
  });

  it('canEdit: a failed restore keeps the row and surfaces an error toast', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({ code: 'BOOM' }) })),
    );

    render(<ArchivedWorkItemsList rows={ROWS} total={2} page={1} pageSize={50} canEdit />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore PROD-49' }));

    await waitFor(() => {
      expect(screen.getByText('Couldn’t restore')).toBeTruthy();
    });
    // Nothing changed server-side, so the row stays.
    expect(screen.getByTestId('archived-row-PROD-49')).toBeTruthy();
  });

  it('view-only (not canEdit): the list renders but no Restore action exists', () => {
    render(<ArchivedWorkItemsList rows={ROWS} total={2} page={1} pageSize={50} canEdit={false} />);
    expect(screen.getByTestId('archived-row-PROD-49')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Restore/ })).toBeNull();
    expect(screen.queryByText('Actions')).toBeNull();
  });

  it('empty archive renders the EmptyState, not a table', () => {
    render(<ArchivedWorkItemsList rows={[]} total={0} page={1} pageSize={50} canEdit />);
    expect(screen.getByText('Nothing archived')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  // The gate matrix (2.9.5 / design-notes §2.9.7): Restore = canEdit, Delete (the
  // `⋯` menu) = canManage, independent — each affordance HIDDEN when its gate is
  // unmet, the column dropped only when neither is present.
  it('canManage gates the row `⋯` Delete affordance independently of Restore', () => {
    render(<ArchivedWorkItemsList rows={ROWS} total={2} page={1} pageSize={50} canEdit />, {
      canManage: true,
    });
    const first = screen.getByTestId('archived-row-PROD-49');
    // canEdit → inline Restore; canManage → the `⋯` menu beside it.
    expect(within(first).getByRole('button', { name: 'Restore PROD-49' })).toBeTruthy();
    expect(within(first).getByRole('button', { name: 'Actions for PROD-49' })).toBeTruthy();
    // The `⋯` is PURELY the Delete affordance — opening it shows only Delete….
    fireEvent.click(within(first).getByRole('button', { name: 'Actions for PROD-49' }));
    expect(screen.getByRole('menuitem', { name: 'Delete…' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Edit details' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull();
  });

  it('canManage WITHOUT canEdit: the `⋯` Delete shows but no inline Restore', () => {
    render(<ArchivedWorkItemsList rows={ROWS} total={2} page={1} pageSize={50} canEdit={false} />, {
      canManage: true,
    });
    // The actions column stays (Delete is available), but Restore is gone.
    expect(screen.getByText('Actions')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Restore/ })).toBeNull();
    expect(
      within(screen.getByTestId('archived-row-PROD-49')).getByRole('button', {
        name: 'Actions for PROD-49',
      }),
    ).toBeTruthy();
  });

  it('canManage: Delete… removes the row only after the delete 204 (page-state)', async () => {
    let resolveDelete: (v: Response) => void = () => {};
    const fetchMock = vi.fn((...args: unknown[]) => {
      const [url] = args;
      if (String(url).includes('/delete-preview')) {
        // The archived leaf preview — no descendants, no live-descendant warning.
        return Promise.resolve(
          new Response(
            JSON.stringify({
              totalCount: 1,
              descendantCount: 0,
              byKind: {},
              liveDescendantCount: 0,
              liveByKind: {},
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      // The DELETE — held open so we can assert optimistic-vs-authoritative.
      return new Promise<Response>((res) => {
        resolveDelete = res;
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ArchivedWorkItemsList rows={ROWS} total={2} page={1} pageSize={50} canEdit />, {
      canManage: true,
    });

    fireEvent.click(
      within(screen.getByTestId('archived-row-PROD-49')).getByRole('button', {
        name: 'Actions for PROD-49',
      }),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }));

    // The confirm dialog opens; once the preview resolves, the leaf delete button
    // is enabled. Confirming fires the DELETE to the right item.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Delete work item' })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete work item' }));

    const deleteCall = fetchMock.mock.calls.find((c) => !String(c[0]).includes('/delete-preview'));
    expect(deleteCall?.[0]).toContain('/api/work-items/wi_49');
    expect(deleteCall?.[1]).toMatchObject({ method: 'DELETE' });
    // Optimistic-only is NOT enough — the row is still present until the 204.
    expect(screen.getByTestId('archived-row-PROD-49')).toBeTruthy();

    // The authoritative 204 — NOW the row leaves the list + the deleted toast shows.
    resolveDelete(new Response(null, { status: 204 }));
    await waitFor(() => {
      expect(screen.queryByTestId('archived-row-PROD-49')).toBeNull();
    });
    expect(screen.getByText('PROD-49 deleted')).toBeTruthy();
    // The other row is untouched.
    expect(screen.getByTestId('archived-row-PROD-28')).toBeTruthy();
  });
});

describe('toArchivedRows', () => {
  const workflow = {
    statuses: [
      { key: 'in_review', label: 'In Review', category: 'in_progress' },
      { key: 'todo', label: 'To Do', category: 'todo' },
    ],
  } as unknown as WorkflowDto;

  function dto(over: Partial<ArchivedWorkItemDto>): ArchivedWorkItemDto {
    return {
      id: 'wi_1',
      kind: 'bug',
      type: 'code',
      key: 49,
      identifier: 'PROD-49',
      title: 'A bug',
      status: 'in_review',
      priority: 'medium',
      assigneeId: null,
      reporterId: 'u1',
      dueDate: null,
      estimateMinutes: null,
      storyPoints: null,
      updatedAt: '2026-06-15T00:00:00.000Z',
      archivedAt: '2026-06-15T00:00:00.000Z',
      archivedBy: { id: 'u2', name: 'Dana Kim', image: null },
      ...over,
    };
  }

  it('resolves the status label/category and formats the archived date', () => {
    const [row] = toArchivedRows([dto({})], workflow, 'en');
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      identifier: 'PROD-49',
      kind: 'bug',
      statusLabel: 'In Review',
      statusCategory: 'in_progress',
      archivedByName: 'Dana Kim',
      archivedAtLabel: 'Jun 15, 2026',
    });
  });

  it('falls back to the raw key + null category for an unclassifiable status, and null archivedBy', () => {
    const [row] = toArchivedRows([dto({ status: 'mystery', archivedBy: null })], workflow, 'en');
    expect(row?.statusLabel).toBe('mystery');
    expect(row?.statusCategory).toBeNull();
    expect(row?.archivedByName).toBeNull();
  });
});
