import { describe, expect, it } from 'vitest';
import {
  asksTheDecisionQuestion,
  classifyDecisionDocuments,
  isDecisionDocumentPath,
} from '@/lib/approvalGates/decisionDocument';
import type { PullRequestFile } from '@/lib/github/pullRequestFiles';

// WHICH DECISION DOCUMENT A HEAD CARRIES — the pure classifier (MOTIR-5674;
// `approval-gates.md` §8's FIFTH AMENDMENT, clauses 3 and 10). No fixtures: the
// capture service hands it a file list, and this is every answer it can give.

const HEAD = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';

const list = (rows: PullRequestFile[], truncated = false) => ({
  paths: rows.map((row) => row.path),
  truncated,
  files: rows,
  headSha: HEAD,
});
const doc = (path: string, sha: string | null = 'blob', status = 'added'): PullRequestFile => ({
  path,
  sha,
  status,
});

describe('isDecisionDocumentPath — a markdown file DIRECTLY under docs/decisions/', () => {
  it.each([
    ['docs/decisions/pages.md', true],
    ['docs/decisions/approval-gates.md', true],
    ['docs/decisions/pages/diagram.md', false],
    ['docs/decisions/.md', false],
    ['docs/decisions/pages.mdx', false],
    ['docs/decisions-old/pages.md', false],
    ['docs/pages.md', false],
    ['lib/docs/decisions/pages.md', false],
  ])('%s → %s', (path, expected) => {
    expect(isDecisionDocumentPath(path)).toBe(expected);
  });
});

describe('classifyDecisionDocuments', () => {
  it('exactly one written document is `one`, with its path, blob sha and the head', () => {
    expect(
      classifyDecisionDocuments(list([doc('docs/decisions/pages.md', 'b1'), doc('lib/a.ts')])),
    ).toEqual({
      outcome: 'one',
      path: 'docs/decisions/pages.md',
      blobSha: 'b1',
      headSha: HEAD,
      paths: ['docs/decisions/pages.md'],
    });
  });

  it.each(['added', 'modified', 'renamed', 'copied', 'changed'])(
    'a `%s` document counts — it leaves bytes at the head',
    (status) => {
      expect(
        classifyDecisionDocuments(list([doc('docs/decisions/pages.md', 'b1', status)])).outcome,
      ).toBe('one');
    },
  );

  it('a REMOVED or UNCHANGED document is not one anybody is asked to accept', () => {
    expect(
      classifyDecisionDocuments(
        list([
          doc('docs/decisions/old.md', 'b1', 'removed'),
          doc('docs/decisions/same.md', 'b2', 'unchanged'),
        ]),
      ),
    ).toEqual({ outcome: 'none', path: null, blobSha: null, headSha: HEAD, paths: [] });
  });

  it('no document is `none`; two are `several`, and BOTH are named for the port', () => {
    expect(classifyDecisionDocuments(list([doc('lib/a.ts')])).outcome).toBe('none');
    expect(
      classifyDecisionDocuments(
        list([doc('docs/decisions/a.md'), doc('docs/decisions/b.md', 'b2', 'modified')]),
      ),
    ).toEqual({
      outcome: 'several',
      path: null,
      blobSha: null,
      headSha: HEAD,
      paths: ['docs/decisions/a.md', 'docs/decisions/b.md'],
    });
  });

  it('a list that could not be read is `unreadable`, never `none`', () => {
    expect(classifyDecisionDocuments(null)).toEqual({
      outcome: 'unreadable',
      path: null,
      blobSha: null,
      headSha: null,
      paths: [],
    });
  });

  it('a TRUNCATED list is `unreadable` even when its prefix holds one document', () => {
    expect(classifyDecisionDocuments(list([doc('docs/decisions/pages.md')], true)).outcome).toBe(
      'unreadable',
    );
  });

  it('one document the host gave no blob sha for cannot be versioned, so it is `unreadable`', () => {
    expect(classifyDecisionDocuments(list([doc('docs/decisions/pages.md', null)])).outcome).toBe(
      'unreadable',
    );
  });

  it('a row with no status never counts', () => {
    expect(
      classifyDecisionDocuments(
        list([{ path: 'docs/decisions/pages.md', sha: 'b1', status: null }]),
      ).outcome,
    ).toBe('none');
  });
});

describe('asksTheDecisionQuestion — `decision` decided by an AGENT, and nothing else', () => {
  it.each([
    [{ type: 'decision', executor: 'coding_agent' }, true],
    [{ type: 'decision', executor: 'human' }, false],
    [{ type: 'code', executor: 'coding_agent' }, false],
    [{ type: null, executor: null }, false],
  ] as const)('%o → %s', (item, expected) => {
    expect(asksTheDecisionQuestion(item as never)).toBe(expected);
  });
});
