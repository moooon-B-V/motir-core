// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { FolderDeleteDialog } from '@/app/(authed)/items/_components/FolderDeleteDialog';
import type { FolderDeletionPreviewDto } from '@/lib/dto/folders';

// The DELETE-FOLDER confirmation (Story MOTIR-5308 · MOTIR-5346): what moves and
// where, never a guessed number, and both refusals inside the open dialog.

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function preview(
  folders: number,
  items: number,
  destination: { folderId: string | null; name: string | null } = { folderId: null, name: null },
): FolderDeletionPreviewDto {
  return {
    folderId: 'f1',
    name: 'Parked',
    childFolderCount: folders,
    workItemCount: items,
    destination,
  };
}

function renderDialog(over: Partial<Parameters<typeof FolderDeleteDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <FolderDeleteDialog
      folderName="Parked"
      preview={preview(2, 3)}
      refusal={null}
      pending={false}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...over}
    />,
  );
  return { onConfirm, onCancel };
}

const dialog = () => screen.getByRole('alertdialog');
const confirmButton = () => within(dialog()).getByRole('button', { name: 'Delete folder' });

describe('FolderDeleteDialog', () => {
  it('names both counts and the Project root destination for a folder holding folders and work items', () => {
    renderDialog();

    expect(within(dialog()).getByText('Delete folder “Parked”?')).toBeTruthy();
    expect(
      within(dialog()).getByText(
        'Only the folder is removed. Everything filed in it stays in the project.',
      ),
    ).toBeTruthy();
    expect(screen.getByTestId('folder-delete-moves').textContent).toBe(
      '2 folders and 3 work items will move to Project root. No work items are deleted.',
    );
    expect(confirmButton().hasAttribute('disabled')).toBe(false);
  });

  it('names only the kind that is present, and the parent folder as the destination', () => {
    renderDialog({ preview: preview(0, 3, { folderId: 'later', name: 'Later' }) });
    expect(screen.getByTestId('folder-delete-moves').textContent).toBe(
      '3 work items will move to Later. No work items are deleted.',
    );
    cleanup();

    renderDialog({ preview: preview(1, 0) });
    expect(screen.getByTestId('folder-delete-moves').textContent).toBe(
      '1 folder will move to Project root. No work items are deleted.',
    );
  });

  it('an empty folder gets the lighter copy and no move line', () => {
    renderDialog({ folderName: 'Spikes', preview: preview(0, 0) });

    expect(
      within(dialog()).getByText('“Spikes” is empty. Deleting it removes only the folder.'),
    ).toBeTruthy();
    expect(screen.queryByTestId('folder-delete-moves')).toBeNull();
  });

  it('shows no number and cannot be confirmed while the contents are being counted', () => {
    const { onConfirm } = renderDialog({ preview: null });

    expect(within(dialog()).getByText('Counting what moves…')).toBeTruthy();
    expect(screen.queryByTestId('folder-delete-moves')).toBeNull();
    expect(confirmButton().hasAttribute('disabled')).toBe(true);
    fireEvent.click(confirmButton());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('renders a refusal inside the open dialog; Confirm and Cancel call back', () => {
    const { onConfirm, onCancel } = renderDialog({
      refusal:
        'A subtask filed here would be left at the project root, where a subtask can’t sit. Move it into another folder or under a work item first.',
    });

    expect(within(dialog()).getByRole('alert').textContent).toContain(
      'A subtask filed here would be left at the project root',
    );
    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
