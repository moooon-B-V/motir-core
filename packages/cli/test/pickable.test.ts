import { describe, expect, it } from 'vitest';
import { isPickable, type DispatchItem } from '../src/client.js';
import { pickWarning } from '../src/commands/dispatch.js';

// THE PICKABLE RULE (MOTIR-2427) — who may take which card, on a TEAM.
//
// `motir run`, `motir batch` and `motir auto` used to dispatch a card without
// claiming it and without checking whether anyone else had. On a single-operator
// project that is invisible; on a team it is two people's agents on one card,
// each unaware, producing two branches for one piece of work.
//
// The rule is asserted here as a PURE function because that is what it is — the
// three commands share it, and a rule re-implemented per command is a rule that
// drifts. The command-level suites assert that each one actually calls it.

const ME = 'user_me';
const THEM = 'user_them';

/** A ready row, defaulting to the ordinary pickable case. */
function row(over: Partial<DispatchItem> = {}): DispatchItem {
  return {
    key: 'PROD-1',
    kind: 'subtask',
    title: 'A card',
    priority: 'medium',
    status: { key: 'todo', category: 'todo' },
    type: 'code',
    executor: 'coding_agent',
    assigneeId: null,
    inheritedSessionBranch: null,
    ...over,
  };
}

describe('isPickable — the CATEGORY, never a status key', () => {
  it('takes an unassigned card in the to-do category', () => {
    expect(isPickable(row(), ME)).toBe(true);
  });

  it('takes a PROJECT-DEFINED status in the to-do category', () => {
    // The whole reason the rule is expressed on the category: a project may
    // define its own statuses, and a list of status keys would need extending
    // every time somebody adds a vocabulary word. `blocked` is the shipped
    // second member; `triage` is a name this CLI has never heard of.
    expect(isPickable(row({ status: { key: 'blocked', category: 'todo' } }), ME)).toBe(true);
    expect(isPickable(row({ status: { key: 'triage', category: 'todo' } }), ME)).toBe(true);
    expect(isPickable(row({ status: { key: 'icebox', category: 'todo' } }), ME)).toBe(true);
  });

  it('refuses IN REVIEW — its pull request waits on a human, not an agent', () => {
    for (const assigneeId of [null, ME, THEM]) {
      expect(
        isPickable(row({ status: { key: 'in_review', category: 'in_progress' }, assigneeId }), ME),
      ).toBe(false);
    }
  });

  it('refuses PLANNING — and nothing here knows what re-planning IS', () => {
    // MOTIR-2425 gets its effect for free: the card is not skipped because this
    // rule recognises it, but because it left the to-do category. That is what
    // makes the composition worth having.
    for (const assigneeId of [null, ME, THEM]) {
      expect(
        isPickable(row({ status: { key: 'planning', category: 'in_progress' }, assigneeId }), ME),
      ).toBe(false);
    }
  });

  it('refuses a DONE-category card, however it is named', () => {
    expect(isPickable(row({ status: { key: 'done', category: 'done' } }), ME)).toBe(false);
    expect(isPickable(row({ status: { key: 'shipped', category: 'done' } }), ME)).toBe(false);
  });
});

describe('isPickable — unassigned, or MINE', () => {
  it('refuses a card assigned to someone else, in any status', () => {
    // The failure this card exists for: their claim is their work.
    expect(isPickable(row({ assigneeId: THEM }), ME)).toBe(false);
    expect(
      isPickable(
        row({ assigneeId: THEM, status: { key: 'in_progress', category: 'in_progress' } }),
        ME,
      ),
    ).toBe(false);
  });

  it('takes a card already assigned to ME — the claim is idempotent', () => {
    expect(isPickable(row({ assigneeId: ME }), ME)).toBe(true);
  });

  it('RESUMES my own interrupted work, and only mine', () => {
    // The resumption answer, asserted. A killed run leaves its card in progress;
    // under the category rule alone it would be stranded until a human moved it,
    // and an unattended loop that cannot resume its own work needs a human to
    // continue — the opposite of what it is for.
    const interrupted = { key: 'in_progress', category: 'in_progress' };
    expect(isPickable(row({ status: interrupted, assigneeId: ME }), ME)).toBe(true);
    // …but an UNASSIGNED in-progress card is not mine to resume: somebody moved
    // it there, and this run has no evidence it was them.
    expect(isPickable(row({ status: interrupted, assigneeId: null }), ME)).toBe(false);
    expect(isPickable(row({ status: interrupted, assigneeId: THEM }), ME)).toBe(false);
  });

  it('is a plain predicate — no read, no write, no conditional anything', () => {
    // Load-bearing against simulating a lock. The rule is ADVISORY: two runs
    // starting together both see the row unassigned and both take it. Closing
    // that needs a conditional write the server does not offer, and a
    // read-then-check here would close nothing while reading as a guarantee.
    expect(isPickable.length).toBe(2);
    const before = row();
    isPickable(before, ME);
    expect(before).toEqual(row());
  });
});

describe('pickWarning — `motir run <key>` WARNS, it does not refuse', () => {
  // `auto` and `batch` PICK; `run` is GIVEN a key by a person who has a reason.
  // Refusing would break the documented recovery for a card an agent left in
  // progress — but silence is what made the collision invisible in the first
  // place, so it still has to be said.
  it('names WHOSE it is', () => {
    expect(pickWarning({ status: 'todo', assigneeId: THEM }, ME)).toMatch(
      /assigned to someone else/,
    );
    expect(pickWarning({ status: 'todo', assigneeId: THEM }, ME)).toMatch(/two agents on one card/);
  });

  it('names WHERE it is', () => {
    expect(pickWarning({ status: 'in_review', assigneeId: null }, ME)).toMatch(/already In Review/);
    expect(pickWarning({ status: 'planning', assigneeId: null }, ME)).toMatch(/being re-planned/);
  });

  it('says nothing about a card that would have been picked anyway', () => {
    expect(pickWarning({ status: 'todo', assigneeId: null }, ME)).toBeNull();
    expect(pickWarning({ status: 'todo', assigneeId: ME }, ME)).toBeNull();
    expect(pickWarning({ status: 'in_progress', assigneeId: ME }, ME)).toBeNull();
  });
});
