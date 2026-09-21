// @vitest-environment happy-dom
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
    awaitingAcceptance: false,
    pendingDecision: null,
    ciState: null,
    statusCategory: 'todo',
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

  // MOTIR-2618 — the board card rendered NO story points for two months while
  // this file's first case asserted it "renders … and estimate" and passed, because
  // the estimate it renders is the TIME estimate. The two chips are adjacent, share
  // a treatment, and had one assertion between them; each now has its own.
  it('renders the story-point chip beside the time estimate (MOTIR-2618)', () => {
    render(
      <BoardCard
        card={card({ id: 'w1', key: 7, storyPoints: 5, estimateMinutes: 90 })}
        assigneeName={null}
        onOpenQuickView={() => {}}
      />,
    );
    // The `.pts` chip: the bare figure, per design/boards/board.mock.html.
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByTitle('5 story points')).toBeTruthy();
    expect(screen.getByLabelText('5 story points')).toBeTruthy();
    // …and it did not displace the time estimate — both render.
    expect(screen.getByText('1h 30m')).toBeTruthy();
    // The `hash` glyph that tells the two adjacent mono figures apart is
    // DECORATIVE — the chip's accessible name is the label alone, never "# 5".
    const glyph = screen.getByLabelText('5 story points').querySelector('svg');
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
  });

  it('omits the story-point chip when the card is unpointed', () => {
    render(
      <BoardCard
        card={card({ id: 'w1', key: 7, storyPoints: null, estimateMinutes: 90 })}
        assigneeName={null}
        onOpenQuickView={() => {}}
      />,
    );
    expect(screen.queryByTitle(/story points$/)).toBeNull();
    // No empty placeholder either — the slot collapses, as the estimate's does.
    expect(screen.getByText('1h 30m')).toBeTruthy();
  });

  it('formats a fractional story-point value the way every other surface does', () => {
    render(
      <BoardCard
        card={card({ id: 'w1', key: 7, storyPoints: 0.5 })}
        assigneeName={null}
        onOpenQuickView={() => {}}
      />,
    );
    expect(screen.getByText('0.5')).toBeTruthy();
  });

  // MOTIR-2618's stated NON-goal, held from the code side. The board card's own
  // surface is the drag-handle `<button>`, so `EstimateBadge`'s editable arm — a
  // button — cannot nest inside it; putting the interactive chip on the board
  // needs the overlay-vs-handle design decision first, and until that exists the
  // board renders the static span. `EstimateBadge`'s header comment names the
  // four real call sites and this asserts the board is not quietly a fifth.
  it('nothing under app/(authed)/boards imports EstimateBadge — the static chip is deliberate', () => {
    const root = join(process.cwd(), 'app/(authed)/boards');
    const sources = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) =>
      /\.tsx?$/.test(f),
    );
    // The whole tree, not just _components — and matched on the IMPORT / the JSX
    // element, so a comment explaining why the board doesn't use it (BoardCard has
    // one) is not a false positive.
    const offenders = sources.filter((f) =>
      /import[^;]*\bEstimateBadge\b|<EstimateBadge\b/.test(readFileSync(join(root, f), 'utf8')),
    );
    expect(offenders).toEqual([]);
    expect(sources.length).toBeGreaterThan(10); // the scan actually read the tree
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

  it('a story in review shows the "Awaiting acceptance" pill instead of the priority (MOTIR-1636)', () => {
    render(
      <BoardCard
        card={card({ id: 's1', key: 3, kind: 'story', priority: 'high', awaitingAcceptance: true })}
        assigneeName={null}
        onOpenQuickView={() => {}}
      />,
    );
    expect(screen.getByText('Awaiting acceptance')).toBeTruthy();
    expect(screen.queryByText('High')).toBeNull(); // the acceptance pill takes the slot
  });

  it('without the awaiting-acceptance flag the priority chip shows (no pill)', () => {
    render(
      <BoardCard
        card={card({ id: 't1', key: 4, kind: 'task', priority: 'high', awaitingAcceptance: false })}
        assigneeName={null}
        onOpenQuickView={() => {}}
      />,
    );
    expect(screen.queryByText('Awaiting acceptance')).toBeNull();
    expect(screen.getByText('High')).toBeTruthy();
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

// ── THE CI BADGE (Story MOTIR-5469 · MOTIR-5474) ──────────────────────────────
// Design: `design/boards/board-card--ci-badge.mock.html`, spec
// `design/boards/design-notes.md` § *The CI badge (MOTIR-5471)*.
//
// The badge is an ADDITIONAL pill in the card's existing pill row, immediately
// after the exclusive one — so it can never hide `Blocked` or `Awaiting
// acceptance`, which is the question the design card was asked to answer.
describe('BoardCard — the CI badge (MOTIR-5474)', () => {
  it('renders the text AND the glyph for failing and for running', () => {
    // State is carried by text and icon, never colour alone (finding #35), so
    // both halves are asserted rather than just the string.
    for (const [state, label] of [
      ['failing', 'Checks failing'],
      ['running', 'Checks running'],
    ] as const) {
      render(
        <BoardCard
          card={card({ id: `c-${state}`, key: 1, ciState: state })}
          assigneeName={null}
          onOpenQuickView={vi.fn()}
        />,
      );
      const badge = screen.getByText(label);
      expect(badge).toBeTruthy();
      // The glyph rides inside the same pill, and the two states use DIFFERENT
      // shapes — which is what lets the row's icon-only form stay legible.
      const pill = badge.closest('[data-ci-state]');
      expect(pill?.getAttribute('data-ci-state')).toBe(state);
      expect(pill?.querySelector('svg')).toBeTruthy();
      cleanup();
    }
  });

  it('renders NO badge for passing or for null', () => {
    // `passing` earns none because green CI is what moves a card to In Review —
    // a green badge would restate the column. `null` is "no checks", not a state.
    for (const ciState of ['passing', null] as const) {
      render(
        <BoardCard
          card={card({ id: 'c-none', key: 2, ciState })}
          assigneeName={null}
          onOpenQuickView={vi.fn()}
        />,
      );
      expect(screen.queryByText(/^Checks /)).toBeNull();
      expect(document.querySelector('[data-ci-state]')).toBeNull();
      cleanup();
    }
  });

  it('renders NOTHING on a done-category card, whatever the column says', () => {
    // The rule is the status CATEGORY, not the column: a board maps statuses to
    // columns many-to-one, and a done card's old red is not actionable. The value
    // stays STORED — it is simply not drawn.
    render(
      <BoardCard
        card={card({ id: 'c-done', key: 3, ciState: 'failing', statusCategory: 'done' })}
        assigneeName={null}
        onOpenQuickView={vi.fn()}
      />,
    );
    expect(screen.queryByText('Checks failing')).toBeNull();
  });

  it('renders the badge BESIDE Blocked — neither hides the other', () => {
    // The case the design card was asked about. `ready: false` is what swaps the
    // priority chip for `Blocked`; the badge is added rather than substituted, so
    // both survive.
    render(
      <BoardCard
        card={card({ id: 'c-blocked', key: 4, ciState: 'failing', ready: false })}
        assigneeName={null}
        onOpenQuickView={vi.fn()}
      />,
    );
    expect(screen.getByText('Blocked')).toBeTruthy();
    expect(screen.getByText('Checks failing')).toBeTruthy();
  });

  it('renders the badge BESIDE Awaiting acceptance — neither hides the other', () => {
    render(
      <BoardCard
        card={card({ id: 'c-await', key: 5, ciState: 'running', awaitingAcceptance: true })}
        assigneeName={null}
        onOpenQuickView={vi.fn()}
      />,
    );
    expect(screen.getByText('Awaiting acceptance')).toBeTruthy();
    expect(screen.getByText('Checks running')).toBeTruthy();
  });

  it('WRAPS its pill row, so a second pill cannot overflow the card', () => {
    // ⚠️ This is the change rendering found and reading did not: `BoardCard.tsx`
    // carried no `flex-wrap`, so at the board's 288px column a second pill pushed
    // the story-point chip and the avatar past the card's right edge. Asserted on
    // the class because a happy-dom render has no layout to measure.
    const { container } = render(
      <BoardCard
        card={card({ id: 'c-wrap', key: 6, ciState: 'running', awaitingAcceptance: true })}
        assigneeName={null}
        onOpenQuickView={vi.fn()}
      />,
    );
    const row = container.querySelector('[data-ci-state]')?.parentElement;
    expect(row?.className).toContain('flex-wrap');
  });

  it('pins the badge label against breaking inside the chip', () => {
    // The other rendering find: `Pill` sets no `whitespace-nowrap`, so "Checks
    // failing" broke onto two lines inside the chip with the glyph orphaned.
    render(
      <BoardCard
        card={card({ id: 'c-nowrap', key: 7, ciState: 'failing' })}
        assigneeName={null}
        onOpenQuickView={vi.fn()}
      />,
    );
    expect(document.querySelector('[data-ci-state]')?.className).toContain('whitespace-nowrap');
  });
});
