// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { WorkItemActionsMenu } from '@/components/issues/actions/WorkItemActionsMenu';
import { DeleteWorkItemDialog } from '@/components/issues/actions/DeleteWorkItemDialog';

// WorkItemActionsMenu + DeleteWorkItemDialog (Story 2.8 · Subtask 2.8.4): the
// permission-gated ⋯ menu (Edit/Archive on canEdit, Delete on canDelete) and the
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
  function openMenu(props: { canEdit: boolean; canArchive?: boolean; canDelete: boolean }) {
    render(
      <WorkItemActionsMenu
        itemId="wi-1"
        identifier="PROD-1"
        title="A bug"
        onDeleted={vi.fn()}
        onArchived={vi.fn()}
        canArchive={props.canArchive ?? props.canEdit}
        {...props}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Actions for PROD-1/ }));
  }

  it('shows the full menu — Edit details · Copy link · Archive · Delete — for an admin (canEdit + canDelete)', () => {
    openMenu({ canEdit: true, canDelete: true });
    expect(screen.getByRole('menuitem', { name: 'Edit details' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Copy link' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Delete…' })).toBeTruthy();
  });

  it('hides Delete for an editor who cannot manage (canDelete false)', () => {
    openMenu({ canEdit: true, canDelete: false });
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Delete…' })).toBeNull();
  });

  it('collapses to just Copy link for a viewer (no canEdit, no canDelete)', () => {
    openMenu({ canEdit: false, canDelete: false });
    expect(screen.getByRole('menuitem', { name: 'Copy link' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Edit details' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Delete…' })).toBeNull();
  });

  // ── MOTIR-3629 — ARCHIVE HAS ITS OWN GATE ────────────────────────────────
  // Every case above passes `canArchive` defaulted to `canEdit`, which is what
  // this menu did unconditionally before the split. These three are the cases
  // that default could not express, and the first is the one that shipped as a
  // live defect: a member held `work_item:edit`, saw the Archive row, and earned
  // a 403 from a service asserting `work_item:delete`.

  it('hides Archive from an editor who cannot archive — the row no longer rides on canEdit', () => {
    openMenu({ canEdit: true, canArchive: false, canDelete: false });
    expect(screen.getByRole('menuitem', { name: 'Edit details' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Delete…' })).toBeNull();
  });

  it('offers Archive to an actor who can archive but NOT edit — the two are independent', () => {
    // Not a built-in role, and that is the point: the keys are separable, so a
    // custom role can compose this and the menu must draw it correctly.
    openMenu({ canEdit: false, canArchive: true, canDelete: false });
    expect(screen.queryByRole('menuitem', { name: 'Edit details' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeTruthy();
  });

  it('draws the separator for a delete-only actor, whose only row below it is Delete', () => {
    // The separator used to test `canEdit || canDelete`; it tests
    // `canArchive || canDelete` now, so this asserts it did not become dependent
    // on a key that no longer draws anything beneath it.
    openMenu({ canEdit: false, canArchive: false, canDelete: true });
    expect(screen.getByRole('menuitem', { name: 'Delete…' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull();
    expect(screen.getByRole('separator')).toBeTruthy();
  });
});

describe('WorkItemActionsMenu — archived mode (Subtask 2.9.11)', () => {
  function openArchivedMenu(props: { canEdit: boolean; canArchive?: boolean; canDelete: boolean }) {
    render(
      <WorkItemActionsMenu
        itemId="wi-1"
        identifier="PROD-1"
        title="A bug"
        archived
        onDeleted={vi.fn()}
        onArchived={vi.fn()}
        canArchive={props.canArchive ?? props.canEdit}
        {...props}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Actions for PROD-1/ }));
  }

  it('swaps Archive→Restore for the canEdit row, and keeps Delete… for a manager', () => {
    openArchivedMenu({ canEdit: true, canDelete: true });
    expect(screen.getByRole('menuitem', { name: 'Restore' })).toBeTruthy();
    // The active Archive row is gone — it is the Restore row in archived mode.
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Delete…' })).toBeTruthy();
  });

  it('hides Delete for a non-manager (Restore still shown for an editor)', () => {
    openArchivedMenu({ canEdit: true, canDelete: false });
    expect(screen.getByRole('menuitem', { name: 'Restore' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Delete…' })).toBeNull();
  });

  it('hides Restore too when the actor cannot archive (MOTIR-3629)', () => {
    // Restore is `unarchiveWorkItem`, which asserts the same key archive does —
    // so the row it swaps with has to move with it. It did not before the split,
    // which is why the archived VIEW had the same 403ing affordance the active
    // menu had.
    openArchivedMenu({ canEdit: true, canArchive: false, canDelete: false });
    expect(screen.queryByRole('menuitem', { name: 'Restore' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull();
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

    openArchivedMenu({ canEdit: true, canDelete: true });
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
        canArchive={canEdit}
        canDelete={false}
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
// MOTIR-2097 filed the /items row ⋯ menu as the THIRD planning affordance: it
// went through `PlanEditsTrigger` rather than the planning launcher, so
// MOTIR-2084's blast-radius grep never saw it, and it offered Re-plan on a DONE
// epic and on a CHILDLESS one. The fix put it on the shared `planEntranceFace`
// rule; MOTIR-4258 removed the affordance instead.
//
// This menu now offers NO plan door on ANY of its mounts, and this is the guard
// that keeps it that way. The per-item Plan / Re-plan entrance is
// `WorkItemPlanEntrance` (the detail header and the quick-view peek), which is
// the one place that decides the mode — a fourth affordance appearing here is
// the regression MOTIR-2097 was filed about, one surface further on.
describe('WorkItemActionsMenu — no plan doors, on any mount', () => {
  it('offers neither Expand nor Re-plan to a fully capable actor', () => {
    render(
      <WorkItemActionsMenu
        itemId="wi-1"
        identifier="PROD-1"
        title="An epic"
        canEdit
        canArchive
        canDelete
        onDeleted={vi.fn()}
        onArchived={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Actions for PROD-1/ }));

    // The menu opened and carries its surviving rows...
    expect(screen.getByRole('menuitem', { name: 'Copy link' })).toBeTruthy();
    // ...and neither plan row, under any casing the two labels ever used.
    expect(screen.queryByRole('menuitem', { name: /expand/i })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /re-?plan/i })).toBeNull();
  });
});
