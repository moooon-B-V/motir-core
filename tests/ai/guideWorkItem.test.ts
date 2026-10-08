import { describe, expect, it } from 'vitest';

import {
  GUIDE_ACTION_TYPES,
  GUIDE_CONTEXT_TURNS_MAX,
  InvalidGuideTurnError,
  buildGuideContext,
  deriveTemporaryList,
  parseGuideTurn,
  readGuideTurnRecord,
  temporaryAddedStepId,
  type GuideActionType,
  type GuideTurnRecord,
} from '@/lib/ai/guideWorkItem';

// The guide turn's WIRE (Story MOTIR-7459 · MOTIR-7464), pure: what core sends a
// `guide_work_item` job and what it accepts back, against
// `docs/decisions/conversation-turn-intent.md` AMENDMENT 2, A2.3.

const card = {
  identifier: 'MOTIR-9',
  title: 'Rotate the signing key',
  type: 'manual',
  executor: 'human',
  statusKey: 'todo',
  descriptionMd: null,
  explanationMd: 'Why.',
  pullRequests: [{ url: 'https://github.com/acme/web/pull/7', state: 'open' }],
};
const row = (id: string, done = false) => ({
  id,
  text: `Step ${id}`,
  notesMd: null,
  commandText: id === 'r1' ? 'motir keys rotate' : null,
  executor: id === 'r2' ? 'coding_agent' : 'human',
  done,
});

describe('buildGuideContext', () => {
  it('carries the card, its rows IN THE ORDER GIVEN, and the turns', () => {
    const ctx = buildGuideContext(
      card,
      [row('r2'), row('r1', true)],
      [
        { role: 'user', body: 'Guide me through MOTIR-9.' },
        { role: 'assistant', body: 'First step.' },
      ],
    );
    expect(ctx.card).toEqual({
      key: 'MOTIR-9',
      title: 'Rotate the signing key',
      type: 'manual',
      executor: 'human',
      status: 'todo',
      descriptionMd: '',
      explanationMd: 'Why.',
      pullRequests: [{ url: 'https://github.com/acme/web/pull/7', state: 'open' }],
      // Absent on the input reads as none (MOTIR-7800).
      openBugs: [],
    });
    expect(ctx.todos.temporary).toBe(false);
    expect(ctx.todos.rows.map((r) => [r.id, r.done, r.executor])).toEqual([
      ['r2', false, 'coding_agent'],
      ['r1', true, 'human'],
    ]);
    expect(ctx.todos.rows[1]!.commandText).toBe('motir keys rotate');
    expect(ctx.turns).toEqual([
      { role: 'user', body: 'Guide me through MOTIR-9.' },
      { role: 'assistant', body: 'First step.' },
    ]);
  });

  it('carries the CURRENT turn’s files beside the turns, and an earlier turn’s notes on it', () => {
    const files = [
      {
        attachmentId: 'a1',
        name: 'shot.png',
        mime: 'image/png',
        kind: 'image' as const,
        dataUrl: 'data:image/png;base64,AAAA',
      },
    ];
    const ctx = buildGuideContext(
      card,
      [],
      [
        { role: 'user', body: 'see log', files: [{ name: 'run.log', kind: 'text' }] },
        { role: 'assistant', body: 'Read it.', files: [{ name: 'ignored', kind: 'text' }] },
        { role: 'user', body: '', files: [] },
      ],
      { files },
    );
    expect(ctx.files).toEqual(files);
    expect(ctx.turns[0]).toEqual({
      role: 'user',
      body: 'see log',
      files: [{ name: 'run.log', kind: 'text' }],
    });
    // Notes ride `user` turns only, and an empty list rides as nothing.
    expect(ctx.turns[1]).not.toHaveProperty('files');
    expect(ctx.turns[2]).not.toHaveProperty('files');
    expect(buildGuideContext(card, [], [], { files: [] })).not.toHaveProperty('files');
  });

  it('carries the card’s open related bugs by key, title and status (MOTIR-7800)', () => {
    const ctx = buildGuideContext(
      {
        ...card,
        openBugs: [{ key: 'MOTIR-12', title: 'The console 500s on save', status: 'todo' }],
      },
      [],
      [],
    );
    expect(ctx.card.openBugs).toEqual([
      { key: 'MOTIR-12', title: 'The console 500s on save', status: 'todo' },
    ]);
  });

  it('marks a temporary list only when it has rows, and drops an unknown executor', () => {
    expect(buildGuideContext(card, [], [], { temporary: true }).todos.temporary).toBe(false);
    const ctx = buildGuideContext(card, [{ ...row('t1'), executor: 'robot' }], [], {
      temporary: true,
    });
    expect(ctx.todos.temporary).toBe(true);
    expect(ctx.todos.rows[0]!.executor).toBeNull();
  });

  it('keeps only the latest turns, and an assistant turn’s actions', () => {
    const turns = Array.from({ length: GUIDE_CONTEXT_TURNS_MAX + 5 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      body: `t${i}`,
      actions: [{ type: 'tick', rowId: 'r1' }],
    }));
    const ctx = buildGuideContext(card, [], turns);
    expect(ctx.turns).toHaveLength(GUIDE_CONTEXT_TURNS_MAX);
    expect(ctx.turns.at(-1)!.body).toBe(`t${GUIDE_CONTEXT_TURNS_MAX + 4}`);
    for (const t of ctx.turns) {
      if (t.role === 'user') expect(t).not.toHaveProperty('actions');
      else expect(t.actions).toEqual([{ type: 'tick', rowId: 'r1' }]);
    }
  });
});

