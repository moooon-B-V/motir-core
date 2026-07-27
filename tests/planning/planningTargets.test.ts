import { describe, expect, it } from 'vitest';
import {
  addPlanningTarget,
  clearMentionQuery,
  extraPlanningTargetKeys,
  findMentionQuery,
  MAX_PLANNING_TARGETS,
  primaryPlanningTarget,
  removePlanningTarget,
  type PlanningTarget,
} from '@/lib/planning/planningTargets';
import { MAX_SCOPE_TARGETS } from '@/lib/planChange/scope';

// The `@`-mention target picker's PURE core (Subtask MOTIR-1491). Everything the
// composer's behaviour rests on that has no DOM in it: what the set does, and
// where the `@` query starts and stops. The rules matter because both ends of the
// wire read them — the picker builds the set, the server canonicalizes it.

function target(identifier: string, title = 'Some work'): PlanningTarget {
  return { id: `id-${identifier}`, identifier, title, kind: 'story' };
}

describe('the target SET', () => {
  it('keeps PICK ORDER — the first pick is the primary anchor', () => {
    const set = addPlanningTarget(addPlanningTarget([], target('MOTIR-812')), target('MOTIR-918'));

    expect(set.map((t) => t.identifier)).toEqual(['MOTIR-812', 'MOTIR-918']);
    expect(primaryPlanningTarget(set)?.identifier).toBe('MOTIR-812');
    // The primary travels as the route's PATH item, so it is not repeated in
    // the body — passing it twice would state the same anchor two ways.
    expect(extraPlanningTargetKeys(set)).toEqual(['MOTIR-918']);
  });

  it('dedupes case-insensitively, matching how the server canonicalizes the scope', () => {
    const set = addPlanningTarget(addPlanningTarget([], target('MOTIR-812')), target('motir-812'));
    expect(set).toHaveLength(1);
  });

  it('stops adding at the SERVER’s bound, so the picker cannot build a set that 400s', () => {
    expect(MAX_PLANNING_TARGETS).toBe(MAX_SCOPE_TARGETS);

    let set: PlanningTarget[] = [];
    for (let i = 0; i < MAX_PLANNING_TARGETS + 5; i += 1) {
      set = addPlanningTarget(set, target(`MOTIR-${i}`));
    }
    expect(set).toHaveLength(MAX_PLANNING_TARGETS);
  });

  it('removing the first PROMOTES the next pick to primary', () => {
    const set = addPlanningTarget(addPlanningTarget([], target('MOTIR-812')), target('MOTIR-918'));
    const after = removePlanningTarget(set, 'motir-812');

    expect(after.map((t) => t.identifier)).toEqual(['MOTIR-918']);
    expect(primaryPlanningTarget(after)?.identifier).toBe('MOTIR-918');
  });

  it('an empty set has no primary and no extra keys (the project-wide turn)', () => {
    expect(primaryPlanningTarget([])).toBeNull();
    expect(extraPlanningTargetKeys([])).toEqual([]);
  });
});

describe('the `@` query the caret sits in', () => {
  it('opens on a bare `@` at the caret — with an EMPTY query (the “type to search” state)', () => {
    const text = 'Add sub-stories to @';
    expect(findMentionQuery(text, text.length)).toEqual({ query: '', start: 19, end: 20 });
  });

  it('grows with what is typed after the trigger', () => {
    const text = 'Add sub-stories to @bil';
    expect(findMentionQuery(text, text.length)).toEqual({ query: 'bil', start: 19, end: 23 });
  });

  it('is NOT triggered mid-word — an email-ish `foo@bar` is not a mention', () => {
    const text = 'ping me at yue@example';
    expect(findMentionQuery(text, text.length)).toBeNull();
  });

  it('closes once whitespace follows the query', () => {
    const text = 'Add to @bil then stop';
    expect(findMentionQuery(text, text.length)).toBeNull();
  });

  it('reads from the CARET, not the end — editing mid-sentence still triggers', () => {
    const text = 'Add @bil to the plan';
    expect(findMentionQuery(text, 8)).toEqual({ query: 'bil', start: 4, end: 8 });
  });

  it('a second `@` CLOSES the query instead of nesting inside it', () => {
    // `@` is excluded from the query charset, so `@bil@pay` is not a mention of
    // `bil@pay` — and the trailing `@` is mid-word, so it opens nothing either.
    // Neither half silently becomes a search the user did not ask for.
    expect(findMentionQuery('Add @bil@pay', 'Add @bil@pay'.length)).toBeNull();
    // A properly separated second mention DOES open, at its own position.
    const text = 'Add @bil and @pay';
    expect(findMentionQuery(text, text.length)).toEqual({ query: 'pay', start: 13, end: 17 });
  });
});

describe('consuming the query on a pick', () => {
  it('removes the `@token` and closes the caret over the gap — the chip goes to the TRAY', () => {
    const text = 'Add sub-stories to @bil';
    const range = findMentionQuery(text, text.length)!;

    expect(clearMentionQuery(text, range)).toEqual({
      text: 'Add sub-stories to ',
      caret: 19,
    });
  });

  it('keeps what was typed AFTER the query, so a mid-sentence pick loses nothing', () => {
    const text = 'Add @bil to the plan';
    const range = findMentionQuery(text, 8)!;

    expect(clearMentionQuery(text, range)).toEqual({ text: 'Add  to the plan', caret: 4 });
  });
});
