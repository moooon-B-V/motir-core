// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { StaffIdeaDto, StaffIdeaTagDto } from '@/lib/dto/ideas';

/**
 * The idea detail's WRITE island (Story MOTIR-7664 · MOTIR-7681; design
 * `platform-admin` § Ideas, Panels 6–10): the controls each role is drawn, the
 * edit form's draft and its in-place refusals, and the two required-reason
 * dialogs. The actions are stubbed at their module — what they do against the
 * store is `tests/platform/ideasActions.test.ts`'s — so each case asserts the
 * call the island makes and how it draws each answer.
 */

const updateIdeaAction = vi.hoisted(() => vi.fn());
const retireIdeaAction = vi.hoisted(() => vi.fn());
const deleteIdeaAction = vi.hoisted(() => vi.fn());
vi.mock('@/app/(admin)/admin/ideas/actions', () => ({
  updateIdeaAction,
  retireIdeaAction,
  deleteIdeaAction,
}));
const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

const { IdeaWorkbench } =
  await import('@/app/(admin)/admin/ideas/[slug]/_components/IdeaWorkbench');

const TAGS: StaffIdeaTagDto[] = [
  { slug: 'smb', label: 'SMB', description: null, count: 3 },
  { slug: 'consumer', label: 'Consumer', description: null, count: 1 },
];

function makeIdea(overrides: Partial<StaffIdeaDto> = {}): StaffIdeaDto {
  return {
    id: 'idea_1',
    slug: 'stop-returns',
    title: 'Stop returns before they happen',
    pitch: 'Predict the return.',
    kind: 'direction',
    category: { slug: 'ecommerce', label: 'E-commerce' },
    tags: [{ slug: 'smb', label: 'SMB' }],
    capabilities: ['Scores every order'],
    evidence: [
      {
        claim: 'Returns cost 20%.',
        sourceName: 'A report',
        url: 'https://example.com/a',
        sourceDate: '2026-01-01',
      },
    ],
    gap: 'Nobody predicts it.',
    whyNow: null,
    whyMotir: null,
    whoElse: null,
    status: 'active',
    retiredReason: null,
    retiredAt: null,
    addedAt: '2026-10-01T10:00:00.000Z',
    lastReviewedAt: null,
    updatedAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  updateIdeaAction.mockReset();
  retireIdeaAction.mockReset();
  deleteIdeaAction.mockReset();
  push.mockReset();
});

function renderWorkbench(
  idea: StaffIdeaDto = makeIdea(),
  { canDelete = false, retiredBy = null }: { canDelete?: boolean; retiredBy?: string | null } = {},
) {
  return render(
    <ToastProvider>
      <IdeaWorkbench idea={idea} tags={TAGS} retiredBy={retiredBy} canDelete={canDelete} />
    </ToastProvider>,
  );
}

const button = (name: string | RegExp) => screen.getByRole('button', { name });