/** One VALID instance of every action in the closed set. */
const VALID: Record<GuideActionType, Record<string, unknown>> = {
  propose_todos: {
    type: 'propose_todos',
    rows: [{ id: 'tmp-1', text: 'Open the console', notesMd: null, commandText: null }],
  },
  write_todos: {
    type: 'write_todos',
    rows: [{ fromId: 'tmp-1', text: 'Open the console', done: true, executor: 'human' }],
  },
  tick: { type: 'tick', rowId: 'r1' },
  untick: { type: 'untick', rowId: 'r1' },
  add_step: { type: 'add_step', afterRowId: null, reason: 'Missing', text: 'Log in first' },
  revise_step: { type: 'revise_step', rowId: 'r2', reason: 'Typo', commandText: 'ls -la' },
  remove_step: { type: 'remove_step', rowId: 'r2', reason: 'Not needed' },
  move_step: { type: 'move_step', rowId: 'r2', afterRowId: 'r3', reason: 'Order' },
  current_step: { type: 'current_step', rowId: 'r2' },
  offer_close: { type: 'offer_close' },
  close: { type: 'close' },
  edit_item: {
    type: 'edit_item',
    reason: 'The scope changed',
    title: 'Rotate both keys',
    previous: { title: 'Rotate the signing key' },
  },
  cannot_do: { type: 'cannot_do', reason: 'Needs an admin you do not have' },
  // A3.9 (`guide-turn-files.md`): the two actions the amendment adds.
  local_agent_prompt: {
    type: 'local_agent_prompt',
    rowId: 'r2',
    prompt: '  Rotate the signing key with the CLI. Read the key from your keychain.  ',
  },
  needs_replan: { type: 'needs_replan', reason: 'A different provider is a different card' },
  // MOTIR-7800 (decision MOTIR-7798 Q3): a confirmed defect, filed as the person.
  file_bug: {
    type: 'file_bug',
    title: '  The console 500s when the key is saved  ',
    descriptionMd: 'Saving a rotated key returns HTTP 500.',
    explanationMd: 'The save handler reads the old key id.',
    blocksGuidedCard: true,
  },
};

