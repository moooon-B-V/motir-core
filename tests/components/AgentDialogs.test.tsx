// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { CreateAgentDialog } from '@/app/(authed)/my-agents/_components/CreateAgentDialog';
import { DeleteAgentDialog } from '@/app/(authed)/my-agents/_components/DeleteAgentDialog';

// THE CREATE AND DELETE DIALOGS, on their own (Story MOTIR-6860 · MOTIR-6874;
// MOTIR-7062 — the lane measures them now). `MyAgentsRoom.test.tsx` drives both
// through the room's happy paths; what is held here is each dialog's own way OUT
// — Cancel and Keep it close without acting — and Create's guard: a submit that
// reaches the form with no name, or with no coding agent to pick, sends nothing.

const PROFILES = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
];

afterEach(() => {
  cleanup();
});

function create(over: Partial<Parameters<typeof CreateAgentDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  const onCreate = vi.fn();
  render(
    <CreateAgentDialog
      open
      onOpenChange={onOpenChange}
      projectName="motir"
      profiles={PROFILES}
      pending={false}
      refusal={null}
      onCreate={onCreate}
      {...over}
    />,
  );
  const dialog = screen.getByRole('dialog');
  const form = dialog.querySelector('form')!;
  return { dialog, form, onOpenChange, onCreate };
}

describe('CreateAgentDialog', () => {
  it('Cancel closes the dialog and creates nothing', () => {
    const { dialog, onOpenChange, onCreate } = create();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('a submit with only spaces for a name sends nothing; a real one sends it trimmed', () => {
    const { dialog, form, onCreate } = create();
    const name = within(dialog).getByLabelText('Name');
    fireEvent.change(name, { target: { value: '   ' } });
    // Enter in the field submits the form even while the button is disabled.
    fireEvent.submit(form);
    expect(onCreate).not.toHaveBeenCalled();

    fireEvent.change(name, { target: { value: '  yue-codex ' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: /Codex/ }));
    fireEvent.submit(form);
    expect(onCreate).toHaveBeenCalledWith({ name: 'yue-codex', profileId: 'codex' });
  });

  it('a submit while Create is pending is not sent twice', () => {
    const { dialog, form, onCreate } = create({ pending: true });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'yue' } });
    fireEvent.submit(form);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('with no coding agent offered there is nothing to pick, and a named submit still sends nothing', () => {
    const { dialog, form, onCreate } = create({ profiles: [] });
    expect(within(dialog).queryAllByRole('radio')).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'yue' } });
    fireEvent.submit(form);
    expect(onCreate).not.toHaveBeenCalled();
  });
});

describe('DeleteAgentDialog', () => {
  it('names the agent, and Keep it — the safe default — closes without deleting', () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    render(
      <DeleteAgentDialog
        name="yue-claude"
        onOpenChange={onOpenChange}
        pending={false}
        refusal={null}
        onConfirm={onConfirm}
      />,
    );
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('Delete yue-claude?');
    const keep = within(dialog).getByRole('button', { name: 'Keep it' });
    expect(document.activeElement).toBe(keep);
    fireEvent.click(keep);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('is closed while no agent is named', () => {
    render(
      <DeleteAgentDialog
        name={null}
        onOpenChange={vi.fn()}
        pending={false}
        refusal={null}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
