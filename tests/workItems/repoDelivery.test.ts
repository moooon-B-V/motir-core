import { describe, expect, it } from 'vitest';
import {
  awaitingRepoRows,
  classifyRepoDelivery,
  hasRepoSetShortfall,
  repoSetShortfall,
  type RepoDelivery,
  type RepoDeliveryState,
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

const delivery = (repo: string, state: RepoDeliveryState): RepoDelivery => ({
  repo,
  state,
  primary: false,
});

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

  it('splits the non-delivered states so the hold can say which question to answer', () => {
    const delivery = classifyRepoDelivery(expected, linked);
    expect(repoSetShortfall(delivery)).toEqual({
      outstanding: ['motir-gateway'],
      unknownBase: ['motir-ai'],
      // Widened by Story MOTIR-2732 (ADR §A5): a repository that does not EXIST
      // yet is a third kind of shortfall, and the answer to it is not "open a
      // pull request" — it is "establish the row".
      unestablished: [],
    });
  });

  it('holds on a repository that has no row to open a pull request against', () => {
    const delivery = classifyRepoDelivery(
      [{ repo: 'motir-core' }, { repo: 'motir-docs', establishState: 'proposed' }],
      [fact('motir-core', true, 'main')],
    );
    expect(delivery.map((d) => d.state)).toEqual(['delivered', 'unestablished']);
    const shortfall = repoSetShortfall(delivery);
    expect(shortfall).toEqual({ outstanding: [], unknownBase: [], unestablished: ['motir-docs'] });
    expect(hasRepoSetShortfall(shortfall)).toBe(true);
  });

  it('does NOT hold on a repository the project deliberately skipped', () => {
    // `skipped` is the one state that is not a shortfall (ADR §A5). A card whose
    // only outstanding repository was declined must be able to complete, or the
    // project's own decision would deadlock it.
    const delivery = classifyRepoDelivery(
      [{ repo: 'motir-core' }, { repo: 'motir-infra', establishState: 'skipped' }],
      [fact('motir-core', true, 'main')],
    );
    expect(delivery.map((d) => d.state)).toEqual(['delivered', 'excluded']);
    expect(hasRepoSetShortfall(repoSetShortfall(delivery))).toBe(false);
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

// MOTIR-3036 — the PLACEHOLDER derivation, which asks a different question from
// the classifier above. `awaiting` means "not merged"; the row means "no pull
// request". They diverge for the whole life of every open pull request, and the
// Development section asserted the second one off the first.
describe('awaitingRepoRows', () => {
  const pr = (repo: string) => ({ repo });

  it('drops a repository whose pull request is already listed', () => {
    expect(
      awaitingRepoRows([delivery('motir-core', 'awaiting')], [pr('moooon/motir-core')]),
    ).toEqual([]);
  });

  it('COMPARES the bare name against the DTO’s owner/name — the forms differ by construction', () => {
    // `work_item.targetRepos` stores `motir-core`; `LinkedPullRequestDto.repo` is
    // `owner/name`. A raw-string cross-reference matches nothing at all, which is
    // the defect wearing a fix's clothes — so this case is the one that decides
    // whether the derivation works on real data.
    expect(
      awaitingRepoRows([delivery('motir-core', 'awaiting')], [pr('moooon-B-V/MOTIR-CORE')]),
    ).toEqual([]);
  });

  it('keeps a repository that has no pull request of its own', () => {
    expect(
      awaitingRepoRows(
        [delivery('motir-core', 'awaiting'), delivery('motir-ai', 'awaiting')],
        [pr('moooon/motir-core')],
      ),
    ).toEqual([delivery('motir-ai', 'awaiting')]);
  });

  it('keys on the pull request EXISTING, not on its delivery state', () => {
    // `unknown` is the state a merged PR with an unrecorded base lands in — the
    // repository HAS a row on the surface, so it is not owed a placeholder too.
    expect(awaitingRepoRows([delivery('motir-ai', 'unknown')], [pr('moooon/motir-ai')])).toEqual(
      [],
    );
  });

  it('still drops a DELIVERED repository, pull request listed or not', () => {
    // The drop the two hosts used to do themselves. It moved in here WITH the
    // cross-reference so that a host passes its set and decides nothing.
    expect(awaitingRepoRows([delivery('motir-core', 'delivered')], [])).toEqual([]);
  });

  it('leaves an unmatched pull request alone — it is not a repository the item carries', () => {
    // A PR linked by hand can name a repository outside the item's set. It gets
    // its own row from `pullRequests`; it must not add or remove a placeholder.
    expect(awaitingRepoRows([delivery('motir-ai', 'awaiting')], [pr('moooon/motir-core')])).toEqual(
      [delivery('motir-ai', 'awaiting')],
    );
  });

  it('preserves the item’s repository ORDER', () => {
    expect(
      awaitingRepoRows(
        [delivery('motir-core', 'awaiting'), delivery('motir-ai', 'awaiting')],
        [],
      ).map((d) => d.repo),
    ).toEqual(['motir-core', 'motir-ai']);
  });

  it('returns the empty set for an item that carries no repositories', () => {
    expect(awaitingRepoRows([], [pr('moooon/motir-core')])).toEqual([]);
  });

  it('ignores a pull request that names no repository — it suppresses nothing', () => {
    expect(awaitingRepoRows([delivery('motir-core', 'awaiting')], [pr('')])).toEqual([
      delivery('motir-core', 'awaiting'),
    ]);
  });

  it('KEEPS a set entry that names no repository — nothing can match it', () => {
    // The pin path rejects a blank name, so this should not exist; if one ever
    // does, it must stay visible rather than be silently swallowed by a pull
    // request it has no relationship to.
    expect(awaitingRepoRows([delivery('', 'awaiting')], [pr('moooon/motir-core')])).toEqual([
      delivery('', 'awaiting'),
    ]);
  });
});