describe('parseGuideTurn', () => {
  it('is TOTAL over the closed action set — every member parses', () => {
    expect(Object.keys(VALID).sort()).toEqual([...GUIDE_ACTION_TYPES].sort());
    const turn = parseGuideTurn({
      messageMd: '  Step one.  ',
      actions: GUIDE_ACTION_TYPES.map((t) => VALID[t]),
      dropped: [{ type: 'tick', reason: 'not consented' }, 'junk'],
    });
    expect(turn.messageMd).toBe('Step one.');
    expect(turn.actions.map((a) => a.type)).toEqual([...GUIDE_ACTION_TYPES]);
    expect(turn.dropped).toEqual([{ type: 'tick', reason: 'not consented' }]);
  });

  it('normalises the fields it reads', () => {
    const turn = parseGuideTurn({
      messageMd: 'ok',
      actions: [VALID.write_todos, VALID.revise_step, VALID.edit_item, VALID.add_step],
    });
    expect(turn.actions[0]).toEqual({
      type: 'write_todos',
      rows: [
        {
          fromId: 'tmp-1',
          done: true,
          text: 'Open the console',
          notesMd: null,
          commandText: null,
          executor: 'human',
        },
      ],
    });
    expect(turn.actions[1]).toEqual({
      type: 'revise_step',
      rowId: 'r2',
      reason: 'Typo',
      commandText: 'ls -la',
    });
    expect(turn.actions[2]).toMatchObject({
      type: 'edit_item',
      title: 'Rotate both keys',
      previous: { title: 'Rotate the signing key' },
    });
    expect(turn.actions[3]).toMatchObject({ type: 'add_step', afterRowId: null, executor: null });
  });

  it('reads the A3.9 actions: a trimmed local-agent prompt, and a re-plan reason', () => {
    const turn = parseGuideTurn({
      messageMd: 'ok',
      actions: [VALID.local_agent_prompt, VALID.needs_replan],
    });
    expect(turn.actions).toEqual([
      {
        type: 'local_agent_prompt',
        rowId: 'r2',
        prompt: 'Rotate the signing key with the CLI. Read the key from your keychain.',
      },
      { type: 'needs_replan', reason: 'A different provider is a different card' },
    ]);
  });

  it('reads a file_bug: a trimmed one-line title, and `blocksGuidedCard` / `explanationMd` defaulted when absent', () => {
    const turn = parseGuideTurn({
      messageMd: 'ok',
      actions: [
        VALID.file_bug,
        { type: 'file_bug', title: 'Another', descriptionMd: 'Steps.' },
        { type: 'file_bug', title: 'Third', descriptionMd: 'Steps.', explanationMd: '   ' },
      ],
    });
    expect(turn.actions).toEqual([
      {
        type: 'file_bug',
        title: 'The console 500s when the key is saved',
        descriptionMd: 'Saving a rotated key returns HTTP 500.',
        explanationMd: 'The save handler reads the old key id.',
        blocksGuidedCard: true,
      },
      {
        type: 'file_bug',
        title: 'Another',
        descriptionMd: 'Steps.',
        explanationMd: null,
        blocksGuidedCard: false,
      },
      {
        type: 'file_bug',
        title: 'Third',
        descriptionMd: 'Steps.',
        explanationMd: null,
        blocksGuidedCard: false,
      },
    ]);
  });

  it('accepts a turn with no actions at all', () => {
    expect(parseGuideTurn({ messageMd: 'Hello.' }).actions).toEqual([]);
  });

  it.each([
    ['an action outside the closed set', { type: 'run_step', rowId: 'r1' }, 'actions[0].type'],
    ['an action with no type', { rowId: 'r1' }, 'actions[0].type'],
    ['a non-object action', 'tick', 'actions[0]'],
    ['a tick with no row', { type: 'tick' }, 'actions[0].rowId'],
    ['a multi-line step', { ...VALID.add_step, text: 'a\nb' }, 'actions[0].text'],
    ['an unknown executor', { ...VALID.add_step, executor: 'robot' }, 'actions[0].executor'],
    ['an empty list', { type: 'propose_todos', rows: [] }, 'actions[0].rows'],
    [
      'a saved row with no done state',
      { type: 'write_todos', rows: [{ fromId: 'tmp-1', text: 'x' }] },
      'actions[0].rows[0].done',
    ],
    [
      'a revise that changes nothing',
      { type: 'revise_step', rowId: 'r1', reason: 'x' },
      'actions[0]',
    ],
    ['an edit of a field it may not touch', { ...VALID.edit_item, status: 'done' }, 'actions[0]'],
    ['an edit that changes nothing', { type: 'edit_item', reason: 'x' }, 'actions[0]'],
    ['a move with a bad anchor', { ...VALID.move_step, afterRowId: 7 }, 'actions[0].afterRowId'],
    ['a cannot_do with no reason', { type: 'cannot_do' }, 'actions[0].reason'],
    ['a two-line bug title', { ...VALID.file_bug, title: 'a\nb' }, 'actions[0].title'],
    [
      'a bug title over 200 characters',
      { ...VALID.file_bug, title: 'x'.repeat(201) },
      'actions[0].title',
    ],
    ['a bug with no title', { ...VALID.file_bug, title: undefined }, 'actions[0].title'],
    [
      'an empty bug description',
      { ...VALID.file_bug, descriptionMd: '  ' },
      'actions[0].descriptionMd',
    ],
    [
      'a bug description over the cap',
      { ...VALID.file_bug, descriptionMd: 'x'.repeat(20_001) },
      'actions[0].descriptionMd',
    ],
    [
      'a non-boolean blocksGuidedCard',
      { ...VALID.file_bug, blocksGuidedCard: 'yes' },
      'actions[0].blocksGuidedCard',
    ],
    ['a bug naming a kind', { ...VALID.file_bug, kind: 'task' }, 'actions[0]'],
    ['a bug naming a project', { ...VALID.file_bug, projectKey: 'OTHER' }, 'actions[0]'],
    ['a needs_replan with no reason', { type: 'needs_replan' }, 'actions[0].reason'],
    [
      'a local-agent prompt with no row',
      { type: 'local_agent_prompt', prompt: 'x' },
      'actions[0].rowId',
    ],
    [
      'an empty local-agent prompt',
      { type: 'local_agent_prompt', rowId: 'r1', prompt: '  ' },
      'actions[0].prompt',
    ],
    [
      'a local-agent prompt over 2,000 characters',
      { type: 'local_agent_prompt', rowId: 'r1', prompt: 'x'.repeat(2_001) },
      'actions[0].prompt',
    ],
    ['a non-string step', { ...VALID.add_step, text: 7 }, 'actions[0].text'],
    ['a step too long', { ...VALID.add_step, text: 'x'.repeat(5_000) }, 'actions[0].text'],
    ['non-string notes', { ...VALID.add_step, notesMd: 3 }, 'actions[0].notesMd'],
    ['notes too long', { ...VALID.add_step, notesMd: 'x'.repeat(50_000) }, 'actions[0].notesMd'],
    ['a non-object row', { type: 'propose_todos', rows: ['x'] }, 'actions[0].rows[0]'],
    [
      'a multi-line revised text',
      { type: 'revise_step', rowId: 'r1', reason: 'x', text: 'a\nb' },
      'actions[0].text',
    ],
    ['a multi-line title', { type: 'edit_item', reason: 'x', title: 'a\nb' }, 'actions[0].title'],
    [
      'a non-string description',
      { type: 'edit_item', reason: 'x', descriptionMd: 4 },
      'actions[0].descriptionMd',
    ],
    [
      'an explanation too long',
      { type: 'edit_item', reason: 'x', explanationMd: 'x'.repeat(9_000) },
      'actions[0].explanationMd',
    ],
  ])('REFUSES the whole turn on %s', (_label, action, field) => {
    let caught: unknown;
    try {
      parseGuideTurn({ messageMd: 'ok', actions: [action] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidGuideTurnError);
    expect((caught as InvalidGuideTurnError).field).toBe(field);
  });

  it.each([
    ['a non-object result', null, '(root)'],
    ['no message', { actions: [] }, '(root).messageMd'],
    ['a non-array action list', { messageMd: 'ok', actions: {} }, 'actions'],
  ])('REFUSES %s', (_label, raw, field) => {
    expect(() => parseGuideTurn(raw)).toThrow(InvalidGuideTurnError);
    try {
      parseGuideTurn(raw);
    } catch (err) {
      expect((err as InvalidGuideTurnError).field).toBe(field);
    }
  });
});

describe('parseGuideTurn — the optional fields', () => {
  it('reads each revised field, blank notes as null, and keeps only string previous values', () => {
    const turn = parseGuideTurn({
      messageMd: 'ok',
      actions: [
        {
          type: 'revise_step',
          rowId: 'r1',
          reason: 'x',
          notesMd: '   ',
          commandText: 'motir go',
          executor: 'coding_agent',
        },
        {
          type: 'edit_item',
          reason: 'x',
          descriptionMd: ' New body ',
          previous: { descriptionMd: 'Old', title: 9 },
        },
        { ...VALID.move_step, afterRowId: null },
      ],
      dropped: [{ type: 'run_step', reason: 'not in the set' }, { reason: 7 }, 'junk'],
    });
    expect(turn.actions[0]).toEqual({
      type: 'revise_step',
      rowId: 'r1',
      reason: 'x',
      notesMd: null,
      commandText: 'motir go',
      executor: 'coding_agent',
    });
    expect(turn.actions[1]).toEqual({
      type: 'edit_item',
      reason: 'x',
      descriptionMd: 'New body',
      previous: { descriptionMd: 'Old' },
    });
    expect(turn.actions[2]).toMatchObject({ afterRowId: null });
    expect(turn.dropped).toEqual([
      { type: 'run_step', reason: 'not in the set' },
      { type: 'unknown', reason: '' },
    ]);
  });
});

describe('readGuideTurnRecord', () => {
  it('narrows a stored record, reading any outcome it does not know as skipped', () => {
    const record = readGuideTurnRecord({
      actions: [VALID.tick, VALID.add_step, VALID.close],
      outcomes: [
        { outcome: 'landed', todoId: 't1' },
        { outcome: 'weird', reason: 'Not on the list.' },
      ],
      temporary: true,
    });
    expect(record).toEqual({
      actions: expect.any(Array),
      outcomes: [
        { type: 'tick', outcome: 'landed', todoId: 't1' },
        { type: 'add_step', outcome: 'skipped', reason: 'Not on the list.' },
        { type: 'close', outcome: 'skipped' },
      ],
      temporary: true,
    });
  });

  it('round-trips a file_bug outcome’s key, landed or refused as a duplicate (MOTIR-7800)', () => {
    const record = readGuideTurnRecord({
      actions: [VALID.file_bug, VALID.file_bug],
      outcomes: [
        { outcome: 'landed', workItemKey: 'PROD-41' },
        { outcome: 'skipped', reason: 'already filed as PROD-7', workItemKey: 'PROD-7' },
      ],
    });
    expect(record?.outcomes).toEqual([
      { type: 'file_bug', outcome: 'landed', workItemKey: 'PROD-41' },
      {
        type: 'file_bug',
        outcome: 'skipped',
        reason: 'already filed as PROD-7',
        workItemKey: 'PROD-7',
      },
    ]);
  });

  it('reads anything that no longer parses as null', () => {
    expect(readGuideTurnRecord(null)).toBeNull();
    expect(readGuideTurnRecord({ actions: 'x' })).toBeNull();
    expect(readGuideTurnRecord({ actions: [{ type: 'run_step' }] })).toBeNull();
    expect(readGuideTurnRecord({ actions: [] })).toEqual({
      actions: [],
      outcomes: [],
      temporary: false,
    });
  });
});

describe('deriveTemporaryList', () => {
  const rec = (
    actions: Record<string, unknown>[],
    outcome: 'landed' | 'recorded' | 'skipped' = 'recorded',
  ): GuideTurnRecord =>
    readGuideTurnRecord({ actions, outcomes: actions.map(() => ({ outcome })) })!;
  const proposal = rec([
    {
      type: 'propose_todos',
      rows: [
        { id: 'tmp-1', text: 'One' },
        { id: 'tmp-2', text: 'Two' },
        { id: 'tmp-3', text: 'Three' },
      ],
    },
  ]);

  it('applies every recorded correction in order, and ignores ones it cannot place', () => {
    const rows = deriveTemporaryList([
      { seq: 1, record: proposal },
      { seq: 2, record: null },
      {
        seq: 3,
        record: rec([
          { type: 'tick', rowId: 'tmp-1' },
          { type: 'tick', rowId: 'tmp-9' },
          { type: 'add_step', afterRowId: null, reason: 'x', text: 'Zero' },
          { type: 'add_step', afterRowId: 'tmp-gone', reason: 'x', text: 'Last' },
          { type: 'revise_step', rowId: 'tmp-2', reason: 'x', text: 'Two!', executor: 'human' },
          { type: 'revise_step', rowId: 'tmp-9', reason: 'x', text: 'nowhere' },
          { type: 'remove_step', rowId: 'tmp-3', reason: 'x' },
          { type: 'remove_step', rowId: 'tmp-9', reason: 'x' },
          { type: 'move_step', rowId: 'tmp-1', afterRowId: 'tmp-2', reason: 'x' },
          { type: 'move_step', rowId: 'tmp-9', afterRowId: null, reason: 'x' },
          { type: 'current_step', rowId: 'tmp-2' },
        ]),
      },
      { seq: 4, record: rec([{ type: 'untick', rowId: 'tmp-1' }], 'skipped') },
    ]);
    expect(rows.map((r) => [r.id, r.text, r.done])).toEqual([
      [temporaryAddedStepId(3, 2), 'Zero', false],
      ['tmp-2', 'Two!', false],
      ['tmp-1', 'One', true],
      [temporaryAddedStepId(3, 3), 'Last', false],
    ]);
    expect(rows[1]!.executor).toBe('human');
  });

  it('ends the temporary list once a save landed', () => {
    const save = rec(
      [{ type: 'write_todos', rows: [{ fromId: 'tmp-1', text: 'One', done: false }] }],
      'landed',
    );
    expect(
      deriveTemporaryList([
        { seq: 1, record: proposal },
        { seq: 2, record: save },
      ]),
    ).toEqual([]);
  });
});
