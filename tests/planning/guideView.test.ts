import { describe, expect, it } from 'vitest';
import { deriveGuideView, guideOutcomeLines } from '@/lib/planning/guideView';
import {
  guideFiledNote,
  guideRailBody,
  guideReplyBody,
  guideSkippedNote,
} from '@/lib/planning/guideReplyNotes';
import {
  GUIDE_SKIP_LINKED_PULL_REQUEST,
  temporaryAddedStepId,
  type GuideAction,
  type GuideActionOutcome,
  type GuideTurnRecord,
} from '@/lib/ai/guideWorkItem';
import type { PlanChangeTurnDto } from '@/lib/dto/planChange';
import type { WorkItemTodoDto } from '@/lib/dto/workItemTodos';

// The guide overlay's one derivation (Story MOTIR-7459 · MOTIR-7466): which list
// the canvas draws, which step is current, the reply row and the outcome lines.

let seq = 0;
function turn(
  role: PlanChangeTurnDto['role'],
  guide: GuideTurnRecord | null = null,
): PlanChangeTurnDto {
  seq += 1;
  return {
    id: `t${seq}`,
    seq,
    role,
    body: role === 'user' ? 'go on' : 'here',
    jobId: null,
    question: null,
    isAnswer: false,
    intent: 'guide',
    intentCorrected: false,
    citations: [],
    authorId: role === 'user' ? 'u1' : null,
    createdAt: '2026-10-03T10:00:00.000Z',
    guide,
  };
}

function record(
  pairs: Array<[GuideAction, GuideActionOutcome['outcome'], Partial<GuideActionOutcome>?]>,
  temporary = false,
): GuideTurnRecord {
  return {
    actions: pairs.map(([a]) => a),
    outcomes: pairs.map(([a, outcome, extra]) => ({ type: a.type, outcome, ...extra })),
    temporary,
  };
}

const step = (id: string, text: string) => ({
  id,
  text,
  notesMd: null,
  commandText: null,
  executor: null,
});

function todo(id: string, text: string, done = false): WorkItemTodoDto {
  return {
    id,
    text,
    notesMd: null,
    commandText: null,
    executor: null,
    position: id,
    done,
    doneAt: null,
    doneBy: null,
  } as WorkItemTodoDto;
}

const PROPOSAL = record([
  [
    { type: 'propose_todos', rows: [step('p1', 'Open settings'), step('p2', 'Paste key')] },
    'recorded',
  ],
]);

describe('deriveGuideView — which list', () => {
  it('is loading until the card rows are read', () => {
    const view = deriveGuideView([turn('assistant', PROPOSAL)], null, { idle: true });
    expect(view.kind).toBe('loading');
    expect(view.rows).toEqual([]);
    expect(view.tags).toEqual({});
  });

  it('is empty with no rows and nothing proposed', () => {
    expect(deriveGuideView([turn('assistant')], [], { idle: true }).kind).toBe('empty');
  });

  it('is PROPOSED while the latest turn is the proposal, with Save / Walk replies', () => {
    const view = deriveGuideView([turn('assistant', PROPOSAL)], [], { idle: true });
    expect(view.kind).toBe('proposed');
    expect(view.rows.map((r) => r.text)).toEqual(['Open settings', 'Paste key']);
    expect(view.currentId).toBeNull();
    expect(view.replies).toEqual(['save', 'walk']);
  });

  it('withholds the reply row while a turn runs, and once someone answered', () => {
    expect(deriveGuideView([turn('assistant', PROPOSAL)], [], { idle: false }).replies).toEqual([]);
    const answered = [turn('assistant', PROPOSAL), turn('user')];
    expect(deriveGuideView(answered, [], { idle: true }).replies).toEqual([]);
  });

  it('is TEMPORARY once a later turn walks the proposal, and tracks its ticks', () => {
    const turns = [
      turn('assistant', PROPOSAL),
      turn('user'),
      turn('assistant', record([[{ type: 'tick', rowId: 'p1' }, 'recorded']], true)),
    ];
    const view = deriveGuideView(turns, [], { idle: true });
    expect(view.kind).toBe('temporary');
    expect(view.done).toBe(1);
    expect(view.total).toBe(2);
    expect(view.currentId).toBe('p2');
    expect(view.currentStep).toBe(2);
  });

  it('is SAVED when the card has rows, and never mixes in the temporary list', () => {
    const view = deriveGuideView([turn('assistant', PROPOSAL)], [todo('r1', 'Real step')], {
      idle: true,
    });
    expect(view.kind).toBe('saved');
    expect(view.rows.map((r) => r.id)).toEqual(['r1']);
    // Save / Walk are the proposal's replies; a saved list never offers them.
    expect(view.replies).toEqual([]);
  });
});

