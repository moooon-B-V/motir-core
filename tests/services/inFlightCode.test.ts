import { describe, expect, it } from 'vitest';
import { deriveInFlightCode, type InFlightDeliveryFact } from '@/lib/services/inFlightCode';

// MOTIR-6618 — the PURE in-flight derivation: own open delivery first, else the
// nearest ancestor's, per repository; merged is not in-flight; empty is an array.

function fact(
  workItemId: string,
  repo: string,
  opts: Partial<Omit<InFlightDeliveryFact, 'workItemId' | 'repo'>> & {
    state?: 'open' | 'merged' | 'closed';
  } = {},
): InFlightDeliveryFact {
  const state = opts.state ?? 'open';
  const prNumber = opts.prNumber ?? 1;
  return {
    workItemId,
    repo,
    branch: opts.branch ?? `branch-${workItemId}-${repo}`,
    headSha: opts.headSha ?? null,
    prNumber,
    prUrl: opts.prUrl ?? `https://github.com/${repo}/pull/${prNumber}`,
    draft: opts.draft ?? false,
    baseRef: opts.baseRef ?? 'main',
    open: state === 'open',
    merged: state === 'merged',
  };
}

describe('deriveInFlightCode', () => {
  it('names the card’s own open delivery, branch = headRef', () => {
    const out = deriveInFlightCode({
      itemId: 'card',
      ancestors: [],
      deliveries: [
        fact('card', 'moooon/motir-core', {
          branch: 'subtask/MOTIR-1-x',
          headSha: 'abc',
          prNumber: 7,
          draft: true,
          baseRef: 'main',
        }),
      ],
    });
    expect(out).toEqual({
      inFlightCode: [
        {
          repo: 'moooon/motir-core',
          branch: 'subtask/MOTIR-1-x',
          headSha: 'abc',
          prNumber: 7,
          prUrl: 'https://github.com/moooon/motir-core/pull/7',
          draft: true,
          baseRef: 'main',
          source: 'own',
        },
      ],
      mergedRepos: [],
    });
  });

  it('inherits the NEAREST ancestor’s open delivery for a repository the card has none in', () => {
    const out = deriveInFlightCode({
      itemId: 'sub',
      ancestors: [
        { id: 'story', key: 'MOTIR-2' },
        { id: 'epic', key: 'MOTIR-1' },
      ],
      deliveries: [
        fact('epic', 'moooon/motir-core', { branch: 'parent/MOTIR-1-epic' }),
        fact('story', 'moooon/motir-core', { branch: 'parent/MOTIR-2-story' }),
      ],
    });
    expect(out.inFlightCode).toHaveLength(1);
    expect(out.inFlightCode[0]).toMatchObject({
      repo: 'moooon/motir-core',
      branch: 'parent/MOTIR-2-story',
      source: 'inherited',
      fromKey: 'MOTIR-2',
    });
    expect(out.mergedRepos).toEqual([]);
  });

  it('skips an ancestor with no open delivery and keeps walking up', () => {
    const out = deriveInFlightCode({
      itemId: 'sub',
      ancestors: [
        { id: 'story', key: 'MOTIR-2' },
        { id: 'epic', key: 'MOTIR-1' },
      ],
      deliveries: [
        fact('story', 'moooon/motir-core', { state: 'merged' }),
        fact('epic', 'moooon/motir-core', { branch: 'parent/MOTIR-1-epic' }),
      ],
    });
    expect(out.inFlightCode).toEqual([
      expect.objectContaining({ branch: 'parent/MOTIR-1-epic', fromKey: 'MOTIR-1' }),
    ]);
  });

  it('own wins in its repository; the parent fills another — two entries', () => {
    const out = deriveInFlightCode({
      itemId: 'sub',
      ancestors: [{ id: 'story', key: 'MOTIR-2' }],
      deliveries: [
        fact('story', 'moooon/motir-core', { branch: 'parent/MOTIR-2-story' }),
        fact('story', 'moooon/motir-ai', { branch: 'parent/MOTIR-2-story-ai' }),
        fact('sub', 'moooon/motir-ai', { branch: 'subtask/MOTIR-3-own' }),
      ],
    });
    expect(out.inFlightCode.map((e) => [e.repo, e.source, e.branch])).toEqual([
      ['moooon/motir-ai', 'own', 'subtask/MOTIR-3-own'],
      ['moooon/motir-core', 'inherited', 'parent/MOTIR-2-story'],
    ]);
  });

  it('merged is not in-flight — it names the repository in mergedRepos instead', () => {
    const out = deriveInFlightCode({
      itemId: 'card',
      ancestors: [],
      deliveries: [
        fact('card', 'moooon/motir-core', { state: 'merged' }),
        fact('card', 'moooon/motir-core', { state: 'merged', prNumber: 2 }),
      ],
    });
    expect(out).toEqual({ inFlightCode: [], mergedRepos: ['moooon/motir-core'] });
  });

  it('a closed-unmerged delivery is neither in-flight nor merged', () => {
    const out = deriveInFlightCode({
      itemId: 'card',
      ancestors: [],
      deliveries: [fact('card', 'moooon/motir-core', { state: 'closed' })],
    });
    expect(out).toEqual({ inFlightCode: [], mergedRepos: [] });
  });

  it('an own merge whose repository is still in flight upstream is NOT reported merged', () => {
    // The child's code merged onto the story branch; the story's pull request is
    // still open, so the code is NOT on the default branch — it rides the story.
    const out = deriveInFlightCode({
      itemId: 'sub',
      ancestors: [{ id: 'story', key: 'MOTIR-2' }],
      deliveries: [
        fact('sub', 'moooon/motir-core', { state: 'merged', baseRef: 'parent/MOTIR-2-story' }),
        fact('story', 'moooon/motir-core', { branch: 'parent/MOTIR-2-story' }),
      ],
    });
    expect(out.mergedRepos).toEqual([]);
    expect(out.inFlightCode).toEqual([
      expect.objectContaining({ source: 'inherited', fromKey: 'MOTIR-2' }),
    ]);
  });

  it('an ancestor’s MERGED delivery never lands in mergedRepos', () => {
    const out = deriveInFlightCode({
      itemId: 'sub',
      ancestors: [{ id: 'story', key: 'MOTIR-2' }],
      deliveries: [fact('story', 'moooon/motir-core', { state: 'merged' })],
    });
    expect(out).toEqual({ inFlightCode: [], mergedRepos: [] });
  });

  it('nothing anywhere → two EMPTY arrays, never null', () => {
    expect(deriveInFlightCode({ itemId: 'card', ancestors: [], deliveries: [] })).toEqual({
      inFlightCode: [],
      mergedRepos: [],
    });
  });

  it('two own open deliveries in one repository resolve to the newest link', () => {
    const out = deriveInFlightCode({
      itemId: 'card',
      ancestors: [],
      deliveries: [
        fact('card', 'moooon/motir-core', { prNumber: 9, branch: 'older' }),
        fact('card', 'moooon/motir-core', { prNumber: 4, branch: 'newer' }),
      ],
    });
    expect(out.inFlightCode).toEqual([expect.objectContaining({ branch: 'newer', prNumber: 4 })]);
  });

  it('ignores deliveries of cards outside the chain', () => {
    const out = deriveInFlightCode({
      itemId: 'card',
      ancestors: [],
      deliveries: [fact('stranger', 'moooon/motir-core')],
    });
    expect(out).toEqual({ inFlightCode: [], mergedRepos: [] });
  });
});
