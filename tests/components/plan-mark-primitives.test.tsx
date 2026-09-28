// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { PlanItemChangeDto, PlanProposalPeekDto, PlanRefChipDto } from '@/lib/dto/planReview';
import { changeCellText } from '@/components/planning/changeCellText';
import {
  LIST_CHIP_MAX,
  SupersedesChip,
  SupersedesChips,
  supersedesWords,
} from '@/components/planning/SupersedesChip';
import {
  ProposalMarkRows,
  ProposalSupersedesRows,
} from '@/components/planning/ProposalMarkRailRows';
import { ObsolescencePill } from '@/components/issues/ObsolescencePill';

// Story MOTIR-6577 · MOTIR-6633 — the coverage floor over the review's new mark
// PRIMITIVES, pinned per file in `vitest.config.ts`. The surfaces that compose
// them (the canvas card, the list row, the peek) are driven end to end by
// `plan-review-obsolescence.test.tsx`; this file reaches the arms those surfaces
// never produce from a real review model: an unknown kind, a committed chip with
// no key, a proposal with no plan item, an older server's row without chips, a
// cleared note, an `add` with no refs, and the change-cell words of each field.

afterEach(cleanup);

const committed = (identifier: string | null, title: string, kind = 'task'): PlanRefChipDto => ({
  identifier,
  title,
  kind,
  proposed: false,
});
const proposal = (title: string, planItemId?: string): PlanRefChipDto => ({
  identifier: null,
  title,
  kind: 'story',
  proposed: true,
  ...(planItemId ? { planItemId } : {}),
});

/** A peek envelope carrying only what the rail rows read. */
const peek = (over: Partial<PlanProposalPeekDto>): PlanProposalPeekDto =>
  ({ op: 'modify', markChanges: [], ...over }) as PlanProposalPeekDto;

