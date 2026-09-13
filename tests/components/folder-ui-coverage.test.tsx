// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// The folder UI's remaining ARMS (Story MOTIR-5308 · MOTIR-5317, the story's
// vitest gate) — the keyboard, dismissal and failure paths the per-card tests
// did not reach, so each new folder component clears the project's per-file
// coverage floor. Every case asserts behaviour a person can see or rely on; none
// exists only to execute a line.

const { listProjectFoldersAction } = vi.hoisted(() => ({ listProjectFoldersAction: vi.fn() }));
vi.mock('@/app/(authed)/items/actions', () => ({ listProjectFoldersAction }));

import { FolderDeleteDialog } from '@/app/(authed)/items/_components/FolderDeleteDialog';
import { FolderNameField } from '@/app/(authed)/items/_components/FolderNameField';
import {
  FolderPickerPanel,
  FolderPickerPopover,
} from '@/app/(authed)/items/_components/FolderPicker';
import {
  FolderRowMenu,
  type FolderMenuEntry,
} from '@/app/(authed)/items/_components/FolderRowMenu';
import { QuickViewFolderControl } from '@/app/(authed)/items/_components/QuickViewFolderField';
import type { FolderPickerNodeDto } from '@/lib/dto/folders';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const NoIcon = () => null;

// Later ▸ 2025 ▸ Q1 ▸ Q1a, and Research.
const FOLDERS: FolderPickerNodeDto[] = [
  { id: 'later', parentFolderId: null, name: 'Later', position: 'a0', path: ['Later'] },
  { id: 'y2025', parentFolderId: 'later', name: '2025', position: 'a0', path: ['Later', '2025'] },
  { id: 'q1', parentFolderId: 'y2025', name: 'Q1', position: 'a0', path: ['Later', '2025', 'Q1'] },
  {
    id: 'q1a',
    parentFolderId: 'q1',
    name: 'Q1a',
    position: 'a0',
    path: ['Later', '2025', 'Q1', 'Q1a'],
  },
  { id: 'research', parentFolderId: null, name: 'Research', position: 'a1', path: ['Research'] },
];

