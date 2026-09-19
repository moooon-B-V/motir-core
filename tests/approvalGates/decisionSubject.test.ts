import { describe, expect, it } from 'vitest';
import {
  decisionIdentityOf,
  decisionSubjectVersion,
  headingOf,
  titleFromDecisionPath,
  type DecisionMember,
} from '@/lib/approvalGates/decisionSubject';
import {
  contentFromRead,
  repoFileDecisionResolver,
} from '@/lib/approvalGates/decisionDocumentResolver';
import type { RepoFileServiceResult } from '@/lib/services/repoFileReadService';

// THE DECISION GATE'S SUBJECT and its RESOLVER, pure (MOTIR-5676; `approval-gates.md`
// §8's FIFTH AMENDMENT, clauses 3, 4 and 8). The document is ONE file across the whole
// delivery set, and every way that fails to be true is a named reason, never `none`.

const member = (over: Partial<DecisionMember> = {}): DecisionMember => ({
  repo: 'acme/web',
  number: 1,
  outcome: 'one',
  path: 'docs/decisions/page-model.md',
  blobSha: 'blob-1',
  headSha: 'head-1',
  ...over,
});

describe('decisionIdentityOf — one document across the set, or a reason', () => {
  it('no member, or no captured member, asks nothing yet', () => {
    expect(decisionIdentityOf([])).toBeNull();
    expect(decisionIdentityOf([member({ outcome: null })])).toBeNull();
  });

  it('one captured document is resolvable over that file', () => {
    expect(decisionIdentityOf([member()])).toEqual({
      resolvable: true,
      repo: 'acme/web',
      number: 1,
      path: 'docs/decisions/page-model.md',
      blobSha: 'blob-1',
      headSha: 'head-1',
    });
  });

  it('one document beside members that carry none is still that document', () => {
    const identity = decisionIdentityOf([
      member({ number: 2, outcome: 'none', path: null, blobSha: null }),
      member(),
    ]);
    expect(identity).toMatchObject({ resolvable: true, number: 1 });
  });

  it('a document in EACH of two pull requests is `several` — the set carries two', () => {
    expect(
      decisionIdentityOf([member(), member({ number: 2, path: 'docs/decisions/b.md' })]),
    ).toMatchObject({ resolvable: false, reason: 'several', number: 2 });
  });

  it('`several` on any member wins over everything else', () => {
    expect(
      decisionIdentityOf([
        member({ outcome: 'unreadable' }),
        member({ number: 2, outcome: 'several' }),
      ]),
    ).toMatchObject({ resolvable: false, reason: 'several', number: 2 });
  });

  it('an unreadable member makes the set unreadable, even beside a clean document', () => {
    expect(
      decisionIdentityOf([member(), member({ number: 2, outcome: 'unreadable' })]),
    ).toMatchObject({ resolvable: false, reason: 'unreadable', number: 2 });
  });

  it('a member NOT YET captured beside a captured one is unreadable — it may hold a second document', () => {
    expect(decisionIdentityOf([member(), member({ number: 2, outcome: null })])).toMatchObject({
      resolvable: false,
      reason: 'unreadable',
      number: 2,
    });
  });

  it('every member saying `none` is `none`, read off the first in canonical order', () => {
    expect(
      decisionIdentityOf([
        member({ repo: 'acme/z', outcome: 'none' }),
        member({ repo: 'acme/a', outcome: 'none', headSha: 'head-a' }),
      ]),
    ).toEqual({ resolvable: false, reason: 'none', repo: 'acme/a', number: 1, headSha: 'head-a' });
  });

  it('a `one` capture missing its path or sha breaks its own invariant and is unreadable', () => {
    expect(decisionIdentityOf([member({ blobSha: null })])).toMatchObject({
      resolvable: false,
      reason: 'unreadable',
    });
  });
});