describe('SupersedesChip', () => {
  it('draws an unknown kind as a task, a keyless committed chip with an empty key, unsigned', () => {
    render(<SupersedesChip chip={committed(null, 'Legacy card', 'initiative')} />);
    const chip = screen.getByTestId('supersedes-chip');
    expect(chip.getAttribute('data-ref')).toBe('committed');
    expect(chip.getAttribute('data-delta')).toBeNull();
    expect(chip.textContent).toContain('Legacy card');
    expect(screen.queryByTestId('supersedes-chip-open')).toBeNull();
  });

  it('a proposal with no plan item is not openable even when a handler is given', () => {
    const open = vi.fn();
    render(<SupersedesChip chip={proposal('Orphan proposal')} delta="+" onOpenProposal={open} />);
    expect(screen.queryByTestId('supersedes-chip-open')).toBeNull();
    expect(screen.getByTestId('supersedes-chip').textContent).toContain('New');
  });

  it('a proposal with a plan item opens its peek; a removal is announced and struck', () => {
    const open = vi.fn();
    render(
      <SupersedesChip chip={proposal('The new card', 'pi_7')} delta="−" onOpenProposal={open} />,
    );
    expect(screen.getByText('Removes', { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByTestId('supersedes-chip-open'));
    expect(open).toHaveBeenCalledWith('pi_7');
  });
});

describe('SupersedesChips', () => {
  const many = Array.from({ length: LIST_CHIP_MAX + 2 }, (_, i) =>
    committed(`PROD-${i + 1}`, `Card ${i + 1}`),
  );

  it('wrap caps the row and says how many more; column shows every chip', () => {
    render(<SupersedesChips added={many} signed={false} layout="wrap" />);
    expect(screen.getAllByTestId('supersedes-chip')).toHaveLength(LIST_CHIP_MAX);
    expect(screen.getByText('+2 more')).toBeTruthy();
    cleanup();
    render(<SupersedesChips added={many} removed={[many[0]!]} signed layout="column" />);
    const chips = screen.getAllByTestId('supersedes-chip');
    expect(chips).toHaveLength(LIST_CHIP_MAX + 3);
    expect(chips.map((c) => c.getAttribute('data-delta'))).toEqual([
      ...Array(LIST_CHIP_MAX + 2).fill('+'),
      '−',
    ]);
    expect(screen.queryByText(/more$/)).toBeNull();
  });
});

describe('supersedesWords', () => {
  const row = (refs?: PlanItemChangeDto['refs']): PlanItemChangeDto => ({
    field: 'supersedes',
    from: null,
    to: 'server words',
    ...(refs ? { refs } : {}),
  });

  it('falls back to the server’s words with no chips, or with two empty lists', () => {
    expect(supersedesWords(row(), 'New')).toBe('server words');
    expect(supersedesWords(row({ added: [], removed: [] }), 'New')).toBe('server words');
  });

  it('names a proposal by the proposed word and its title, a keyless committed card by its title', () => {
    expect(
      supersedesWords(
        row({
          added: [proposal('The new card', 'pi_1'), committed('PROD-2', 'Two')],
          removed: [committed(null, 'Keyless')],
        }),
        'New',
      ),
    ).toBe('+New · The new card · +PROD-2 · −Keyless');
  });
});

describe('ProposalMarkRows / ProposalSupersedesRows — the arms the peek does not reach', () => {
  it('a CLEARED mark reads `Current`, a cleared note reads `—`, and no holds-status line', () => {
    render(
      <ProposalMarkRows
        proposal={peek({
          markChanges: [
            { field: 'obsolescence', from: 'outdated', to: 'current' },
            { field: 'obsolescenceNote', from: null, to: null },
          ],
        })}
        statusCategory="done"
        statusLabel="Done"
        outcome={null}
      />,
    );
    expect(screen.getByText('Current')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByTestId('mark-holds-status')).toBeNull();
  });

  it('a SET mark on a done card says what it holds; a long note clamps behind Show all', () => {
    const long = Array.from({ length: 5 }, (_, i) => `Line ${i + 1}.`).join('\n');
    render(
      <ProposalMarkRows
        proposal={peek({
          markChanges: [
            { field: 'obsolescence', from: 'current', to: 'outdated' },
            { field: 'obsolescenceNote', from: null, to: long },
          ],
        })}
        statusCategory="done"
        statusLabel="Done"
        outcome={null}
      />,
    );
    expect(screen.getByTestId('mark-holds-status').textContent).toContain('Done');
    expect(screen.getByTestId('mark-note').className).toContain('line-clamp-3');
    const toggle = screen.getByRole('button', { name: 'Show all' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByTestId('mark-note').className).not.toContain('line-clamp-3');
    expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('a short note renders whole; no mark row when the plan moves only the note', () => {
    render(
      <ProposalMarkRows
        proposal={peek({ markChanges: [{ field: 'obsolescenceNote', from: null, to: 'Why.' }] })}
        statusCategory="done"
        statusLabel="Done"
        outcome={null}
      />,
    );
    expect(screen.getByTestId('mark-note').textContent).toBe('Why.');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByTestId('mark-holds-status')).toBeNull();
  });

  it('an `add`’s refs are one unsigned row; a modify’s rows are signed, and a chip opens its peek', () => {
    const open = vi.fn();
    render(
      <ProposalSupersedesRows
        proposal={peek({ op: 'add', supersedesRefs: [committed('PROD-3', 'Three')] })}
      />,
    );
    expect(screen.getByTestId('supersedes-chip').getAttribute('data-delta')).toBeNull();
    cleanup();
    render(
      <ProposalSupersedesRows
        proposal={peek({
          markChanges: [
            {
              field: 'supersededBy',
              from: null,
              to: '+New',
              refs: { added: [proposal('The new card', 'pi_9')], removed: [] },
            },
          ],
        })}
        onOpenProposal={open}
      />,
    );
    expect(screen.getByTestId('supersedes-chip').getAttribute('data-delta')).toBe('+');
    fireEvent.click(screen.getByTestId('supersedes-chip-open'));
    expect(open).toHaveBeenCalledWith('pi_9');
  });

  it('an `add` with no supersedes refs draws no row', () => {
    const { container } = render(
      <ProposalSupersedesRows proposal={peek({ op: 'add', supersedesRefs: [] })} />,
    );
    expect(container.textContent).toBe('');
    cleanup();
    const { container: absent } = render(<ProposalSupersedesRows proposal={peek({ op: 'add' })} />);
    expect(absent.textContent).toBe('');
  });

  it('a modify row without chips (an older server) draws nothing for that direction', () => {
    const { container } = render(
      <ProposalSupersedesRows
        proposal={peek({
          markChanges: [{ field: 'supersedes', from: null, to: '+PROD-1' }],
        })}
      />,
    );
    expect(container.textContent).toBe('');
  });
});

describe('changeCellText', () => {
  const tLabels = (key: string) => `label:${key}`;

  it('null stays null for every field', () => {
    for (const field of ['difficulty', 'obsolescence', 'obsolescenceNote', 'title']) {
      expect(changeCellText(field, null, tLabels)).toBeNull();
    }
  });

  it('a difficulty member renders its label; an off-scale value passes through', () => {
    expect(changeCellText('difficulty', 'high', tLabels)).toBe('label:difficulty.high');
    expect(changeCellText('difficulty', 'enormous', tLabels)).toBe('enormous');
  });

  it('a mark renders its label; `current` renders the given word, or the wire word without one', () => {
    expect(changeCellText('obsolescence', 'outdated', tLabels)).toBe('label:obsolescence.outdated');
    expect(changeCellText('obsolescence', 'deprecated', tLabels)).toBe(
      'label:obsolescence.deprecated',
    );
    expect(changeCellText('obsolescence', 'current', tLabels, 'Current')).toBe('Current');
    expect(changeCellText('obsolescence', 'current', tLabels)).toBe('current');
  });

  it('a note renders its first line; any other field is returned unchanged', () => {
    expect(changeCellText('obsolescenceNote', '\nFirst.\nSecond.', tLabels)).toBe('First.');
    expect(changeCellText('title', 'A title', tLabels)).toBe('A title');
  });
});

describe('ObsolescencePill', () => {
  it('renders each mark with its hidden lead word when given one', () => {
    render(<ObsolescencePill mark="deprecated" srPrefix="Proposed mark" />);
    const pill = document.querySelector('[data-obsolescence="deprecated"]');
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toContain('Proposed mark');
    cleanup();
    render(<ObsolescencePill mark="outdated" size="node" className="ml-1" testId="p" />);
    const node = screen.getByTestId('p');
    expect(node.getAttribute('data-obsolescence')).toBe('outdated');
    expect(node.className).toContain('ml-1');
    expect(node.textContent).not.toContain('Proposed mark');
  });
});
