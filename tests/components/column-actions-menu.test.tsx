// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ProjectAccessProvider } from '@/app/(authed)/_components/ProjectAccessProvider';
import { ColumnActionsMenu } from '@/app/(authed)/boards/_components/ColumnActionsMenu';

// The board column's ⋯ menu (Subtask 3.8 · MOTIR-6174): offered only to an actor
// holding `board:configure` — the key `boardsService.setColumnWipLimit` asserts
// and the Boards settings room opens on — and, for them, the WIP-limit editor's
// whole flow.

afterEach(() => cleanup());

function renderMenu(permissions: string[], wipLimit: number | null = null) {
  const onSetWipLimit = vi.fn();
  renderWithIntl(
    <ProjectAccessProvider permissions={permissions as never}>
      <ColumnActionsMenu
        columnId="c1"
        boardId="b 1"
        wipLimit={wipLimit}
        onSetWipLimit={onSetWipLimit}
      />
    </ProjectAccessProvider>,
  );
  return onSetWipLimit;
}

const CONFIGURER = ['project:browse', 'board:configure'];

describe('ColumnActionsMenu', () => {
  it('is not drawn at all without board:configure — an entry point with nothing in it is worse than none', () => {
    renderMenu(['project:browse', 'work_item:edit', 'sprint:manage']);
    expect(screen.queryByRole('button', { name: 'Column actions' })).toBeNull();
  });

  it('offers Board settings as a deep link to THIS board', () => {
    renderMenu(CONFIGURER);
    fireEvent.click(screen.getByRole('button', { name: 'Column actions' }));
    expect(screen.getByTestId('board-column-settings-link-c1').getAttribute('href')).toBe(
      '/settings/project/board?board=b%201',
    );
  });

  it('sets a limit (seeded from the current one), refusing a non-number first', () => {
    const onSet = renderMenu(CONFIGURER, 4);
    fireEvent.click(screen.getByRole('button', { name: 'Column actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set WIP limit' }));
    const field = screen.getByLabelText('WIP limit (work items)') as HTMLInputElement;
    expect(field.value).toBe('4');

    fireEvent.change(field, { target: { value: '-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Enter a non-negative whole number.')).toBeTruthy();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(onSet).not.toHaveBeenCalled();

    // Typing clears the error; Enter saves.
    fireEvent.change(field, { target: { value: '6' } });
    expect(screen.queryByText('Enter a non-negative whole number.')).toBeNull();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onSet).toHaveBeenCalledWith('c1', 6);
  });

  it('clears a limit, and closing the menu resets the draft', () => {
    const onSet = renderMenu(CONFIGURER, 3);
    fireEvent.click(screen.getByRole('button', { name: 'Column actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set WIP limit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onSet).toHaveBeenCalledWith('c1', null);

    fireEvent.click(screen.getByRole('button', { name: 'Column actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set WIP limit' }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Column actions' }));
    expect(screen.queryByLabelText('WIP limit (work items)')).toBeNull();
  });

  it('with no current limit the editor opens empty', () => {
    renderMenu(CONFIGURER, null);
    fireEvent.click(screen.getByRole('button', { name: 'Column actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set WIP limit' }));
    expect((screen.getByLabelText('WIP limit (work items)') as HTMLInputElement).value).toBe('');
  });
});