describe('decisionSubjectVersion — the BLOB, not the head (clause 4)', () => {
  it('a resolvable document is versioned by its blob, so a push that leaves it alone keeps it', () => {
    const before = decisionIdentityOf([member({ headSha: 'head-1' })])!;
    const after = decisionIdentityOf([member({ headSha: 'head-2' })])!;
    expect(decisionSubjectVersion(before)).toBe('acme/web:docs/decisions/page-model.md@blob-1');
    expect(decisionSubjectVersion(after)).toBe(decisionSubjectVersion(before));
  });

  it('a changed document is a new version', () => {
    expect(decisionSubjectVersion(decisionIdentityOf([member({ blobSha: 'blob-2' })])!)).toBe(
      'acme/web:docs/decisions/page-model.md@blob-2',
    );
  });

  it('an unresolvable subject is versioned by its head, and an unknown head says so', () => {
    expect(
      decisionSubjectVersion(decisionIdentityOf([member({ outcome: 'none', headSha: 'h9' })])!),
    ).toBe('acme/web:unresolvable:none@h9');
    expect(
      decisionSubjectVersion(
        decisionIdentityOf([member({ outcome: 'unreadable', headSha: null })])!,
      ),
    ).toBe('acme/web:unresolvable:unreadable@unknown');
  });
});

describe('titleFromDecisionPath and headingOf — what a row and a port can say', () => {
  it.each([
    ['docs/decisions/approval-gates.md', 'Approval gates'],
    ['docs/decisions/pages_storage.md', 'Pages storage'],
    ['docs/decisions/x.MD', 'X'],
    ['docs/decisions/---.md', '---'],
  ])('%s → %s', (path, title) => {
    expect(titleFromDecisionPath(path)).toBe(title);
  });

  it('the first level-1 heading, plain, outside any code fence', () => {
    expect(headingOf('```md\n# not this\n```\n\n## Context\n# ADR: *Pages* #\n')).toBe(
      'ADR: Pages',
    );
  });

  it('a document with no level-1 heading has none', () => {
    expect(headingOf('## Status\n\nAccepted.')).toBeNull();
    expect(headingOf('#   \n')).toBeNull();
  });
});

describe('the production resolver — the file at the captured HEAD, every outcome named', () => {
  const identity = decisionIdentityOf([member()]) as Extract<
    ReturnType<typeof decisionIdentityOf>,
    { resolvable: true }
  >;
  const at = { path: identity.path, ref: 'head-1' };

  it.each<[RepoFileServiceResult, string]>([
    [{ outcome: 'not_found', ...at }, 'gone_at_head'],
    [{ outcome: 'ref_not_found', ...at }, 'gone_at_head'],
    [{ outcome: 'too_large', ...at, limitBytes: 1 }, 'too_large'],
    [{ outcome: 'unauthorized', ...at }, 'host_unreachable'],
    [
      { outcome: 'unreachable', ...at, failure: 'timeout' as never, detail: 'slow' },
      'host_unreachable',
    ],
    [{ outcome: 'provider_unavailable', repoRef: 'acme/web', detail: 'x' }, 'host_unreachable'],
    [{ outcome: 'repo_not_connected', repoRef: 'acme/web' }, 'not_connected'],
    [{ outcome: 'invalid_path', path: identity.path, reason: 'dots' }, 'unreadable'],
  ])('%o → unresolvable %s', (result, reason) => {
    expect(contentFromRead(identity, result)).toEqual({ outcome: 'unresolvable', reason });
  });

  it('`found` is the document, named by the capture', () => {
    expect(
      contentFromRead(identity, { outcome: 'found', ...at, text: '# Pages', bytes: 7 }),
    ).toEqual({
      outcome: 'resolved',
      repo: 'acme/web',
      path: 'docs/decisions/page-model.md',
      blobSha: 'blob-1',
      markdown: '# Pages',
    });
  });

  it('an outcome nobody mapped throws rather than rendering as something', () => {
    expect(() => contentFromRead(identity, { outcome: 'surprise' } as never)).toThrow(/unmapped/);
  });

  it('reads at the HEAD, never the default branch; an unresolvable identity or no head reads nothing', async () => {
    const calls: string[] = [];
    const resolver = repoFileDecisionResolver(async (_ctx, repoRef, path, ref) => {
      calls.push(`${repoRef}:${path}@${ref}`);
      return { outcome: 'found', path, ref, text: 'x', bytes: 1 };
    });
    const ctx = { userId: 'u', workspaceId: 'w' };

    expect((await resolver.resolve(identity, ctx)).outcome).toBe('resolved');
    expect(calls).toEqual(['acme/web:docs/decisions/page-model.md@head-1']);

    expect(await resolver.resolve(decisionIdentityOf([member({ outcome: 'none' })])!, ctx)).toEqual(
      { outcome: 'unresolvable', reason: 'none' },
    );
    expect(await resolver.resolve({ ...identity, headSha: null }, ctx)).toEqual({
      outcome: 'unresolvable',
      reason: 'unreadable',
    });
    expect(calls).toHaveLength(1);
  });
});
