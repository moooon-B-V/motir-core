import { describe, expect, it } from 'vitest';
import type { ProjectRepoDto, ProjectRepoStateDto } from '@/lib/dto/projectRepos';
import {
  isEstablishRow,
  isSettledRow,
  rowIsReachable,
  setHasEstablishWork,
  setHasOrganizationRow,
} from '@/lib/projectRepos/establishStep';
import { SEED_SOURCE_ORGANIZATION } from '@/lib/projectRepos/vocabulary';

// THE ESTABLISH STEP'S PREDICATES (bug MOTIR-5049 · design
// `design/repository-set/design-notes.md` §7b) — the module that ended three
// hand-written copies of "is this row settled?" and added the one predicate
// nobody had: does this set hold work the step DOES?
//
// ⚠️ THE POINT OF THESE CASES IS WHERE THE PREDICATES COME APART, NOT EITHER ONE
// ALONE. The bug shipped because a builder reached for a predicate that was
// ALMOST the right one, so the table below is asserted state by state over the
// WHOLE ADR §4.1 enum. The row that matters is `created`: settled AND the step's
// work, and therefore the single state at which "draw the band iff the set is
// unsettled" silently drops a report Motir owes. Written as a total map so
// adding a seventh state to the enum fails here rather than taking a default.

const ALL_STATES = [
  'proposed',
  'creating',
  'created',
  'connected',
  'skipped',
  'failed',
] as const satisfies readonly ProjectRepoStateDto[];

/** state → [is establish-work, is settled] — the ADR §4.1 machine, read twice. */
const TABLE: Record<ProjectRepoStateDto, readonly [boolean, boolean]> = {
  proposed: [true, false],
  creating: [true, false],
  // ⚠️ SETTLED **AND** THE STEP'S WORK. It has no legal move left, and the step
  // still owes the report on the repository it just made.
  created: [true, true],
  connected: [false, true],
  skipped: [false, true],
  // ⚠️ NEITHER. Resumable at any later visit, so it is not settled — and it is
  // resumable HERE, so the band is drawn for it.
  failed: [true, false],
};

function row(over: Partial<ProjectRepoDto> = {}): ProjectRepoDto {
  return {
    id: 'r1',
    projectId: 'proj-1',
    role: 'web',
    name: 'atlas-web',
    label: null,
    seedSource: 'nextjs-prisma-vercel-starter',
    state: 'proposed',
    failureReason: null,
    proposalSignal: null,
    realizedRepo: null,
    established: false,
    takeover: null,
    access: { state: 'not_invited', login: null, invitationUrl: null },
    position: 'a0',
    createdAt: '2026-09-10T10:00:00.000Z',
    updatedAt: '2026-09-10T10:00:00.000Z',
    ...over,
  } as ProjectRepoDto;
}

describe('isEstablishRow / isSettledRow — the two predicates, over every ADR §4.1 state', () => {
  for (const state of ALL_STATES) {
    const [establishes, settled] = TABLE[state];
    it(`\`${state}\` — establish-work: ${establishes}, settled: ${settled}`, () => {
      expect(isEstablishRow(row({ state }))).toBe(establishes);
      expect(isSettledRow(row({ state }))).toBe(settled);
    });
  }

  it('`created` is the ONE state where establish-work is not the negation of settled', () => {
    // The precise relationship, because "these two are different predicates" is
    // easy to say and easy to get subtly wrong. If `isEstablishRow` were merely
    // `!isSettledRow`, `establishes === !settled` would hold for every state.
    // It holds for five and breaks on `created` — settled, and still the step's
    // work — so that single row is what forbids writing either in terms of the
    // other, and it is the row a builder reaching for "unsettled" would drop.
    const breaksTheNegation = ALL_STATES.filter((s) => {
      const [establishes, settled] = TABLE[s];
      return establishes !== !settled;
    });
    expect(breaksTheNegation).toEqual(['created']);
  });

  it('`failed` is establish-work AND not settled — the row a "terminal" reading gets wrong', () => {
    // Consistent with the negation, unlike `created`, but worth its own case:
    // it is the state where settledness itself is counter-intuitive, and a set
    // holding one must still draw the band, because a failure is resumable HERE.
    expect(isEstablishRow(row({ state: 'failed' }))).toBe(true);
    expect(isSettledRow(row({ state: 'failed' }))).toBe(false);
  });
});

describe('setHasEstablishWork — THE DRAW PREDICATE (design §7b)', () => {
  it('is FALSE for an all-`connected` organisation-owned set — the population the bug was about', () => {
    expect(
      setHasEstablishWork([
        row({ state: 'connected', seedSource: SEED_SOURCE_ORGANIZATION }),
        row({ state: 'connected', seedSource: SEED_SOURCE_ORGANIZATION }),
      ]),
    ).toBe(false);
  });

  it('is FALSE for a `connected` + `skipped` set — settled is settled, whatever the seed source', () => {
    expect(setHasEstablishWork([row({ state: 'connected' }), row({ state: 'skipped' })])).toBe(
      false,
    );
  });

  it('is FALSE for an EMPTY set — the one thing the row COUNT it replaces got right', () => {
    expect(setHasEstablishWork([])).toBe(false);
  });

  it("is TRUE as soon as ONE row is the step's work, however many are not", () => {
    expect(
      setHasEstablishWork([
        row({ state: 'connected', seedSource: SEED_SOURCE_ORGANIZATION }),
        row({ state: 'connected', seedSource: SEED_SOURCE_ORGANIZATION }),
        row({ state: 'proposed' }),
      ]),
    ).toBe(true);
  });

  it('is TRUE for a `created` set — the report is owed, so `codeOutcomeOf === ready` cannot stand in', () => {
    // The rejected candidate, pinned: this set is `ready` to the rail AND draws
    // the band, so the two questions cannot share one predicate.
    expect(
      setHasEstablishWork([
        row({ state: 'created', access: { state: 'invited', login: 'yue', invitationUrl: null } }),
      ]),
    ).toBe(true);
  });
});

describe('setHasOrganizationRow — what the band may CLAIM', () => {
  it('is TRUE when any row is organisation-seeded, and routes through the shared discriminator', () => {
    expect(setHasOrganizationRow([row(), row({ seedSource: SEED_SOURCE_ORGANIZATION })])).toBe(
      true,
    );
  });

  it('is FALSE for a set Motir seeds entirely — the common case keeps the unscoped copy', () => {
    expect(setHasOrganizationRow([row(), row({ seedSource: 'initialised' })])).toBe(false);
  });

  it('does NOT answer the draw question — a `skipped` row is neither organisation-seeded nor work', () => {
    // §7b's stated reason for rejecting `isOrganizationSeedSource` as the draw
    // predicate: it is too narrow in one direction and too wide in the other.
    const skipped = [row({ state: 'skipped', seedSource: 'initialised' })];
    expect(setHasOrganizationRow(skipped)).toBe(false);
    expect(setHasEstablishWork(skipped)).toBe(false);
  });
});

describe('rowIsReachable — the second predicate that was duplicated verbatim', () => {
  it('is FALSE only for a `created` row nobody was invited to', () => {
    expect(rowIsReachable(row({ state: 'created' }))).toBe(false);
  });

  it('is TRUE for a `connected` row — the user already owns it, so access is not a question', () => {
    expect(rowIsReachable(row({ state: 'connected' }))).toBe(true);
  });

  it('is TRUE for an `invited` created row — Motir has done everything it can', () => {
    expect(
      rowIsReachable(
        row({ state: 'created', access: { state: 'invited', login: 'yue', invitationUrl: null } }),
      ),
    ).toBe(true);
  });
});
