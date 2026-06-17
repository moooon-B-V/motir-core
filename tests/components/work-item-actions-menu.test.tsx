// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { WorkItemActionsMenu } from '@/components/issues/actions/WorkItemActionsMenu';
import { DeleteWorkItemDialog } from '@/components/issues/actions/DeleteWorkItemDialog';

// WorkItemActionsMenu + DeleteWorkItemDialog (Story 2.8 · Subtask 2.8.4): the
// permission-gated ⋯ menu (Edit/Archive on canEdit, Delete on canManage) and the
// cascade-count confirm dialog (the count read from 2.8.7's delete-preview is
// NAMED in the dialog + on the "Delete N items" button). E2E coverage of the
// full delete/archive round-trip is Subtask 2.8.6; this pins the gating + the
// count rendering as units.

function render(ui: ReactElement) {
  return renderWithIntl(<ToastProvider>{ui}</ToastProvider>);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('WorkItemActionsMenu — permission gating', () => {
  function openMenu(props: { canEdit: boolean; canManage: boolean }) {
    render(
      <WorkItemActionsMenu
        itemId="wi-1"
        identifier="PROD-1"
        title="A bug"
        onDeleted={vi.fn()}
        onArchived={vi.fn()}
        {...props}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Actions for PROD-1/ }));
  }

  it('shows the full menu — Edit details · Copy link · Archive · Delete — for an admin (canEdit + canManage)', () => {
    openMenu({ canEdit: true, canManage: true });
    expect(screen.getByRole('menuitem', { name: 'Edit details' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Copy link' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Delete…' })).toBeTruthy();
  });

  it('hides Delete for an editor who cannot manage (canManage false)', () => {
    openMenu({ canEdit: true, canManage: false });
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Delete…' })).toBeNull();
  });

  it('collapses to just Copy link for a viewer (no canEdit, no canManage)', () => {
    openMenu({ canEdit: false, canManage: false });
    expect(screen.getByRole('menuitem', { name: 'Copy link' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Edit details' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Delete…' })).toBeNull();
  });
});

describe('WorkItemActionsMenu — archived mode (Subtask 2.9.11)', () => {
  function openArchivedMenu(props: { canEdit: boolean; canManage: boolean }) {
    render(
      <WorkItemActionsMenu
        itemId="wi-1"
        identifier="PROD-1"
        title="A bug"
        archived
        onDeleted={vi.fn()}
        onArchived={vi.fn()}
        {...props}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Actions for PROD-1/ }));
  }

  it('swaps Archive→Restore for the canEdit row, and keeps Delete… for a manager', () => {
    openArchivedMenu({ canEdit: true, canManage: true });
    expect(screen.getByRole('menuitem', { name: 'Restore' })).toBeTruthy();
    // The active Archive row is gone — it is the Restore row in archived mode.
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Delete…' })).toBeTruthy();
  });

  it('hides Delete for a non-manager (Restore still shown for an editor)', () => {
    openArchivedMenu({ canEdit: true, canManage: false });
    expect(screen.getByRole('menuitem', { name: 'Restore' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Delete…' })).toBeNull();
  });

  it('opens the ARCHIVED confirm variant from Delete… — no "Archive instead" escape hatch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
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

    openArchivedMenu({ canEdit: true, canManage: true });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }));

    // The confirm dialog opens; the archived variant omits the active variant's
    // "Archive instead" escape hatch (the item is already archived).
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Delete work item' })).toBeTruthy(),
    );
    expect(screen.queryByRole('button', { name: /Archive instead/ })).toBeNull();
  });
});

describe('DeleteWorkItemDialog — cascade count', () => {
  it('names the per-kind descendant breakdown and puts the magnitude on the button', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          totalCount: 8,
          descendantCount: 7,
          byKind: { subtask: 5, task: 1, bug: 1 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    render(
      <DeleteWorkItemDialog
        itemId="wi-1"
        identifier="PROD-142"
        title="Saved filters"
        onClose={vi.fn()}
        onDeleted={vi.fn()}
        onArchiveInstead={vi.fn()}
      />,
    );

    // The button states the magnitude (item + 7 descendants = 8) once the
    // preview resolves; the breakdown is named in text (never colour-only).
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Delete 8 items/ })).toBeTruthy(),
    );
    expect(screen.getByText(/will also be deleted — 5 subtasks, 1 task, 1 bug/)).toBeTruthy();
    // The archive escape hatch is present inside the same dialog.
    expect(screen.getByRole('button', { name: /Archive instead/ })).toBeTruthy();
  });

  it('renders the leaf form (no count, "Delete work item") when there are no descendants', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ totalCount: 1, descendantCount: 0, byKind: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    render(
      <DeleteWorkItemDialog
        itemId="wi-2"
        identifier="PROD-9"
        title="A leaf"
        onClose={vi.fn()}
        onDeleted={vi.fn()}
        onArchiveInstead={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Delete work item' })).toBeTruthy(),
    );
    expect(screen.queryByText(/will also be deleted/)).toBeNull();
  });
});

describe('WorkItemActionsMenu — Add to active sprint (Subtask 2.4.14)', () => {
  function openSprintMenu(props: {
    canEdit?: boolean;
    activeSprintId?: string | null;
    inActiveSprint?: boolean;
    withHost?: boolean;
  }) {
    const {
      canEdit = true,
      activeSprintId = 'sp_active',
      inActiveSprint = false,
      withHost = true,
    } = props;
    render(
      <WorkItemActionsMenu
        itemId="wi-1"
        identifier="PROD-1"
        title="A bug"
        canEdit={canEdit}
        canManage={false}
        onDeleted={vi.fn()}
        onArchived={vi.fn()}
        activeSprintId={activeSprintId}
        activeSprintName="Sprint 7"
        inActiveSprint={inActiveSprint}
        onSprintChanged={withHost ? vi.fn() : undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Actions for PROD-1/ }));
  }

  it('shows an ENABLED row when an active sprint exists and the item is not in it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ updatedAt: 't', sprintId: 'sp_active' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    openSprintMenu({});
    const row = screen.getByRole('menuitem', { name: 'Add to active sprint' });
    expect(row.getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.click(row);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/api/work-items/wi-1/sprint');
  });

  it('shows a DISABLED row + reason when there is no active sprint (state-gate, not hidden)', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    openSprintMenu({ activeSprintId: null });
    const row = screen.getByRole('menuitem', { name: 'Add to active sprint' });
    expect(row.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(row);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows a DISABLED row when the item is already in the active sprint', () => {
    openSprintMenu({ inActiveSprint: true });
    const row = screen.getByRole('menuitem', { name: 'Add to active sprint' });
    expect(row.getAttribute('aria-disabled')).toBe('true');
  });

  it('HIDES the row for a viewer (no canEdit) — the permission law', () => {
    openSprintMenu({ canEdit: false });
    expect(screen.queryByRole('menuitem', { name: 'Add to active sprint' })).toBeNull();
  });

  it('HIDES the row when the host does not opt in (no onSprintChanged)', () => {
    openSprintMenu({ withHost: false });
    expect(screen.queryByRole('menuitem', { name: 'Add to active sprint' })).toBeNull();
  });
});
