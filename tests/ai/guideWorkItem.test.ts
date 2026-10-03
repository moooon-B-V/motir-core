import { describe, expect, it } from 'vitest';

import {
  GUIDE_ACTION_TYPES,
  GUIDE_CONTEXT_TURNS_MAX,
  InvalidGuideTurnError,
  buildGuideContext,
  parseGuideTurn,
  type GuideActionType,
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
