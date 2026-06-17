// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { WorkItemDeletePreviewDto } from '@/lib/dto/workItems';

// DeleteWorkItemDialog — the archived-item variant (Story 2.9 · Subtask 2.9.10),
// against design/work-items/delete-confirm.mock.html panels 6–7. The preview
// read is stubbed (the route's behaviour is covered elsewhere); these assert the
// rendered confirm: archived+live → peach live-descendant warning and NO Archive
// escape-hatch; archived+all-archived → the calm all-archived row and NO warning;
// the active variant still shows "Archive instead".
const { fetchDeletePreviewSpy, deleteWorkItemSpy } = vi.hoisted(() => ({
  fetchDeletePreviewSpy: vi.fn(),
  deleteWorkItemSpy: vi.fn(),
}));
vi.mock('@/components/issues/actions/workItemActionsClient', () => ({
  fetchDeletePreview: fetchDeletePreviewSpy,
  deleteWorkItem: deleteWorkItemSpy,
  WorkItemActionError: class WorkItemActionError extends Error {},
}));

import { DeleteWorkItemDialog } from '@/components/issues/actions/DeleteWorkItemDialog';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function preview(overrides: Partial<WorkItemDeletePreviewDto> = {}): WorkItemDeletePreviewDto {
  return {
    totalCount: 6,
    descendantCount: 5,
    byKind: { subtask: 4, task: 1 },
    liveDescendantCount: 0,
    liveByKind: {},
    ...overrides,
  };
}

function renderDialog(
  props: Partial<Parameters<typeof DeleteWorkItemDialog>[0]> = {},
  p: WorkItemDeletePreviewDto = preview(),
) {
  fetchDeletePreviewSpy.mockResolvedValue(p);
  return render(
    <ToastProvider>
      <DeleteWorkItemDialog
        itemId="i1"
        identifier="PROD-49"
        title="OAuth callback"
        onClose={() => {}}
        onDeleted={() => {}}
        onArchiveInstead={() => {}}
        {...props}
      />
    </ToastProvider>,
  );
}

describe('DeleteWorkItemDialog — archived variant (2.9.10)', () => {
  it('archived parent with LIVE descendants: shows the peach warning, drops the cascade-count row, omits Archive instead', async () => {
    renderDialog(
      { archived: true },
      preview({ liveDescendantCount: 5, liveByKind: { subtask: 4, task: 1 } }),
    );

    // The peach live-descendant warning (role=note) names the live count in
    // words. (No jest-dom in this suite — assert via textContent / truthiness.)
    const warning = await screen.findByRole('note');
    expect(warning.textContent).toContain('Some of what’s beneath this isn’t archived.');
    expect(warning.textContent).toContain('5 active work items that aren’t archived');
    expect(warning.textContent).toContain('4 subtasks, 1 task');

    // The redundant "N descendants will also be deleted" cascade-count row is gone
    // (the warning replaced it); history + links rows stay.
    expect(screen.queryByText(/will also be deleted/)).toBeNull();
    expect(screen.getByText(/comments, attachments, and activity history/)).toBeTruthy();
    expect(screen.getByText(/Links/)).toBeTruthy();

    // No Archive escape-hatch in the archived variant.
    expect(screen.queryByText('Archive instead')).toBeNull();
  });

  it('archived parent with ALL descendants archived: calm all-archived row, no warning, no Archive instead', async () => {
    renderDialog({ archived: true }, preview({ liveDescendantCount: 0, liveByKind: {} }));

    const row = (await screen.findByText(/All of them are already archived/)).closest('li');
    expect(row?.textContent).toContain('5 descendants');
    expect(row?.textContent).toContain('nothing here is live on your boards');

    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.queryByText('Archive instead')).toBeNull();
  });

  it('active (non-archived) variant still shows Archive instead and the plain cascade row', async () => {
    renderDialog(
      { archived: false },
      preview({ liveDescendantCount: 3, liveByKind: { subtask: 3 } }),
    );

    expect(await screen.findByText('Archive instead')).toBeTruthy();
    // The ordinary cascade-count row, never the all-archived row or the warning.
    expect(screen.getByText(/will also be deleted/)).toBeTruthy();
    expect(screen.queryByText(/All of them are already archived/)).toBeNull();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('archived leaf (no descendants) reuses the leaf dialog — no warning, no Archive instead', async () => {
    renderDialog(
      { archived: true },
      preview({
        totalCount: 1,
        descendantCount: 0,
        byKind: {},
        liveDescendantCount: 0,
        liveByKind: {},
      }),
    );

    await waitFor(() =>
      expect(
        screen.getByText(/comments, attachments, and activity history are deleted too/),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.queryByText('Archive instead')).toBeNull();
    expect(screen.queryByText(/will also be deleted/)).toBeNull();
  });
});