describe('deriveGuideView — the current step', () => {
  const rows = [todo('r1', 'One'), todo('r2', 'Two'), todo('r3', 'Three')];

  it('follows the step the conversation named', () => {
    const turns = [turn('assistant', record([[{ type: 'current_step', rowId: 'r2' }, 'landed']]))];
    const view = deriveGuideView(turns, rows, { idle: true });
    expect(view.currentId).toBe('r2');
    expect(view.currentStep).toBe(2);
  });

  it('falls to the first undone step when the named one is done', () => {
    const turns = [turn('assistant', record([[{ type: 'current_step', rowId: 'r2' }, 'landed']]))];
    const ticked = [todo('r1', 'One'), todo('r2', 'Two', true), todo('r3', 'Three')];
    expect(deriveGuideView(turns, ticked, { idle: true }).currentId).toBe('r1');
  });

  it('has no current step when every step is done', () => {
    const all = rows.map((r) => ({ ...r, done: true }));
    const view = deriveGuideView([turn('assistant')], all, { idle: true });
    expect(view.currentId).toBeNull();
    expect(view.currentStep).toBeNull();
    expect(view.done).toBe(3);
  });
});

describe('deriveGuideView — the latest turn', () => {
  const rows = [todo('r1', 'One'), todo('r2', 'Two')];

  it('tags the rows the latest turn corrected, and offers Undo', () => {
    const turns = [
      turn(
        'assistant',
        record([
          [{ type: 'revise_step', rowId: 'r1', reason: 'clearer', text: 'Uno' }, 'landed'],
          [{ type: 'move_step', rowId: 'r2', afterRowId: null, reason: 'order' }, 'landed'],
          [
            { type: 'add_step', afterRowId: 'r2', reason: 'missing', ...step('x', 'Three') },
            'landed',
            { todoId: 'r3' },
          ],
        ]),
      ),
    ];
    const view = deriveGuideView(turns, [...rows, todo('r3', 'Three')], { idle: true });
    expect(view.tags).toEqual({ r1: 'changed', r2: 'moved', r3: 'added' });
    expect(view.replies).toContain('undo');
  });

  it('puts cannot on the current row, and skips a refused correction', () => {
    const turns = [
      turn(
        'assistant',
        record([
          [{ type: 'cannot_do', reason: 'needs a human' }, 'landed'],
          [{ type: 'remove_step', rowId: 'r2', reason: 'x' }, 'skipped'],
        ]),
      ),
    ];
    const view = deriveGuideView(turns, rows, { idle: true });
    expect(view.tags).toEqual({ r1: 'cannot' });
    expect(view.replies).not.toContain('undo');
  });

  it('tags an added temporary step by its derived id', () => {
    const turns = [
      turn('assistant', PROPOSAL),
      turn('user'),
      turn(
        'assistant',
        record(
          [
            [
              { type: 'add_step', afterRowId: 'p1', reason: 'missing', ...step('n', 'Between') },
              'recorded',
            ],
          ],
          true,
        ),
      ),
    ];
    const view = deriveGuideView(turns, [], { idle: true });
    const id = temporaryAddedStepId(turns[2]!.seq, 0);
    expect(view.rows.map((r) => r.id)).toEqual(['p1', id, 'p2']);
    expect(view.tags).toEqual({ [id]: 'added' });
  });

  it('reads the title the latest landed edit set, marked only on that turn', () => {
    const edit = turn(
      'assistant',
      record([
        [
          { type: 'edit_item', reason: 'r', title: 'New title', previous: { title: 'Old' } },
          'landed',
        ],
      ]),
    );
    const now = deriveGuideView([edit], rows, { idle: true });
    expect(now.editedTitle).toBe('New title');
    expect(now.titleEditedNow).toBe(true);
    expect(now.replies).toContain('undo');
    const later = deriveGuideView([edit, turn('user'), turn('assistant')], rows, { idle: true });
    expect(later.editedTitle).toBe('New title');
    expect(later.titleEditedNow).toBe(false);
  });

  it('is STALE and offers Reload when the latest edit was refused', () => {
    const turns = [
      turn(
        'assistant',
        record([
          [{ type: 'edit_item', reason: 'r', title: 'T', previous: { title: 'Old' } }, 'skipped'],
        ]),
      ),
    ];
    const view = deriveGuideView(turns, rows, { idle: true });
    expect(view.stale).toBe(true);
    expect(view.editedTitle).toBeNull();
    expect(view.replies).toEqual(['reload']);
  });

  it('offers Yes / No under an offer to close', () => {
    const turns = [turn('assistant', record([[{ type: 'offer_close' }, 'recorded']]))];
    expect(deriveGuideView(turns, rows, { idle: true }).replies).toEqual(['closeYes', 'closeNo']);
  });
});

