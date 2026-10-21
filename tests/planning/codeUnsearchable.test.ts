import { describe, expect, it } from 'vitest';
import {
  CODE_UNSEARCHABLE_STATES,
  parseCodeUnsearchableRepos,
  readCodeUnsearchable,
} from '@/lib/planning/codeUnsearchable';

// The list of target repositories motir-ai stopped a planning phase on (Story
// MOTIR-9165 · MOTIR-9167). Total over arbitrary JSON: anything that is not a
// non-empty list of `{ repoRef, state }` with one of the six states reads as null.

const repo = { repoRef: 'acme/web', state: 'never_indexed' };

describe('parseCodeUnsearchableRepos', () => {
  it.each(CODE_UNSEARCHABLE_STATES)('accepts the state %s', (state) => {
    expect(parseCodeUnsearchableRepos([{ repoRef: 'acme/web', state }])).toEqual([
      { repoRef: 'acme/web', state },
    ]);
  });

  it('keeps every repository, in order, and trims the ref', () => {
    expect(
      parseCodeUnsearchableRepos([
        { repoRef: ' acme/web ', state: 'indexing' },
        { repoRef: 'acme/api', state: 'paused' },
      ]),
    ).toEqual([
      { repoRef: 'acme/web', state: 'indexing' },
      { repoRef: 'acme/api', state: 'paused' },
    ]);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'acme/web'],
    ['an object', repo],
    ['an empty list', []],
    ['a state outside the six', [{ repoRef: 'acme/web', state: 'stale' }]],
    ['a missing state', [{ repoRef: 'acme/web' }]],
    ['a blank ref', [{ repoRef: '  ', state: 'paused' }]],
    ['one bad entry among good ones', [repo, { repoRef: 'acme/x', state: 'nope' }]],
    ['a non-object entry', [repo, 'acme/x']],
  ])('reads %s as null', (_name, value) => {
    expect(parseCodeUnsearchableRepos(value)).toBeNull();
  });
});

describe('readCodeUnsearchable', () => {
  it('reads the list off a conversation job result', () => {
    expect(readCodeUnsearchable({ codeUnsearchable: { repos: [repo] } })).toEqual([repo]);
  });

  it.each([
    ['no signal', { turn: { report: 'x' } }],
    ['a signal with no repos', { codeUnsearchable: {} }],
    ['a signal with a bad list', { codeUnsearchable: { repos: [{ repoRef: 'a/b' }] } }],
    ['a non-object signal', { codeUnsearchable: 'yes' }],
    ['null', null],
    ['a string', 'codeUnsearchable'],
  ])('reads %s as no stop', (_name, result) => {
    expect(readCodeUnsearchable(result)).toBeNull();
  });
});
