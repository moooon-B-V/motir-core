// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { BoardCard } from '@/app/(authed)/boards/_components/BoardCard';
import type { BoardCardDto } from '@/lib/dto/boards';

// BoardCard (Subtask 3.2.3) is a pure presentational card: it REUSES the issue
// primitives (IssueTypeIcon, PriorityValue, Avatar) and opens the existing
// IssueQuickView via the onOpenQuickView callback the board wires. Rendered with
// the real `en` catalog so the priority / blocked / assignee strings are exact.

function card(over: Partial<BoardCardDto> & { id: string; key: number }): BoardCardDto {
  return {
    projectId: 'p1',
    parentId: null,
    kind: 'task',
    identifier: `PROD-${over.key}`,
    title: `Card ${over.key}`,
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
    dueDate: null,
    estimateMinutes: null,
    storyPoints: null,
    position: 'a0',
    ready: true,
    ...over,
  };
}

afterEach(cleanup);

describe('BoardCard', () => {
  it('renders the identifier, title, priority chip and estimate', () => {
    render(
      <BoardCard
        card={card({
          id: 'w1',
          key: 7,
          title: 'Wire OAuth',
          priority: 'high',
          estimateMinutes: 90,
        })}
        assigneeName="Yue Zhu"
        onOpenQuickView={() => {}}
      />,
    );
    expect(screen.getByText('PROD-7')).toBeTruthy();
    expect(screen.getByText('Wire OAuth')).toBeTruthy();
    // Priority chip uses the shared PRIORITY_META label (labels.priority.high).
    expect(screen.getByText('High')).toBeTruthy();
    // Estimate chip is the shared formatDurationMinutes output.
    expect(screen.getByText('1h 30m')).toBeTruthy();
  });

  it('omits the estimate chip when the card has no estimate', () => {
    render(
      <BoardCard
        card={card({ id: 'w1', key: 1 })}
        assigneeName={null}
        onOpenQuickView={() => {}}
      />,
    );
    // The medium-priority chip shows, but the estimate chip (titled "Estimate …")
    // is absent.
    expect(screen.getByText('Medium')).toBeTruthy();
    expect(screen.queryByTitle(/^Estimate/)).toBeNull();
  });

  it('shows the assignee initial avatar when assigned', () => {
    render(
      <BoardCard
        card={card({ id: 'w1', key: 1, assigneeId: 'u1' })}
        assigneeName="Ana Ruiz"
        onOpenQuickView={() => {}}
      />,
    );
    expect(screen.getByText('A')).toBeTruthy();
    expect(screen.getByTitle('Assigned to Ana Ruiz')).toBeTruthy();
  });

  it('shows the unassigned placeholder when there is no assignee', () => {
    render(
      <BoardCard
        card={card({ id: 'w1', key: 1 })}
        assigneeName={null}
        onOpenQuickView={() => {}}
      />,
    );
    expect(screen.getByLabelText('Unassigned')).toBeTruthy();
  });

  it('shows the blocked pill instead of the priority chip when not ready', () => {
    render(
      <BoardCard
        card={card({ id: 'w1', key: 1, priority: 'high', ready: false })}
        assigneeName={null}
        onOpenQuickView={() => {}}
      />,
    );
    expect(screen.getByText('Blocked')).toBeTruthy();
    // The priority chip is swapped out, not shown alongside.
    expect(screen.queryByText('High')).toBeNull();
  });

  it('calls onOpenQuickView with the identifier on click', () => {
    const onOpen = vi.fn();
    render(
      <BoardCard card={card({ id: 'w1', key: 9 })} assigneeName={null} onOpenQuickView={onOpen} />,
    );
    fireEvent.click(screen.getByTestId('board-card-PROD-9'));
    expect(onOpen).toHaveBeenCalledWith('PROD-9');
  });
});