describe('the controls by role', () => {
  it('gives an operator Edit and Retire, and no Delete', () => {
    renderWorkbench();
    const actions = screen.getByTestId('idea-actions');
    expect(within(actions).getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(within(actions).getByRole('button', { name: 'Retire' })).toBeTruthy();
    expect(within(actions).queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('adds Delete for a superadmin', () => {
    renderWorkbench(makeIdea(), { canDelete: true });
    expect(
      within(screen.getByTestId('idea-actions')).getByRole('button', { name: 'Delete' }),
    ).toBeTruthy();
  });

  it('offers no Retire on a retired idea, and names who retired it', () => {
    renderWorkbench(
      makeIdea({
        status: 'retired',
        retiredReason: 'A competitor shipped it',
        retiredAt: '2026-10-02T09:00:00.000Z',
      }),
      { retiredBy: 'Ops Person' },
    );
    expect(screen.queryByRole('button', { name: 'Retire' })).toBeNull();
    expect(button('Edit')).toBeTruthy();
    const box = screen.getByTestId('idea-retired-box');
    expect(box.textContent).toContain('A competitor shipped it');
    expect(box.textContent).toContain('Ops Person');
  });
});

describe('the edit form', () => {
  it('sends only the changed fields, then shows the stored idea and the saved line', async () => {
    const saved = makeIdea({ pitch: 'A sharper pitch.', updatedAt: '2026-10-03T10:00:00.000Z' });
    updateIdeaAction.mockResolvedValue({ ok: true, idea: saved });
    renderWorkbench();
    fireEvent.click(button('Edit'));
    fireEvent.change(screen.getByLabelText('Pitch'), { target: { value: 'A sharper pitch.' } });
    await act(async () => {
      fireEvent.click(button('Save changes'));
    });

    expect(updateIdeaAction).toHaveBeenCalledWith('stop-returns', { pitch: 'A sharper pitch.' });
    expect(screen.queryByTestId('idea-edit-form')).toBeNull();
    expect(screen.getByTestId('idea-saved').textContent).toContain('Saved.');
    expect(screen.getByText('A sharper pitch.')).toBeTruthy();
  });

  it('saves nothing and says so when no field changed', async () => {
    renderWorkbench();
    fireEvent.click(button('Edit'));
    await act(async () => {
      fireEvent.click(button('Save changes'));
    });
    expect(updateIdeaAction).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('Nothing to save');
  });

  it('sends reviewed when the box is ticked', async () => {
    updateIdeaAction.mockResolvedValue({ ok: true, idea: makeIdea() });
    renderWorkbench();
    fireEvent.click(button('Edit'));
    fireEvent.click(screen.getByRole('checkbox', { name: /Mark as reviewed today/ }));
    await act(async () => {
      fireEvent.click(button('Save changes'));
    });
    expect(updateIdeaAction).toHaveBeenCalledWith('stop-returns', { reviewed: true });
  });

  it('marks each refused field in place with its own sentence, keeps the draft, and counts them', async () => {
    updateIdeaAction.mockResolvedValue({
      ok: false,
      code: 'invalid',
      issues: [{ field: 'title' }, { field: 'evidence[0].url' }, { field: 'tags', tag: 'smb' }],
    });
    renderWorkbench();
    fireEvent.click(button('Edit'));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: ' ' } });
    fireEvent.change(screen.getByLabelText('Link'), { target: { value: 'http://plain' } });
    await act(async () => {
      fireEvent.click(button('Save changes'));
    });

    expect(screen.getByTestId('idea-edit-refused').textContent).toContain('3 fields need fixing');
    const title = screen.getByLabelText('Title');
    expect(title.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(title);
    expect(screen.getByText('Give the idea a title of at most 120 characters.')).toBeTruthy();
    expect(screen.getByLabelText('Link').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Use a full link that starts with https://.')).toBeTruthy();
    expect(screen.getByText('smb is no longer a tag; remove it.')).toBeTruthy();
    expect((screen.getByLabelText('Link') as HTMLInputElement).value).toBe('http://plain');
  });

  it('draws a refusal that is not a field as a toast and keeps the form open', async () => {
    updateIdeaAction.mockResolvedValue({ ok: false, code: 'not_permitted' });
    renderWorkbench();
    fireEvent.click(button('Edit'));
    fireEvent.change(screen.getByLabelText('Pitch'), { target: { value: 'New' } });
    await act(async () => {
      fireEvent.click(button('Save changes'));
    });
    expect(screen.getByText(/your staff role does not allow this/)).toBeTruthy();
    expect(screen.getByTestId('idea-edit-form')).toBeTruthy();
  });

  it('adds, moves and removes evidence rows, sending the new order', async () => {
    updateIdeaAction.mockResolvedValue({ ok: true, idea: makeIdea() });
    renderWorkbench();
    fireEvent.click(button('Edit'));
    expect(button('Move evidence 1 up').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button('Add evidence'));
    const rows = screen.getAllByTestId('idea-edit-evidence-row');
    const second = within(rows[1]!);
    fireEvent.change(second.getByLabelText('Claim'), { target: { value: 'New claim' } });
    fireEvent.change(second.getByLabelText('Source'), { target: { value: 'New source' } });
    fireEvent.change(second.getByLabelText('Link'), { target: { value: 'https://example.com/n' } });
    fireEvent.click(button('Move evidence 2 up'));
    await act(async () => {
      fireEvent.click(button('Save changes'));
    });
    expect(updateIdeaAction.mock.calls[0]![1].evidence).toEqual([
      {
        claim: 'New claim',
        sourceName: 'New source',
        url: 'https://example.com/n',
        sourceDate: null,
      },
      {
        claim: 'Returns cost 20%.',
        sourceName: 'A report',
        url: 'https://example.com/a',
        sourceDate: '2026-01-01',
      },
    ]);

    updateIdeaAction.mockClear();
    fireEvent.click(button('Edit'));
    fireEvent.click(button('Remove evidence 1'));
    await act(async () => {
      fireEvent.click(button('Save changes'));
    });
    expect(updateIdeaAction.mock.calls[0]![1]).toEqual({ evidence: [] });
  });

  it('shows the Motir-would-buy fields only on that kind, and clears them when switched back', async () => {
    updateIdeaAction.mockResolvedValue({ ok: true, idea: makeIdea() });
    renderWorkbench(
      makeIdea({ kind: 'motir_buys', whyMotir: 'Motir needs it.', whoElse: 'Agencies.' }),
    );
    fireEvent.click(button('Edit'));
    expect(screen.getByLabelText('Why Motir would buy it')).toBeTruthy();
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Kind' })).getByRole('button', {
        name: 'Direction',
      }),
    );
    expect(screen.queryByLabelText('Why Motir would buy it')).toBeNull();
    expect(screen.getByTestId('idea-edit-motir-only')).toBeTruthy();
    await act(async () => {
      fireEvent.click(button('Save changes'));
    });
    expect(updateIdeaAction).toHaveBeenCalledWith('stop-returns', {
      kind: 'direction',
      whyMotir: null,
      whoElse: null,
    });
  });

  it('closes on Cancel without saving', () => {
    renderWorkbench();
    fireEvent.click(button('Edit'));
    fireEvent.click(button('Cancel'));
    expect(screen.queryByTestId('idea-edit-form')).toBeNull();
    expect(updateIdeaAction).not.toHaveBeenCalled();
  });
});

