// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { FolderPickerPanel } from '@/app/(authed)/items/_components/FolderPicker';
import type { FolderPickerNodeDto } from '@/lib/dto/folders';

// The FOLDER PICKER panel (Story MOTIR-5308 · MOTIR-5345), built once for two
// modes: `move` (Move to… on a folder) and `file` (the quick view's Folder field,
// MOTIR-5316). Presentational — the read and the write are the caller's.

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Later ▸ 2025 ▸ Q1, and Research — in tree order, as listProjectFolders returns.
const folders: FolderPickerNodeDto[] = [
  { id: 'later', parentFolderId: null, name: 'Later', position: 'a0', path: ['Later'] },
  { id: 'y2025', parentFolderId: 'later', name: '2025', position: 'a0', path: ['Later', '2025'] },
  {
    id: 'q1',
    parentFolderId: 'y2025',
    name: 'Q1',
    position: 'a0',
    path: ['Later', '2025', 'Q1'],
  },
  { id: 'research', parentFolderId: null, name: 'Research', position: 'a1', path: ['Research'] },
];

function renderPicker(over: Partial<Parameters<typeof FolderPickerPanel>[0]> = {}) {
  const onPick = vi.fn();
  const onDismiss = vi.fn();
  render(
    <FolderPickerPanel
      mode="move"
      title="Move “2025” to…"
      folders={folders}
      truncated={false}
      currentFolderId="later"
      movingFolderId="y2025"
      refusal={null}
      onPick={onPick}
      onDismiss={onDismiss}
      {...over}
    />,
  );
  return { onPick, onDismiss };
}

const optionTexts = () => screen.getAllByRole('option').map((o) => o.textContent);

describe('FolderPickerPanel — move mode', () => {
  it('offers Project root, tags the current location, and disables the folder and everything under it with the reason', () => {
    renderPicker();

    expect(screen.getByText('Move “2025” to…')).toBeTruthy();
    expect(optionTexts()).toEqual([
      'Project root',
      'LaterCurrent location',
      '2025Can’t move a folder into itself.',
      'Q1It’s inside “2025”.',
      'Research',
    ]);
    const [root, later, self, child, research] = screen.getAllByRole('option');
    expect(root!.getAttribute('aria-disabled')).toBeNull();
    expect(later!.getAttribute('aria-selected')).toBe('true');
    expect(self!.getAttribute('aria-disabled')).toBe('true');
    expect(child!.getAttribute('aria-disabled')).toBe('true');
    expect(research!.getAttribute('aria-disabled')).toBeNull();
  });

  it('picking a folder commits; a disabled option and the current location call nothing', () => {
    const { onPick, onDismiss } = renderPicker();
    const [root, later, self, child, research] = screen.getAllByRole('option');

    fireEvent.click(self!);
    fireEvent.click(child!);
    expect(onPick).not.toHaveBeenCalled();

    fireEvent.click(later!);
    expect(onPick).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);

    fireEvent.click(research!);
    expect(onPick).toHaveBeenLastCalledWith('research');
    fireEvent.click(root!);
    expect(onPick).toHaveBeenLastCalledWith(null);
  });

  it('search narrows by path, and the keyboard picks the active option', () => {
    const { onPick } = renderPicker();
    const search = screen.getByRole('combobox', { name: 'Find a folder' });

    fireEvent.change(search, { target: { value: '2025' } });
    expect(optionTexts()).toEqual([
      'Later ▸ 2025Can’t move a folder into itself.',
      'Later ▸ 2025 ▸ Q1It’s inside “2025”.',
    ]);

    fireEvent.change(search, { target: { value: 'res' } });
    expect(optionTexts()).toEqual(['Research']);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('research');
  });

  it('arrow keys skip disabled options', () => {
    const { onPick } = renderPicker();
    const search = screen.getByRole('combobox', { name: 'Find a folder' });

    // Active starts on Project root; down → Later (current) → Research (2025 and Q1 skipped).
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(search.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[4]!.id);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('research');
  });

  it('shows a refusal at the top, a loading state, and a truncation line', () => {
    renderPicker({ refusal: 'A folder can’t move into one of its own folders.' });
    expect(screen.getByRole('alert').textContent).toBe(
      'A folder can’t move into one of its own folders.',
    );
    cleanup();

    renderPicker({ folders: null });
    expect(screen.getByText('Loading folders…')).toBeTruthy();
    expect(screen.queryByRole('listbox')).toBeNull();
    cleanup();

    renderPicker({ truncated: true });
    expect(screen.getByText('Showing the first 4 folders.')).toBeTruthy();
  });
});

describe('FolderPickerPanel — file mode', () => {
  it('disables nothing and offers No folder as the root option', () => {
    const { onPick } = renderPicker({
      mode: 'file',
      title: 'Folder',
      currentFolderId: null,
      movingFolderId: undefined,
    });

    expect(optionTexts()).toEqual(['No folderCurrent location', 'Later', '2025', 'Q1', 'Research']);
    expect(screen.getAllByRole('option').some((o) => o.getAttribute('aria-disabled'))).toBe(false);
    fireEvent.click(screen.getAllByRole('option')[3]!);
    expect(onPick).toHaveBeenCalledWith('q1');
  });
});
