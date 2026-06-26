// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ProposalEditModal } from '@/components/planning/ProposalEditModal';
import type { PlanReviewItemDto } from '@/lib/dto/planReview';

// Component tests for the proposed-`add` inline edit form (Subtask 7.21.6 /
// MOTIR-1370). The substrate + API are covered by the real-DB plansService
// suite; here we assert the modal seeds from the item, validates a non-empty
// title, and submits the merged edit. happy-dom.

afterEach(cleanup);

function addItem(over: Partial<PlanReviewItemDto> = {}): PlanReviewItemDto {
  return {
    planItemId: 'pi_1',
    op: 'add',
    nodeId: 'pi_1',
    parentNodeId: null,
    blockedByNodeIds: [],
    identifier: null,
    title: 'Original title',
    kind: 'task',
    priority: 'low',
    type: 'code',
    descriptionMd: 'Original description',
    status: null,
    hasChildren: false,
    changes: [],
    stale: false,
    staleReasons: [],
    targetMissing: false,
    ...over,
  };
}

describe('ProposalEditModal', () => {
  it('renders nothing when the item is null (closed)', () => {
    renderWithIntl(
      <ProposalEditModal
        item={null}
        onOpenChange={() => {}}
        onSubmit={vi.fn()}
        busy={false}
        errorCode={null}
      />,
    );
    expect(screen.queryByText('Edit proposed item')).toBeNull();
  });

  it('seeds the form from the item and submits the merged edit (untouched fields preserved)', () => {
    const onSubmit = vi.fn();
    renderWithIntl(
      <ProposalEditModal
        item={addItem()}
        onOpenChange={() => {}}
        onSubmit={onSubmit}
        busy={false}
        errorCode={null}
      />,
    );
    // Seeded from the item.
    const title = screen.getByLabelText('Title') as HTMLInputElement;
    expect(title.value).toBe('Original title');
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe(
      'Original description',
    );

    fireEvent.change(title, { target: { value: 'Renamed proposal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toBe('pi_1');
    // Edited title + the untouched seeded kind/priority/type/description.
    expect(onSubmit.mock.calls[0]![1]).toMatchObject({
      title: 'Renamed proposal',
      kind: 'task',
      priority: 'low',
      type: 'code',
      descriptionMd: 'Original description',
    });
  });

  it('blocks save on an empty title and never calls onSubmit', () => {
    const onSubmit = vi.fn();
    renderWithIntl(
      <ProposalEditModal
        item={addItem()}
        onOpenChange={() => {}}
        onSubmit={onSubmit}
        busy={false}
        errorCode={null}
      />,
    );
    const title = screen.getByLabelText('Title') as HTMLInputElement;
    fireEvent.change(title, { target: { value: '   ' } });

    const save = screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('clears an empty description to null on submit', () => {
    const onSubmit = vi.fn();
    renderWithIntl(
      <ProposalEditModal
        item={addItem({ descriptionMd: 'has text' })}
        onOpenChange={() => {}}
        onSubmit={onSubmit}
        busy={false}
        errorCode={null}
      />,
    );
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onSubmit.mock.calls[0]![1].descriptionMd).toBeNull();
  });
});
