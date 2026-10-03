// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { FolderDeleteDialog } from '@/components/folders/FolderDeleteDialog';
import type { FolderDeletionPreviewDto } from '@/lib/dto/folders';

// The DELETE-FOLDER confirmation (Story MOTIR-5308 · MOTIR-5346): what moves and
// where, never a guessed number, and both refusals inside the open dialog. A
// folder holds pages too (Story MOTIR-5753 · MOTIR-7371): the line counts them,
// in en and zh, and a folder holding only pages is not "empty".

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function preview(
  folders: number,
  items: number,
  destination: { folderId: string | null; name: string | null } = { folderId: null, name: null },
  pages = 0,
): FolderDeletionPreviewDto {
  return {
    folderId: 'f1',
    name: 'Parked',
    childFolderCount: folders,
    workItemCount: items,
    pageCount: pages,
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
      '2 folders and 3 work items will move to Project root. No work items or pages are deleted.',
    );
    expect(confirmButton().hasAttribute('disabled')).toBe(false);
  });

  it('names only the kind that is present, and the parent folder as the destination', () => {
    renderDialog({ preview: preview(0, 3, { folderId: 'later', name: 'Later' }) });
    expect(screen.getByTestId('folder-delete-moves').textContent).toBe(
      '3 work items will move to Later. No work items or pages are deleted.',
    );
    cleanup();

    renderDialog({ preview: preview(1, 0) });
    expect(screen.getByTestId('folder-delete-moves').textContent).toBe(
      '1 folder will move to Project root. No work items or pages are deleted.',
    );
  });

  it('counts pages beside folders and work items, naming only the kinds present', () => {
    const line = () => screen.getByTestId('folder-delete-moves').textContent;
    const root = { folderId: null, name: null };
    const cases: Array<[number, number, number, string]> = [
      [2, 4, 3, '2 folders, 4 work items and 3 pages'],
      [1, 1, 1, '1 folder, 1 work item and 1 page'],
      [0, 0, 3, '3 pages'],
      [0, 0, 1, '1 page'],
      [2, 0, 3, '2 folders and 3 pages'],
      [0, 4, 1, '4 work items and 1 page'],
    ];
    for (const [folders, items, pages, counted] of cases) {
      renderDialog({ preview: preview(folders, items, root, pages) });
      expect(line()).toBe(
        `${counted} will move to Project root. No work items or pages are deleted.`,
      );
      cleanup();
    }
  });

  it('a folder holding only pages is not empty: it gets the lead, the line and a live Confirm', () => {
    renderDialog({ folderName: 'Specs', preview: preview(0, 0, undefined, 2) });

    expect(
      within(dialog()).getByText(
        'Only the folder is removed. Everything filed in it stays in the project.',
      ),
    ).toBeTruthy();
    expect(within(dialog()).queryByText(/is empty/)).toBeNull();
    expect(screen.getByTestId('folder-delete-moves').textContent).toBe(
      '2 pages will move to Project root. No work items or pages are deleted.',
    );
    expect(confirmButton().hasAttribute('disabled')).toBe(false);
  });

  it('counts pages in zh too', () => {
    render(
      <FolderDeleteDialog
        folderName="Specs"
        preview={preview(2, 4, { folderId: 'later', name: '稍后' }, 3)}
        refusal={null}
        pending={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
      { locale: 'zh', messages: zhMessages },
    );
    expect(screen.getByTestId('folder-delete-moves').textContent).toBe(
      '2 个文件夹、4 个工作项和 3 个页面将移动到稍后。不会删除任何工作项或页面。',
    );
    cleanup();

    render(
      <FolderDeleteDialog
        folderName="Specs"
        preview={preview(0, 0, undefined, 1)}
        refusal={null}
        pending={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
      { locale: 'zh', messages: zhMessages },
    );
    expect(screen.getByTestId('folder-delete-moves').textContent).toBe(
      '1 个页面将移动到项目根目录。不会删除任何工作项或页面。',
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
