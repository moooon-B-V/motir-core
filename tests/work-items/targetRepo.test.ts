import { describe, expect, it } from 'vitest';
import {
  normalizeTargetRepo,
  resolveDispatchTargetRepo,
  type ConnectedRepoName,
} from '@/lib/workItems/targetRepo';

// The PURE half of per-item repo attribution (Story 7.9 · MOTIR-1804) — input
// normalization and the dispatch fallback rule. No DB: these two functions are
// where the policy lives ("what does the CLI get told?"), so they are worth
// pinning independently of any work item. The DB-backed half (connected-set
// validation + the payload wiring) is `tests/ready/dispatchTargetRepo.test.ts`.

function repo(name: string, owner = 'moooon'): ConnectedRepoName {
  return { name, repoRef: `${owner}/${name}` };
}

describe('normalizeTargetRepo', () => {
  it('keeps a bare repo name — the form the CLI keys checkouts on', () => {
    expect(normalizeTargetRepo('motir-core')).toBe('motir-core');
  });

  it('reduces the `owner/name` ref form to the bare name', () => {
    // The GitHub surfaces + `resolveCodeContext` display `owner/name`, so an
    // agent that copies from there must land in the same state as one that
    // types the short name.
    expect(normalizeTargetRepo('moooon/motir-core')).toBe('motir-core');
  });

  it('trims surrounding whitespace on both forms', () => {
    expect(normalizeTargetRepo('  motir-ai  ')).toBe('motir-ai');
    expect(normalizeTargetRepo('  moooon/motir-ai  ')).toBe('motir-ai');
  });

  it('treats null / undefined / blank as "unpinned" (a caller never has to distinguish them)', () => {
    expect(normalizeTargetRepo(null)).toBeNull();
    expect(normalizeTargetRepo(undefined)).toBeNull();
    expect(normalizeTargetRepo('')).toBeNull();
    expect(normalizeTargetRepo('   ')).toBeNull();
  });

  it('treats a ref with an empty name half as unpinned rather than an empty pin', () => {
    expect(normalizeTargetRepo('moooon/')).toBeNull();
    expect(normalizeTargetRepo('moooon/   ')).toBeNull();
  });

  it('takes the LAST segment of a nested path (a GitLab-style group/subgroup/project)', () => {
    expect(normalizeTargetRepo('group/subgroup/motir-core')).toBe('motir-core');
  });
});

describe('resolveDispatchTargetRepo', () => {
  it('returns the explicit pin, whatever the connected set looks like', () => {
    expect(resolveDispatchTargetRepo('motir-ai', [repo('motir-core'), repo('motir-ai')])).toBe(
      'motir-ai',
    );
    // The pin wins even when it is the only connected repo (same answer, but it
    // must come from the pin, not the fallback) and even with none connected.
    expect(resolveDispatchTargetRepo('motir-core', [repo('motir-core')])).toBe('motir-core');
    expect(resolveDispatchTargetRepo('motir-core', [])).toBe('motir-core');
  });

  it("falls back to the workspace's SINGLE connected repo when the item is unpinned", () => {
    expect(resolveDispatchTargetRepo(null, [repo('motir-core')])).toBe('motir-core');
  });

  it('returns null — never a guess — when the connected set is ambiguous', () => {
    // Two or more repos and no pin: any choice would be arbitrary, and a wrong
    // one sends the agent's cwd into the wrong checkout. `null` makes the CLI
    // fall back to its link-root rule, where a human notices.
    expect(resolveDispatchTargetRepo(null, [repo('motir-core'), repo('motir-ai')])).toBeNull();
  });

  it('returns null when nothing is connected at all', () => {
    expect(resolveDispatchTargetRepo(null, [])).toBeNull();
  });
});
