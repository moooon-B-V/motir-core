import { describe, expect, it } from 'vitest';
import {
  addPlanningTarget,
  consumeTargetShortcut,
  extraPlanningTargetKeys,
  MAX_PLANNING_TARGETS,
  primaryPlanningTarget,
  removePlanningTarget,
  type PlanningTarget,
} from '@/lib/planning/planningTargets';
import { MAX_SCOPE_TARGETS } from '@/lib/planChange/scope';

// The `@`-mention target picker's PURE core (Subtask MOTIR-1491). Everything the
// composer's behaviour rests on that has no DOM in it: what the set does, and
// — since MOTIR-6897 — which edit is the `@` SHORTCUT that opens the search. The rules matter because both ends of the
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

describe('the `@` shortcut (MOTIR-6897) — an `@` typed at a word boundary', () => {
  it('fires on an `@` typed at the START of the message, and gives the `@` back', () => {
    expect(consumeTargetShortcut('', '@', 1)).toEqual({ text: '', caret: 0 });
  });

  it('fires after whitespace — including a line break — mid-sentence too', () => {
    expect(consumeTargetShortcut('Break this into ', 'Break this into @', 17)).toEqual({
      text: 'Break this into ',
      caret: 16,
    });
    expect(consumeTargetShortcut('one\n', 'one\n@', 5)).toEqual({ text: 'one\n', caret: 4 });
    // Typed in the MIDDLE: the caret decides, not the end of the text.
    expect(consumeTargetShortcut('Add  to it', 'Add @ to it', 5)).toEqual({
      text: 'Add  to it',
      caret: 4,
    });
  });

  it('does NOT fire inside a word — an email-ish `foo@bar` types an ordinary `@`', () => {
    expect(consumeTargetShortcut('Ask foo', 'Ask foo@', 8)).toBeNull();
  });

  it('does NOT fire on anything but a single typed `@` — a paste, a deletion, another key', () => {
    expect(consumeTargetShortcut('', '@bil', 4)).toBeNull(); // a paste
    expect(consumeTargetShortcut('Add @', 'Add ', 4)).toBeNull(); // a deletion
    expect(consumeTargetShortcut('Add ', 'Add x', 5)).toBeNull(); // another key
    // The caret is not just past the inserted `@` (a replaced selection).
    expect(consumeTargetShortcut('Add ', 'Add @', 3)).toBeNull();
    expect(consumeTargetShortcut('Add ', '@Add', 0)).toBeNull();
  });
});