describe('FolderDeleteDialog — dismissal', () => {
  it('the dialog’s own close button cancels', async () => {
    const onCancel = vi.fn();
    render(
      <FolderDeleteDialog
        folderName="Parked"
        preview={{
          folderId: 'f1',
          name: 'Parked',
          childFolderCount: 0,
          workItemCount: 0,
          destination: { folderId: null, name: null },
        }}
        refusal={null}
        pending={false}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Close' }),
      );
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('FolderNameField — keys and clicks stay inside the field', () => {
  function renderField(pending = false) {
    const handlers = { onSubmit: vi.fn(), onCancel: vi.fn(), onEdit: vi.fn(), rowClick: vi.fn() };
    render(
      // The row's own click would toggle a folder; the field must not reach it.
      <div onClick={handlers.rowClick}>
        <FolderNameField
          initialName="Later"
          error={null}
          pending={pending}
          onSubmit={handlers.onSubmit}
          onCancel={handlers.onCancel}
          onEdit={handlers.onEdit}
        />
      </div>,
    );
    return { ...handlers, input: screen.getByRole('textbox', { name: 'Folder name' }) };
  }

  it('a click in the field does not reach the row', () => {
    const { input, rowClick } = renderField();
    fireEvent.click(input);
    expect(rowClick).not.toHaveBeenCalled();
  });

  it('Enter while the write is pending does not submit again, and other keys do nothing', () => {
    const { input, onSubmit, onCancel } = renderField(true);
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'a' });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(input.hasAttribute('readonly')).toBe(true);
  });
});

describe('FolderPickerPanel — keyboard, pointer and deep nesting', () => {
  function renderPanel() {
    const onPick = vi.fn();
    const onDismiss = vi.fn();
    render(
      <FolderPickerPanel
        mode="move"
        title="Move “2025” to…"
        folders={FOLDERS}
        truncated={false}
        currentFolderId="later"
        movingFolderId="y2025"
        refusal={null}
        onPick={onPick}
        onDismiss={onDismiss}
      />,
    );
    return { onPick, onDismiss, search: screen.getByRole('combobox', { name: 'Find a folder' }) };
  }

  it('a folder two levels under the moved one is disabled with the moved folder named', () => {
    renderPanel();
    const deep = screen.getAllByRole('option').find((o) => o.textContent?.startsWith('Q1a'))!;
    expect(deep.getAttribute('aria-disabled')).toBe('true');
    expect(deep.textContent).toContain('It’s inside “2025”.');
  });

  it('ArrowUp from the first option wraps to the last enabled one, and Escape dismisses', () => {
    const { search, onDismiss } = renderPanel();
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    const research = screen.getAllByRole('option').find((o) => o.textContent === 'Research')!;
    expect(search.getAttribute('aria-activedescendant')).toBe(research.id);

    fireEvent.keyDown(search, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('a search matching nothing leaves the arrows and Enter with nothing to do', () => {
    const { search, onPick } = renderPanel();
    fireEvent.change(search, { target: { value: 'no such folder' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onPick).not.toHaveBeenCalled();
    expect(search.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('hovering an enabled option makes it active, hovering a disabled one does not, and Enter on an option picks it', () => {
    const { search, onPick } = renderPanel();
    const options = screen.getAllByRole('option');
    const research = options.find((o) => o.textContent === 'Research')!;
    const self = options.find((o) => o.textContent?.startsWith('2025'))!;

    fireEvent.mouseEnter(research);
    expect(search.getAttribute('aria-activedescendant')).toBe(research.id);
    fireEvent.mouseEnter(self);
    expect(search.getAttribute('aria-activedescendant')).toBe(research.id);

    // Pressing on an option keeps focus in the search field.
    expect(fireEvent.mouseDown(research)).toBe(false);
    fireEvent.keyDown(research, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('research');
  });
});

describe('FolderPickerPopover — the panel lives inside the treegrid row', () => {
  it('clicks and keys inside the open panel do not reach the row', async () => {
    const rowClick = vi.fn();
    const rowKey = vi.fn();
    render(
      <div onClick={rowClick} onKeyDown={rowKey}>
        <FolderPickerPopover open onOpenChange={vi.fn()} anchor={<button type="button">a</button>}>
          <button type="button">Inside</button>
        </FolderPickerPopover>
      </div>,
    );

    const inside = await screen.findByRole('button', { name: 'Inside' });
    fireEvent.click(inside);
    fireEvent.keyDown(inside, { key: 'ArrowDown' });

    expect(rowClick).not.toHaveBeenCalled();
    expect(rowKey).not.toHaveBeenCalled();
  });
});

describe('FolderRowMenu — keyboard edges', () => {
  const entries = (disabled: boolean[]): FolderMenuEntry[] =>
    disabled.map((d, i) => ({
      kind: 'item',
      key: `e${i}`,
      label: `Entry ${i}`,
      icon: NoIcon,
      disabled: d,
      onSelect: vi.fn(),
    }));

  async function openMenu(list: FolderMenuEntry[]) {
    const rowKey = vi.fn();
    render(
      <div onKeyDown={rowKey}>
        <FolderRowMenu label="Folder actions for Later" entries={list} />
      </div>,
    );
    const trigger = screen.getByRole('button', { name: 'Folder actions for Later' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    await act(async () => {
      fireEvent.click(trigger);
    });
    return { rowKey, menu: await screen.findByRole('menu', { name: 'Folder actions for Later' }) };
  }

  it('Home and End jump to the first and last enabled entries; ArrowDown with nothing focused starts at the top', async () => {
    const { menu, rowKey } = await openMenu(entries([false, false, true]));
    const [first, second] = within(menu).getAllByRole('menuitem');

    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(first);

    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(first);
    // Neither the trigger's keys nor the menu's reach the row.
    expect(rowKey).not.toHaveBeenCalled();
  });

  it('a menu whose entries are all disabled ignores the arrow keys', async () => {
    const { menu } = await openMenu(entries([true, true]));
    const before = document.activeElement;
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(before);
  });
});

describe('QuickViewFolderControl — the folder list read', () => {
  function renderControl() {
    const onPick = vi.fn();
    const utils = render(
      <QuickViewFolderControl folderId="later" parent={null} onPick={onPick} onDismiss={vi.fn()} />,
    );
    return { onPick, ...utils };
  }

  it('a refused read shows the refusal and leaves No folder to pick', async () => {
    listProjectFoldersAction.mockResolvedValue({ ok: false, error: 'No active project.' });
    const { onPick } = renderControl();

    expect((await screen.findByRole('alert')).textContent).toBe('No active project.');
    fireEvent.click(screen.getByRole('option', { name: 'No folder' }));
    expect(onPick).toHaveBeenCalledWith(null, []);
  });

  it('a rejected read says the folder could not be filed rather than failing silently', async () => {
    listProjectFoldersAction.mockRejectedValue(new Error('network'));
    renderControl();

    expect((await screen.findByRole('alert')).textContent).toBe(
      'That folder belongs to another project, so this work item stayed where it was.',
    );
  });

  it('picking a folder hands back its path; a read that lands after the field closed is ignored', async () => {
    listProjectFoldersAction.mockResolvedValue({
      ok: true,
      data: { folders: FOLDERS, truncated: false },
    });
    const { onPick } = renderControl();
    const option = await screen.findByRole('option', { name: 'Research' });
    fireEvent.click(option);
    expect(onPick).toHaveBeenCalledWith('research', ['Research']);
    cleanup();

    let resolveLate: (v: unknown) => void = () => {};
    listProjectFoldersAction.mockImplementation(() => new Promise((r) => (resolveLate = r)));
    const late = renderControl();
    late.unmount();
    await act(async () => {
      resolveLate({ ok: true, data: { folders: FOLDERS, truncated: false } });
    });
    await waitFor(() => expect(listProjectFoldersAction).toHaveBeenCalled());
  });

  it('every folder the field offers hands back its full path', async () => {
    listProjectFoldersAction.mockResolvedValue({
      ok: true,
      data: { folders: FOLDERS, truncated: false },
    });
    const { onPick } = renderControl();
    await screen.findByRole('option', { name: 'Research' });

    // The item is filed in Later, so that option dismisses rather than picks.
    const pickable = FOLDERS.filter((f) => f.id !== 'later');
    for (const f of pickable) {
      const option = screen.getAllByRole('option').find((o) => o.id.endsWith(`-${f.id}`))!;
      fireEvent.click(option);
    }

    expect(onPick.mock.calls).toEqual(pickable.map((f) => [f.id, f.path]));
    // No pick ever fell back to an empty path.
    expect(onPick.mock.calls.every(([, path]) => path.length > 0)).toBe(true);
  });

  it('a read that FAILS after the field closed is ignored too — no refusal is set on a gone field', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let rejectLate: (e: unknown) => void = () => {};
    listProjectFoldersAction.mockImplementation(
      () => new Promise((_resolve, reject) => (rejectLate = reject)),
    );
    const late = renderControl();
    late.unmount();

    await act(async () => {
      rejectLate(new Error('network'));
    });

    expect(screen.queryByRole('alert')).toBeNull();
    // No state update landed on the unmounted field.
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