describe('guideOutcomeLines', () => {
  const rows = deriveGuideView([], [todo('r1', 'One'), todo('r2', 'Two')], { idle: true }).rows;

  it('is empty without a record', () => {
    expect(guideOutcomeLines(null, rows, 1)).toEqual([]);
  });

  it('reads each landed act with its step number, never a skipped one', () => {
    const lines = guideOutcomeLines(
      record([
        [{ type: 'tick', rowId: 'r2' }, 'landed'],
        [{ type: 'untick', rowId: 'r1' }, 'landed'],
        [{ type: 'remove_step', rowId: 'gone', reason: 'x' }, 'landed'],
        [{ type: 'revise_step', rowId: 'r1', reason: 'x', text: 'y' }, 'skipped'],
        [{ type: 'cannot_do', reason: 'needs you' }, 'landed'],
        [{ type: 'close' }, 'landed'],
      ]),
      rows,
      4,
    );
    expect(lines).toEqual([
      { kind: 'ticked', step: 2, temporary: false, noStatus: false },
      { kind: 'unticked', step: 1, temporary: false },
      { kind: 'removed', step: null, temporary: false },
      { kind: 'commented', reason: 'needs you' },
      { kind: 'closed' },
    ]);
  });

  it('marks a temporary walk, a save and an edit', () => {
    const lines = guideOutcomeLines(
      record([
        [{ type: 'tick', rowId: 'r1' }, 'recorded'],
        [
          {
            type: 'write_todos',
            rows: [
              { ...step('a', 'A'), fromId: 'p1', done: true },
              { ...step('b', 'B'), fromId: 'p2', done: false },
            ],
          },
          'landed',
        ],
        [
          {
            type: 'edit_item',
            reason: 'r',
            title: 'T',
            descriptionMd: 'D',
            previous: { title: 'O', descriptionMd: 'P' },
          },
          'landed',
        ],
      ]),
      rows,
      2,
    );
    expect(lines).toEqual([
      { kind: 'ticked', step: 1, temporary: true, noStatus: false },
      { kind: 'saved', count: 2, done: 1 },
      { kind: 'edited', fields: ['title', 'description'] },
    ]);
  });

  it('says a tick moved no status when the close waits on a linked pull request', () => {
    const lines = guideOutcomeLines(
      record([
        [{ type: 'tick', rowId: 'r2' }, 'landed'],
        [{ type: 'close' }, 'skipped', { reason: GUIDE_SKIP_LINKED_PULL_REQUEST }],
      ]),
      rows,
      3,
    );
    expect(lines).toEqual([{ kind: 'ticked', step: 2, temporary: false, noStatus: true }]);
  });
});

