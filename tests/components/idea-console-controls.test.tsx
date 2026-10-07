// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { StaffIdeaDto, StaffIdeaTagDto } from '@/lib/dto/ideas';
import type { IdeaListView } from '@/app/(admin)/admin/ideas/_components/ideaListQuery';

/**
 * The console's Ideas CONTROLS, one level below the page (Story MOTIR-7664 ·
 * MOTIR-7682's coverage floor): the list's filter bar and its URL writes, the
 * error card's Retry, the read-only detail's empty and partial states, every
 * field of the edit form, and the two dialogs' cancel and guard paths. The
 * actions are stubbed at their module; what they do against the store is the
 * story gate's (`tests/integration/ideasConsoleStoryGate.test.tsx`).
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
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));

const { IdeaFilters } = await import('@/app/(admin)/admin/ideas/_components/IdeaFilters');
const { IdeasUnavailable } = await import('@/app/(admin)/admin/ideas/_components/IdeasUnavailable');
const { IdeaDetailView } = await import('@/app/(admin)/admin/ideas/_components/IdeaDetailView');
const { IdeaEditForm } = await import('@/app/(admin)/admin/ideas/[slug]/_components/IdeaEditForm');
const { RetireIdeaDialog } =
  await import('@/app/(admin)/admin/ideas/[slug]/_components/RetireIdeaDialog');
const { DeleteIdeaDialog } =
  await import('@/app/(admin)/admin/ideas/[slug]/_components/DeleteIdeaDialog');

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
    kind: 'motir_buys',
    category: { slug: 'ecommerce', label: 'E-commerce' },
    tags: [{ slug: 'smb', label: 'SMB' }],
    capabilities: ['Scores every order'],
    evidence: [],
    gap: null,
    whyNow: null,
    whyMotir: 'Motir needs it.',
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
  refresh.mockReset();
});

const FILTER_TAGS = TAGS.map(({ slug, label }) => ({ slug, label }));

function pickFrom(combobox: string, option: string) {
  fireEvent.click(screen.getByRole('combobox', { name: combobox }));
  fireEvent.click(screen.getByRole('option', { name: option }));
}

describe('the filter bar', () => {
  it('writes each filter to the URL, dropping the cursor', () => {
    const view: IdeaListView = { status: 'active', cursor: 'c1' };
    render(<IdeaFilters view={view} tags={FILTER_TAGS} />);

    fireEvent.change(screen.getByTestId('ideas-filter-search'), {
      target: { value: '  returns ' },
    });
    fireEvent.submit(screen.getByTestId('ideas-filter-search').closest('form')!);
    expect(push).toHaveBeenLastCalledWith('/admin/ideas?q=returns');

    fireEvent.click(screen.getByRole('button', { name: 'Retired' }));
    expect(push).toHaveBeenLastCalledWith('/admin/ideas?status=retired');

    pickFrom('Kind', 'Direction');
    expect(push).toHaveBeenLastCalledWith('/admin/ideas?kind=direction');

    pickFrom('Category', 'Pets');
    expect(push).toHaveBeenLastCalledWith('/admin/ideas?category=pets');

    pickFrom('Tag', 'Consumer');
    expect(push).toHaveBeenLastCalledWith('/admin/ideas?tag=consumer');
  });

  it('clears a filter by picking Any, and an emptied search drops q', () => {
    const view: IdeaListView = {
      status: 'all',
      q: 'returns',
      kind: 'direction',
      category: 'pets',
      tag: 'smb',
    };
    render(<IdeaFilters view={view} tags={FILTER_TAGS} />);

    pickFrom('Kind', 'Any kind');
    expect(push).toHaveBeenLastCalledWith(
      '/admin/ideas?q=returns&status=all&category=pets&tag=smb',
    );
    pickFrom('Category', 'Any category');
    expect(push).toHaveBeenLastCalledWith(
      '/admin/ideas?q=returns&status=all&kind=direction&tag=smb',
    );
    pickFrom('Tag', 'Any tag');
    expect(push).toHaveBeenLastCalledWith(
      '/admin/ideas?q=returns&status=all&kind=direction&category=pets',
    );

    fireEvent.change(screen.getByTestId('ideas-filter-search'), { target: { value: '   ' } });
    fireEvent.submit(screen.getByTestId('ideas-filter-search').closest('form')!);
    expect(push).toHaveBeenLastCalledWith(
      '/admin/ideas?status=all&kind=direction&category=pets&tag=smb',
    );
  });

  it('repeats every filter as a chip, each removable, and Clear all returns to the default', () => {
    const view: IdeaListView = {
      status: 'all',
      q: 'returns',
      kind: 'motir_buys',
      category: 'pets',
      tag: 'retired-tag',
    };
    render(<IdeaFilters view={view} tags={FILTER_TAGS} />);
    const chips = screen.getByTestId('ideas-filter-chips');
    expect(chips.textContent).toContain('Status: All');
    expect(chips.textContent).toContain('Kind: Motir would buy');
    expect(chips.textContent).toContain('Category: Pets');
    // A tag no longer in the vocabulary still names itself by slug.
    expect(chips.textContent).toContain('Tag: retired-tag');

    fireEvent.click(within(chips).getByRole('button', { name: 'Remove Search' }));
    expect(push).toHaveBeenLastCalledWith(
      '/admin/ideas?status=all&kind=motir_buys&category=pets&tag=retired-tag',
    );
    expect((screen.getByTestId('ideas-filter-search') as HTMLInputElement).value).toBe('');

    fireEvent.click(within(chips).getByRole('button', { name: 'Remove Status' }));
    expect(push).toHaveBeenLastCalledWith(
      '/admin/ideas?q=returns&kind=motir_buys&category=pets&tag=retired-tag',
    );

    fireEvent.click(within(chips).getByRole('button', { name: 'Clear all' }));
    expect(push).toHaveBeenLastCalledWith('/admin/ideas');
  });

  it('names the Retired status in its chip', () => {
    render(<IdeaFilters view={{ status: 'retired' }} tags={FILTER_TAGS} />);
    expect(screen.getByTestId('ideas-filter-chips').textContent).toContain('Status: Retired');
  });
});

describe('the error card', () => {
  it('retries by refreshing the page', async () => {
    render(<IdeasUnavailable />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('the read-only detail', () => {
  it('draws the empty states and an evidence row with no date', () => {
    render(
      <IdeaDetailView
        idea={makeIdea({
          capabilities: [],
          tags: [],
          evidence: [
            { claim: 'C', sourceName: 'A survey', url: 'https://e.example', sourceDate: null },
          ],
        })}
      />,
    );
    const body = screen.getByTestId('idea-body');
    expect(body.textContent).toContain('No capabilities listed.');
    expect(body.textContent).toContain('A survey');
    expect(body.textContent).not.toContain('A survey ·');
  });

  it('draws a retired idea with no reason or date as plainly as it can', () => {
    render(<IdeaDetailView idea={makeIdea({ status: 'retired' })} />);
    const box = screen.getByTestId('idea-retired-box');
    expect(box.textContent).toContain('Retired —');
    expect(box.textContent).not.toContain('no longer on motir.co');
  });

  it('says when without who when the retirer could not be read', () => {
    render(
      <IdeaDetailView
        idea={makeIdea({
          status: 'retired',
          retiredReason: 'Gap closed',
          retiredAt: '2026-10-02T09:00:00.000Z',
        })}
        retiredBy={null}
      />,
    );
    expect(screen.getByTestId('idea-retired-box').textContent).toContain('no longer on motir.co');
  });
});

function renderForm(idea: StaffIdeaDto = makeIdea()) {
  const onSaved = vi.fn();
  const onRefused = vi.fn();
  const onCancel = vi.fn();
  render(
    <IdeaEditForm
      idea={idea}
      tags={TAGS}
      onSaved={onSaved}
      onRefused={onRefused}
      onCancel={onCancel}
    />,
  );
  return { onSaved, onRefused, onCancel };
}

async function save() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  });
}

describe('every field of the edit form', () => {
  it('sends category, tags, capabilities, long texts and a new evidence row', async () => {
    const idea = makeIdea();
    updateIdeaAction.mockResolvedValue({ ok: true, idea });
    renderForm(idea);

    pickFrom('Category', 'Pets');

    // Tags: search the vocabulary, add one, remove the other.
    const tagBox = screen.getByRole('combobox', { name: 'Tags' });
    fireEvent.focus(tagBox);
    fireEvent.change(tagBox, { target: { value: 'cons' } });
    const listbox = screen.getByRole('listbox', { name: 'Tags' });
    expect(within(listbox).queryByRole('option', { name: /SMB/ })).toBeNull();
    fireEvent.click(within(listbox).getByRole('option', { name: 'Consumer (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove SMB' }));

    // Capabilities: edit the line, add one, then remove the first.
    fireEvent.change(screen.getByLabelText('Line 1'), { target: { value: 'Scores orders' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a line' }));
    fireEvent.change(screen.getByLabelText('Line 2'), { target: { value: 'Flags risk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove line 1' }));

    fireEvent.change(screen.getByLabelText('The gap'), {
      target: { value: 'Nobody predicts it.' },
    });
    fireEvent.change(screen.getByLabelText('Why now'), { target: { value: 'Costs rose.' } });
    fireEvent.change(screen.getByLabelText('Why Motir would buy it'), {
      target: { value: 'Motir ships returns.' },
    });
    fireEvent.change(screen.getByLabelText('Who else needs it'), {
      target: { value: 'Every shop.' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add evidence' }));
    fireEvent.change(screen.getByLabelText('Claim'), { target: { value: 'Returns cost 20%.' } });
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'A report' } });
    fireEvent.change(screen.getByLabelText('Source date'), { target: { value: '2026-01-02' } });
    fireEvent.change(screen.getByLabelText('Link'), { target: { value: 'https://e.example/a' } });

    await save();
    expect(updateIdeaAction).toHaveBeenCalledWith('stop-returns', {
      category: 'pets',
      tags: ['consumer'],
      capabilities: ['Flags risk'],
      evidence: [
        {
          claim: 'Returns cost 20%.',
          sourceName: 'A report',
          url: 'https://e.example/a',
          sourceDate: '2026-01-02',
        },
      ],
      gap: 'Nobody predicts it.',
      whyNow: 'Costs rose.',
      whyMotir: 'Motir ships returns.',
      whoElse: 'Every shop.',
    });
  });

  it('marks a list-level refusal on its section and toggles a tag off from the list', async () => {
    updateIdeaAction.mockResolvedValue({
      ok: false,
      code: 'invalid',
      issues: [{ field: 'capabilities' }],
    });
    renderForm(makeIdea({ tags: [{ slug: 'gone', label: 'Gone' }] }));

    // A tag the vocabulary no longer has still shows, by its slug.
    expect(screen.getByRole('button', { name: 'Remove gone' })).toBeTruthy();
    const tagBox = screen.getByRole('combobox', { name: 'Tags' });
    fireEvent.focus(tagBox);
    const listbox = screen.getByRole('listbox', { name: 'Tags' });
    fireEvent.click(within(listbox).getByRole('option', { name: 'SMB (3)' }));
    fireEvent.click(within(listbox).getByRole('option', { name: 'SMB (3)' }));

    fireEvent.click(screen.getByRole('button', { name: 'Remove line 1' }));
    await save();
    expect(updateIdeaAction).toHaveBeenCalledWith('stop-returns', { capabilities: [] });
    expect(screen.getByTestId('idea-edit-list-error')).toBeTruthy();
  });
});

describe('the dialogs', () => {
  it('Retire: Cancel closes without sending, and an empty submit sends nothing', () => {
    const onOpenChange = vi.fn();
    render(
      <RetireIdeaDialog idea={makeIdea()} open onOpenChange={onOpenChange} onDone={vi.fn()} />,
    );
    fireEvent.submit(screen.getByTestId('idea-retire-reason').closest('form')!);
    expect(retireIdeaAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('Delete: Cancel closes, a not-ready submit sends nothing, and a refused reason marks the field', async () => {
    const onOpenChange = vi.fn();
    const onDone = vi.fn();
    render(<DeleteIdeaDialog idea={makeIdea()} open onOpenChange={onOpenChange} onDone={onDone} />);
    const form = screen.getByTestId('idea-delete-reason').closest('form')!;
    fireEvent.change(screen.getByTestId('idea-delete-reason'), { target: { value: 'Mistake' } });
    fireEvent.submit(form);
    expect(deleteIdeaAction).not.toHaveBeenCalled();

    deleteIdeaAction.mockResolvedValue({
      ok: false,
      code: 'invalid',
      issues: [{ field: 'reason' }],
    });
    fireEvent.change(screen.getByTestId('idea-delete-slug'), {
      target: { value: 'stop-returns' },
    });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(deleteIdeaAction).toHaveBeenCalledWith('stop-returns', 'Mistake');
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByTestId('idea-delete-reason').getAttribute('aria-invalid')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
