// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { GuideRail } from '@/components/planning/GuideRail';
import { deriveGuideView } from '@/lib/planning/guideView';
import { guideReplyBody } from '@/lib/planning/guideReplyNotes';
import type { GuideAction, GuideActionOutcome, GuideTurnRecord } from '@/lib/ai/guideWorkItem';
import type { PlanChangeSessionDto, PlanChangeTurnDto } from '@/lib/dto/planChange';
import type { WorkItemRefMap, WorkItemRefSummaryDto } from '@/lib/dto/workItems';
import type { WorkItemTodoDto } from '@/lib/dto/workItemTodos';

// A FILED BUG in the guide rail's outcome foot (Story MOTIR-7797 · MOTIR-7811;
// design MOTIR-7810 `planning-workspace--guide-file-bug.mock.html`, panels 1–7).
// The line names the NEW bug through a real `WorkItemRefChip` resolved from the
// session's `workItemRefs`, and the bubble does not name it a second time.

let seq = 0;
function turn(guide: GuideTurnRecord | null, body: string): PlanChangeTurnDto {
  seq += 1;
  return {
    id: `t${seq}`,
    seq,
    role: 'assistant',
    body,
    jobId: null,
    question: null,
    isAnswer: false,
    intent: 'guide',
    intentCorrected: false,
    citations: [],
    authorId: null,
    createdAt: '2026-10-08T10:00:00.000Z',
    guide,
  };
}

function record(
  pairs: Array<[GuideAction, GuideActionOutcome['outcome'], Partial<GuideActionOutcome>?]>,
): GuideTurnRecord {
  return {
    actions: pairs.map(([a]) => a),
    outcomes: pairs.map(([a, outcome, extra]) => ({ type: a.type, outcome, ...extra })),
    temporary: false,
  };
}

/** The assistant turn exactly as the landing stores it: message, then notes. */
function landed(r: GuideTurnRecord, message = 'That is a defect in the console. I filed it.') {
  return turn(r, guideReplyBody(message, r.actions, r.outcomes));
}

const fileBug = (blocksGuidedCard = false): GuideAction => ({
  type: 'file_bug',
  title: 'Saving a rotated signing secret returns HTTP 500',
  descriptionMd: 'Steps.',
  explanationMd: null,
  blocksGuidedCard,
});

function summary(identifier: string, title: string): WorkItemRefSummaryDto {
  return {
    accessible: true,
    id: `id-${identifier}`,
    identifier,
    title,
    kind: 'bug',
    archived: false,
    status: { key: 'todo', label: 'To Do', category: 'todo' },
  } as WorkItemRefSummaryDto;
}

const BUG = summary('PAY-231', 'Saving a rotated signing secret returns HTTP 500');
const DUP = summary('PAY-198', 'The console 500s on save');
const CARD = { id: 'w9', identifier: 'PAY-212', title: 'Rotate the key', kind: 'task' as const };
const ROWS = [{ id: 'r1', text: 'One', position: 'a', done: false }] as WorkItemTodoDto[];

function renderRail(turns: PlanChangeTurnDto[], workItemRefs: WorkItemRefMap = {}) {
  renderWithIntl(
    <GuideRail
      card={CARD}
      session={
        {
          id: 's1',
          projectId: 'p',
          targetKeys: [CARD.identifier],
          turnCount: turns.length,
          lastJobId: null,
          lastSubmittedAt: null,
          lastActivityAt: '2026-10-08T10:00:00.000Z',
          origin: 'guide',
          createdAt: '2026-10-08T10:00:00.000Z',
          updatedAt: '2026-10-08T10:00:00.000Z',
          turns,
          workItemRefs,
        } as PlanChangeSessionDto
      }
      view={deriveGuideView(turns, ROWS, { idle: true })}
      phase="idle"
      errorCode={null}
      outOfCredits={false}
      markers={[]}
      onSend={vi.fn()}
      onRetry={vi.fn()}
      onReload={vi.fn()}
    />,
  );
}

const outcomeLines = () => screen.getAllByTestId('guide-outcome');
const keysIn = (el: HTMLElement) =>
  Array.from(el.querySelectorAll('.wi-chip .wi-key')).map((k) => k.textContent);
const glyphOf = (el: HTMLElement) => el.querySelector('svg')!.getAttribute('class') ?? '';

