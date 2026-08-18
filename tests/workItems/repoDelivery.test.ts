import { describe, expect, it } from 'vitest';
import {
  classifyRepoDelivery,
  hasRepoSetShortfall,
  repoSetShortfall,
} from '@/lib/workItems/repoDelivery';
import type { LinkedChangeRequestCompletionFact } from '@/lib/repositories/githubPullRequestRepository';

// PER-REPOSITORY DELIVERY (Story MOTIR-2725 · MOTIR-2415) — the classifier the
// completion gate AND the detail surface both call.
//
// The property this file defends is the SHARING, not the arithmetic: the gate's
// shortfall is DERIVED from the same classification the panel renders, so the
// panel cannot say `delivered` about a repository the gate is holding the card
// for. That is asserted directly at the bottom, over the same inputs.

const fact = (
  repoName: string,
  merged: boolean,
  baseRef: string | null,
  repoDefaultBranch = 'main',
): LinkedChangeRequestCompletionFact => ({ repoName, merged, baseRef, repoDefaultBranch });

describe('classifyRepoDelivery', () => {
  it('marks a merge onto the repository’s OWN default branch as delivered', () => {
    // `trunk`, not `main` — the mirrored branch, never a hard-coded guess.
    expect(classifyRepoDelivery(['motir-ai'], [fact('motir-ai', true, 'trunk', 'trunk')])).toEqual([
      { repo: 'motir-ai', state: 'delivered', primary: true },
    ]);
  });

  it('marks a repository with NO linked pull request as awaiting', () => {
    // The state that exists for this whole story: no row at all, so nothing that
    // counts rows can see it.
    expect(classifyRepoDelivery(['motir-ai'], [])).toEqual([
      { repo: 'motir-ai', state: 'awaiting', primary: true },
    ]);
  });

  it('marks a merge onto a NON-default branch as awaiting, not delivered', () => {
    // MOTIR-1873's stranded merge: `merged: true` forever, no path to the trunk.
    expect(
      classifyRepoDelivery(['motir-ai'], [fact('motir-ai', true, 'feature/stack', 'main')]),
    ).toEqual([{ repo: 'motir-ai', state: 'awaiting', primary: true }]);
  });

  it('marks a merged PR with an UNRECORDED base as unknown — not delivered, not awaiting', () => {
    // A null base must read as UNKNOWN in BOTH directions. `delivered` would
    // complete a card on a possibly-stranded merge; `awaiting` would assert
    // something false about a merge that may well have landed.
    expect(classifyRepoDelivery(['motir-ai'], [fact('motir-ai', true, null)])).toEqual([
      { repo: 'motir-ai', state: 'unknown', primary: true },
    ]);
  });

  it('prefers a real delivery over an unknown one in the same repository', () => {
    // Two linked PRs, one provably on the trunk. The repository IS delivered;
    // the older row's missing base does not take that away.
    expect(
      classifyRepoDelivery(
        ['motir-core'],
        [fact('motir-core', true, null), fact('motir-core', true, 'main')],
      ),
    ).toEqual([{ repo: 'motir-core', state: 'delivered', primary: true }]);
  });

  it('ignores an UNMERGED pull request entirely', () => {
    expect(classifyRepoDelivery(['motir-core'], [fact('motir-core', false, 'main')])).toEqual([
      { repo: 'motir-core', state: 'awaiting', primary: true },
    ]);
  });

  it('marks element 0 — and only element 0 — as the primary, preserving order', () => {
    const out = classifyRepoDelivery(['motir-ai', 'motir-core'], []);
    expect(out.map((d) => [d.repo, d.primary])).toEqual([
      ['motir-ai', true],
      ['motir-core', false],
    ]);
  });

  it('compares names case-INSENSITIVELY — the two sides come from different tables', () => {
    // The expected side is the project's pin domain; the satisfied side is the
    // installation mirror. A git host treats repository names case-insensitively.
    expect(classifyRepoDelivery(['Motir-Core'], [fact('motir-core', true, 'main')])).toEqual([
      { repo: 'Motir-Core', state: 'delivered', primary: true },
    ]);
  });

  it('never invents a repository the item does not carry', () => {
    // A linked PR in a repository outside the set is not a row — the expected
    // side is the SET, and only the set.
    expect(classifyRepoDelivery(['motir-core'], [fact('motir-gateway', true, 'main')])).toEqual([
      { repo: 'motir-core', state: 'awaiting', primary: true },
    ]);
  });

  it('returns nothing for the EMPTY set — the common case, where the gate abstains', () => {
    expect(classifyRepoDelivery([], [fact('motir-core', true, 'main')])).toEqual([]);
  });
});

describe('the gate’s shortfall is DERIVED from what the panel renders', () => {
  const expected = ['motir-core', 'motir-ai', 'motir-gateway'];
  const linked = [
    fact('motir-core', true, 'main'),
    fact('motir-ai', true, null),
    // motir-gateway: nothing at all.
  ];

  it('splits the two non-delivered states so the hold can say which question to answer', () => {
    const delivery = classifyRepoDelivery(expected, linked);
    expect(repoSetShortfall(delivery)).toEqual({
      outstanding: ['motir-gateway'],
      unknownBase: ['motir-ai'],
    });
  });

  it('holds exactly when some repository the PANEL shows is not delivered', () => {
    // The claim the shared module exists for: one classification, two readers.
    const delivery = classifyRepoDelivery(expected, linked);
    const shortfall = repoSetShortfall(delivery);
    expect(hasRepoSetShortfall(shortfall)).toBe(true);
    expect(
      delivery
        .filter((d) => d.state !== 'delivered')
        .map((d) => d.repo)
        .sort(),
    ).toEqual([...shortfall.outstanding, ...shortfall.unknownBase].sort());
  });

  it('does NOT hold when every repository the panel shows is delivered', () => {
    const delivery = classifyRepoDelivery(['motir-core'], [fact('motir-core', true, 'main')]);
    expect(delivery.every((d) => d.state === 'delivered')).toBe(true);
    expect(hasRepoSetShortfall(repoSetShortfall(delivery))).toBe(false);
  });

  it('ABSTAINS on the empty set — no rows to render, nothing to hold', () => {
    expect(hasRepoSetShortfall(repoSetShortfall(classifyRepoDelivery([], [])))).toBe(false);
  });
});