describe('retire', () => {
  it('keeps Retire idea disabled until a reason is typed, then sends it trimmed', async () => {
    retireIdeaAction.mockResolvedValue({ ok: true, idea: makeIdea({ status: 'retired' }) });
    renderWorkbench();
    fireEvent.click(button('Retire'));
    const dialog = screen.getByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Retire idea' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(dialog).getByTestId('idea-retire-reason'), {
      target: { value: '  A competitor shipped it ' },
    });
    expect(confirm.hasAttribute('disabled')).toBe(false);
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(retireIdeaAction).toHaveBeenCalledWith('stop-returns', 'A competitor shipped it');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('shows the already-retired callout when another tab retired it first', async () => {
    retireIdeaAction.mockResolvedValue({ ok: false, code: 'not_active' });
    renderWorkbench();
    fireEvent.click(button('Retire'));
    fireEvent.change(screen.getByTestId('idea-retire-reason'), { target: { value: 'Because' } });
    await act(async () => {
      fireEvent.click(button('Retire idea'));
    });
    expect(screen.getByTestId('idea-already-retired').getAttribute('role')).toBe('alert');
  });

  it('marks a reason the service refuses on the field and keeps the dialog open', async () => {
    retireIdeaAction.mockResolvedValue({
      ok: false,
      code: 'invalid',
      issues: [{ field: 'reason' }],
    });
    renderWorkbench();
    fireEvent.click(button('Retire'));
    fireEvent.change(screen.getByTestId('idea-retire-reason'), { target: { value: 'x' } });
    await act(async () => {
      fireEvent.click(button('Retire idea'));
    });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByText('Write a reason (at most 2000 characters).')).toBeTruthy();
  });
});

describe('delete', () => {
  it('needs a reason AND the slug typed back, then returns to the list', async () => {
    deleteIdeaAction.mockResolvedValue({ ok: true });
    renderWorkbench(makeIdea(), { canDelete: true });
    fireEvent.click(button('Delete'));
    const dialog = screen.getByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete idea' });
    fireEvent.change(within(dialog).getByTestId('idea-delete-reason'), {
      target: { value: 'Added by mistake' },
    });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(dialog).getByTestId('idea-delete-slug'), {
      target: { value: 'stop-return' },
    });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(dialog).getByTestId('idea-delete-slug'), {
      target: { value: 'stop-returns' },
    });
    expect(confirm.hasAttribute('disabled')).toBe(false);
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(deleteIdeaAction).toHaveBeenCalledWith('stop-returns', 'Added by mistake');
    expect(push).toHaveBeenCalledWith('/admin/ideas');
    expect(screen.getByText(/Deleted “Stop returns before they happen”/)).toBeTruthy();
  });

  it('answers a deleted-meanwhile idea by returning to the list', async () => {
    deleteIdeaAction.mockResolvedValue({ ok: false, code: 'not_found' });
    renderWorkbench(makeIdea(), { canDelete: true });
    fireEvent.click(button('Delete'));
    fireEvent.change(screen.getByTestId('idea-delete-reason'), { target: { value: 'x' } });
    fireEvent.change(screen.getByTestId('idea-delete-slug'), { target: { value: 'stop-returns' } });
    await act(async () => {
      fireEvent.click(button('Delete idea'));
    });
    expect(screen.getByText(/no longer exists/)).toBeTruthy();
    expect(push).toHaveBeenCalledWith('/admin/ideas');
  });
});