beforeEach(() => {
  seq = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the filed-bug line (design panels 1–3)', () => {
  it('filed: one line naming the NEW bug through its chip, in the bug hue', () => {
    renderRail([landed(record([[fileBug(), 'landed', { workItemKey: 'PAY-231' }]]))], {
      'PAY-231': BUG,
    });
    const [line] = outcomeLines();
    expect(line!.getAttribute('data-outcome')).toBe('filed');
    expect(keysIn(line!)).toEqual(['PAY-231']);
    // The chip carries the live title; the sentence does not repeat it.
    expect(line!.textContent).toBe(
      'Filed PAY-231Saving a rotated signing secret returns HTTP 500.',
    );
    expect(glyphOf(line!)).toContain('text-(--el-type-bug)');
    expect(glyphOf(line!)).toContain('lucide-bug');
  });

  it('filedBlocking: the bug, then the guided card, held until it is fixed', () => {
    renderRail([landed(record([[fileBug(true), 'landed', { workItemKey: 'PAY-231' }]]))], {
      'PAY-231': BUG,
    });
    const [line] = outcomeLines();
    expect(line!.getAttribute('data-outcome')).toBe('filedBlocking');
    expect(keysIn(line!)).toEqual(['PAY-231', 'PAY-212']);
    expect(line!.textContent).toContain('is blocked until it is fixed.');
    expect(glyphOf(line!)).toContain('text-(--el-type-bug)');
  });

  it('alreadyFiled: cites the existing bug, in the secondary ink', () => {
    renderRail(
      [
        landed(
          record([
            [fileBug(), 'skipped', { workItemKey: 'PAY-198', reason: 'already filed as PAY-198' }],
          ]),
          'That one is already tracked.',
        ),
      ],
      { 'PAY-198': DUP },
    );
    const [line] = outcomeLines();
    expect(line!.getAttribute('data-outcome')).toBe('alreadyFiled');
    expect(keysIn(line!)).toEqual(['PAY-198']);
    expect(line!.textContent).toContain('so nothing new was filed.');
    expect(glyphOf(line!)).toContain('text-(--el-text-secondary)');
    // Its bullet leaves the did-not-land note on the rail: the line carries it.
    expect(screen.getByTestId('guide-turn').textContent).not.toContain('did not land');
  });

  it('never says where the bug was placed', () => {
    renderRail([landed(record([[fileBug(true), 'landed', { workItemKey: 'PAY-231' }]]))], {
      'PAY-231': BUG,
    });
    expect(outcomeLines()[0]!.textContent).not.toMatch(/Bugs|folder|under/);
  });
});

describe('the bubble names a filed bug ONCE (decision (a))', () => {
  it('leaves the stored filed note out of the rendered body', () => {
    renderRail([landed(record([[fileBug(), 'landed', { workItemKey: 'PAY-231' }]]))], {
      'PAY-231': BUG,
    });
    const bubble = screen.getByTestId('guide-turn');
    expect(bubble.textContent).toContain('That is a defect in the console. I filed it.');
    expect(bubble.textContent).not.toContain('Filed a bug:');
    expect(within(bubble).getAllByText('PAY-231')).toHaveLength(1);
  });

  it('a refusal with no key draws no line and stays in the did-not-land note (panel 4)', () => {
    renderRail([
      landed(
        record([
          [fileBug(), 'landed', { workItemKey: 'PAY-231' }],
          [fileBug(), 'skipped', { reason: 'a guide turn files at most one bug' }],
        ]),
      ),
    ]);
    expect(outcomeLines().map((l) => l.getAttribute('data-outcome'))).toEqual(['filed']);
    const bubble = screen.getByTestId('guide-turn');
    expect(bubble.textContent).toContain('Some of that did not land:');
    expect(bubble.textContent).toContain('file bug: a guide turn files at most one bug');
    expect(bubble.textContent).not.toContain('Filed a bug:');
  });
});

describe('order and the top rule (panels 5–6)', () => {
  const ruled = (el: HTMLElement) => el.className.includes('border-t');

  it('[tick, file_bug]: action order, only the first carries the rule', () => {
    renderRail(
      [
        landed(
          record([
            [{ type: 'tick', rowId: 'r1' }, 'landed'],
            [fileBug(), 'landed', { workItemKey: 'PAY-231' }],
          ]),
        ),
      ],
      { 'PAY-231': BUG },
    );
    const lines = outcomeLines();
    expect(lines.map((l) => l.getAttribute('data-outcome'))).toEqual(['ticked', 'filed']);
    expect(lines.map(ruled)).toEqual([true, false]);
  });

  it('[file_bug, cannot_do]: the filed line above the commented line', () => {
    renderRail(
      [
        landed(
          record([
            [fileBug(), 'landed', { workItemKey: 'PAY-231' }],
            [{ type: 'cannot_do', reason: 'needs the console' }, 'landed'],
          ]),
        ),
      ],
      { 'PAY-231': BUG },
    );
    const lines = outcomeLines();
    expect(lines.map((l) => l.getAttribute('data-outcome'))).toEqual(['filed', 'commented']);
    expect(lines.map(ruled)).toEqual([true, false]);
  });
});

describe('a bug the reader cannot resolve (panel 7)', () => {
  it('an inaccessible summary renders the bare key, no title', () => {
    renderRail([landed(record([[fileBug(), 'landed', { workItemKey: 'PAY-231' }]]))], {
      'PAY-231': { accessible: false, id: 'id-PAY-231' } as WorkItemRefSummaryDto,
    });
    const [line] = outcomeLines();
    const chip = line!.querySelector('.wi-chip.is-noaccess')!;
    expect(chip.textContent).toBe('PAY-231');
    expect(line!.textContent).not.toContain('HTTP 500');
  });

  it('a summary absent from workItemRefs renders the bare key and nothing throws', () => {
    renderRail([landed(record([[fileBug(), 'landed', { workItemKey: 'PAY-231' }]]))]);
    const [line] = outcomeLines();
    expect(line!.querySelector('.wi-chip.is-deleted')!.textContent).toBe('PAY-231');
  });
});