// MOTIR-7811 (design MOTIR-7810): a `file_bug` draws a line from the record —
// the one action whose SKIPPED outcome can draw one.
describe('guideOutcomeLines — file_bug', () => {
  const rows = deriveGuideView([], [todo('r1', 'One'), todo('r2', 'Two')], { idle: true }).rows;
  const fileBug = (blocksGuidedCard = false): GuideAction => ({
    type: 'file_bug',
    title: 'The console 500s on save',
    descriptionMd: 'Steps.',
    explanationMd: null,
    blocksGuidedCard,
  });

  it('a landed filing is `filed`, carrying the NEW key', () => {
    expect(
      guideOutcomeLines(record([[fileBug(), 'landed', { workItemKey: 'PAY-231' }]]), rows, 2),
    ).toEqual([{ kind: 'filed', bugKey: 'PAY-231' }]);
  });

  it('a landed filing that blocks the guided card is `filedBlocking`', () => {
    expect(
      guideOutcomeLines(record([[fileBug(true), 'landed', { workItemKey: 'PAY-231' }]]), rows, 2),
    ).toEqual([{ kind: 'filedBlocking', bugKey: 'PAY-231' }]);
  });

  it('a duplicate (skipped WITH a key) is `alreadyFiled`, naming the existing bug', () => {
    expect(
      guideOutcomeLines(
        record([
          [fileBug(), 'skipped', { workItemKey: 'PAY-198', reason: 'already filed as PAY-198' }],
        ]),
        rows,
        2,
      ),
    ).toEqual([{ kind: 'alreadyFiled', bugKey: 'PAY-198' }]);
  });

  it('a refusal with NO key (the cap, one per turn) draws no line', () => {
    expect(
      guideOutcomeLines(
        record([[fileBug(), 'skipped', { reason: 'a guide turn files at most one bug' }]]),
        rows,
        2,
      ),
    ).toEqual([]);
  });

  it('keeps ACTION order beside ordinary acts — [tick, file_bug]', () => {
    expect(
      guideOutcomeLines(
        record([
          [{ type: 'tick', rowId: 'r1' }, 'landed'],
          [fileBug(), 'landed', { workItemKey: 'PAY-231' }],
        ]),
        rows,
        3,
      ),
    ).toEqual([
      { kind: 'ticked', step: 1, temporary: false, noStatus: false },
      { kind: 'filed', bugKey: 'PAY-231' },
    ]);
  });

  it('keeps ACTION order beside a stop — [file_bug, cannot_do]', () => {
    expect(
      guideOutcomeLines(
        record([
          [fileBug(), 'landed', { workItemKey: 'PAY-231' }],
          [{ type: 'cannot_do', reason: 'needs the console' }, 'landed'],
        ]),
        rows,
        3,
      ),
    ).toEqual([
      { kind: 'filed', bugKey: 'PAY-231' },
      { kind: 'commented', reason: 'needs the console' },
    ]);
  });
});

// Decision (a): the landing keeps writing the notes; the rail strips EXACTLY what
// it appended, recomputed from the record.
describe('guideRailBody', () => {
  const fileBug: GuideAction = {
    type: 'file_bug',
    title: 'The console 500s on save',
    descriptionMd: 'Steps.',
    explanationMd: null,
    blocksGuidedCard: false,
  };
  const stored = (r: GuideTurnRecord, message = 'I filed it.') =>
    guideReplyBody(message, r.actions, r.outcomes);

  it('the stored body is the message then the notes, as the landing wrote it', () => {
    const r = record([[fileBug, 'landed', { workItemKey: 'PAY-231' }]]);
    expect(guideFiledNote(r.actions, r.outcomes)).toBe(
      'Filed a bug:\n- PAY-231: The console 500s on save',
    );
    expect(stored(r)).toBe('I filed it.\n\nFiled a bug:\n- PAY-231: The console 500s on save');
  });

  it('drops the filed note on the rail', () => {
    const r = record([[fileBug, 'landed', { workItemKey: 'PAY-231' }]]);
    expect(guideRailBody(stored(r), r)).toBe('I filed it.');
  });

  it('drops a duplicate’s bullet, and the whole note when it was the only one', () => {
    const r = record([
      [fileBug, 'skipped', { workItemKey: 'PAY-198', reason: 'already filed as PAY-198' }],
    ]);
    expect(stored(r)).toContain('- file bug: already filed as PAY-198');
    expect(guideRailBody(stored(r), r)).toBe('I filed it.');
  });

  it('keeps a keyless refusal in the did-not-land note, and every other skipped act', () => {
    const r = record([
      [fileBug, 'landed', { workItemKey: 'PAY-231' }],
      [fileBug, 'skipped', { reason: 'a guide turn files at most one bug' }],
      [{ type: 'tick', rowId: 'x' }, 'skipped', { reason: 'not on this card' }],
    ]);
    expect(guideRailBody(stored(r), r)).toBe(
      [
        'I filed it.',
        guideSkippedNote([
          { type: 'file_bug', outcome: 'skipped', reason: 'a guide turn files at most one bug' },
          { type: 'tick', outcome: 'skipped', reason: 'not on this card' },
        ]),
      ].join('\n\n'),
    );
    expect(guideRailBody(stored(r), r)).not.toContain('PAY-231');
  });

  it('renders a turn with no file_bug exactly as stored', () => {
    const r = record([[{ type: 'tick', rowId: 'x' }, 'skipped', { reason: 'nope' }]]);
    expect(guideRailBody(stored(r), r)).toBe(stored(r));
    expect(guideRailBody('plain', null)).toBe('plain');
  });

  it('leaves a body that does not end with the recomputed suffix untouched', () => {
    const r = record([[fileBug, 'landed', { workItemKey: 'PAY-231' }]]);
    expect(guideRailBody('Edited by hand.', r)).toBe('Edited by hand.');
  });
});
