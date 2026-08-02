import { describe, expect, it } from 'vitest';
import {
  matchAuthoredTargetRepo,
  normalizeTargetRepo,
  resolveDispatchRepo,
  resolveDispatchTargetRepo,
  type ConnectedRepoName,
} from '@/lib/workItems/targetRepo';
import { ArchivedTargetRepoError, UnknownTargetRepoError } from '@/lib/workItems/errors';
import { repoCloneUrl } from '@/lib/repos/cloneUrl';

// The PURE half of per-item repo attribution (Story 7.9 · MOTIR-1804; the repo
// coordinates + scope-free matcher, MOTIR-1783) — input normalization, the
// dispatch fallback rule, and the clone-URL derivation. No DB: these functions
// are where the policy lives ("what does the CLI get told?"), so they are worth
// pinning independently of any work item. The DB-backed half (domain resolution
// + the payload wiring) is `tests/ready/dispatchTargetRepo.test.ts` and
// `tests/ready/projectScopedDispatchRepo.test.ts`.

function repo(name: string, owner = 'moooon'): ConnectedRepoName {
  return {
    name,
    repoRef: `${owner}/${name}`,
    cloneUrl: `https://github.com/${owner}/${name}.git`,
    defaultBranch: 'main',
    archived: false,
  };
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

describe('resolveDispatchRepo — the name PLUS how to obtain it (MOTIR-1783)', () => {
  it('carries the clone URL + default branch of the repo it resolved to', () => {
    expect(resolveDispatchRepo(null, [repo('motir-core')])).toEqual({
      name: 'motir-core',
      cloneUrl: 'https://github.com/moooon/motir-core.git',
      defaultBranch: 'main',
    });
  });

  it('matches a PIN to its coordinates case-insensitively', () => {
    // The stored pin carries the host's casing, but a domain re-read after a
    // host-side rename can differ; the checkout identity is the same either way.
    const resolved = resolveDispatchRepo('MOTIR-CORE', [repo('motir-core')]);
    expect(resolved?.cloneUrl).toBe('https://github.com/moooon/motir-core.git');
    // The NAME is the pin as recorded — resolution reports the decision, it does
    // not silently rewrite it.
    expect(resolved?.name).toBe('MOTIR-CORE');
  });

  it('echoes a pin the domain does not contain, with NULL coordinates', () => {
    // The pinned-but-unrealized case: the set row exists as a plan, so the
    // routing decision stands, but there is no repository to clone yet. Claiming
    // a URL here would send an agent to a 404.
    expect(resolveDispatchRepo('api-service', [repo('motir-core')])).toEqual({
      name: 'api-service',
      cloneUrl: null,
      defaultBranch: null,
    });
    expect(resolveDispatchRepo('api-service', [])).toEqual({
      name: 'api-service',
      cloneUrl: null,
      defaultBranch: null,
    });
  });

  it('resolves to null — no name, no coordinates — on an ambiguous or empty domain', () => {
    expect(resolveDispatchRepo(null, [repo('a'), repo('b')])).toBeNull();
    expect(resolveDispatchRepo(null, [])).toBeNull();
  });
});

// The ARCHIVED guard (MOTIR-1959) — the one place a dispatch resolution REFUSES
// rather than answering. Pinned here because this is the policy: the DB-backed
// proof that a real dispatch hits it is `tests/ready/projectScopedDispatchRepo.test.ts`.
describe('resolveDispatchRepo — an ARCHIVED repository (MOTIR-1959)', () => {
  const archived = (name: string, owner = 'moooon'): ConnectedRepoName => ({
    ...repo(name, owner),
    archived: true,
  });

  it('THROWS for an explicit pin naming an archived repo — before any branch or PR attempt', () => {
    // The failure has to arrive as a stated reason, not as a degraded answer: an
    // archived repository is read-only, so the dispatch this call authorizes could
    // never open a PR however the agent behaves.
    expect(() => resolveDispatchRepo('motir-core', [archived('motir-core')])).toThrow(
      ArchivedTargetRepoError,
    );
  });

  it('names the REPOSITORY and states the REASON — the two things the reader acts on', () => {
    // The fix is on the host and nothing Motir does next substitutes for it, so an
    // error that only says "cannot dispatch" leaves the reader with nothing to do.
    try {
      resolveDispatchRepo('motir-core', [archived('motir-core', 'acme')]);
      expect.unreachable('an archived target must not resolve');
    } catch (err) {
      expect(err).toBeInstanceOf(ArchivedTargetRepoError);
      expect((err as Error).message).toContain('motir-core');
      expect((err as Error).message).toContain('acme/motir-core');
      expect((err as Error).message).toContain('archived');
    }
  });

  it('THROWS for the single-repo DEFAULT too — a project whose only repo is archived', () => {
    // How the repo was chosen differs; what is wrong with it does not. Left as a
    // silent `null`, this case would read to the CLI as "no repos configured" and
    // fall back to the link root — an agent working where it cannot push.
    expect(() => resolveDispatchRepo(null, [archived('motir-core')])).toThrow(
      ArchivedTargetRepoError,
    );
  });

  it('matches the pin CASE-INSENSITIVELY, exactly as the resolving branch does', () => {
    // A guard that only fired on an exact-case pin would be trivially escapable,
    // and case is not a distinction anywhere else in this module.
    expect(() => resolveDispatchRepo('MOTIR-CORE', [archived('motir-core')])).toThrow(
      ArchivedTargetRepoError,
    );
  });

  it('leaves every LIVE resolution untouched — the guard costs the ordinary case nothing', () => {
    expect(resolveDispatchRepo('motir-core', [repo('motir-core')])).toMatchObject({
      name: 'motir-core',
    });
    expect(resolveDispatchRepo(null, [repo('motir-core')])).toMatchObject({ name: 'motir-core' });
    // A LIVE sibling is not poisoned by an archived entry in the same domain: with
    // two entries there is no single-repo default, and the pin picks the live one.
    expect(resolveDispatchRepo('live', [archived('dead'), repo('live')])).toMatchObject({
      name: 'live',
    });
  });

  it('does NOT throw for a pin the domain does not contain at all', () => {
    // An unknown pin is the shipped "Motir does not know where this lives" case
    // (a plan-only row, a repo disconnected after the pin). Nothing says it is
    // archived, and claiming so would be a guess in the opposite direction.
    expect(resolveDispatchRepo('api-service', [archived('motir-core')])).toEqual({
      name: 'api-service',
      cloneUrl: null,
      defaultBranch: null,
    });
  });
});

describe('matchAuthoredTargetRepo — the scope-free validation policy', () => {
  it("accepts a name in the domain and stores the DOMAIN's casing", () => {
    expect(matchAuthoredTargetRepo('motir-core', [repo('Motir-Core')])).toBe('Motir-Core');
    expect(matchAuthoredTargetRepo('moooon/motir-core', [repo('motir-core')])).toBe('motir-core');
  });

  it('treats a blank / null pin as unpinned without consulting the domain', () => {
    expect(matchAuthoredTargetRepo(null, [])).toBeNull();
    expect(matchAuthoredTargetRepo('   ', [])).toBeNull();
  });

  it('reports the WORKSPACE scope by default and the PROJECT scope on request', () => {
    // The message is the whole value of this error: told the wrong set, the
    // author corrects the wrong thing.
    expect(() => matchAuthoredTargetRepo('nope', [repo('motir-core')])).toThrow(
      /Connected repositories: moooon\/motir-core/,
    );
    expect(() => matchAuthoredTargetRepo('nope', [repo('motir-core')], 'project')).toThrow(
      /This project's repositories: moooon\/motir-core/,
    );
    expect(() => matchAuthoredTargetRepo('nope', [], 'project')).toThrow(
      /this project's repository set is empty/,
    );
    expect(() => matchAuthoredTargetRepo('nope', [])).toThrow(/no connected repositories/);
    expect(() => matchAuthoredTargetRepo('nope', [])).toThrow(UnknownTargetRepoError);
  });
});

describe('repoCloneUrl', () => {
  it('derives the GitHub HTTPS clone URL from the mirror row coordinates', () => {
    expect(repoCloneUrl({ provider: 'github', owner: 'moooon', name: 'motir-core' })).toBe(
      'https://github.com/moooon/motir-core.git',
    );
  });

  it('addresses the CONFIGURED GitLab instance, not gitlab.com, when one is set', () => {
    const previous = process.env['GITLAB_BASE_URL'];
    try {
      delete process.env['GITLAB_BASE_URL'];
      expect(repoCloneUrl({ provider: 'gitlab', owner: 'acme', name: 'widgets' })).toBe(
        'https://gitlab.com/acme/widgets.git',
      );
      // A self-managed instance — the URL must follow the deployment, which is
      // exactly why this is derived at read time rather than stored.
      process.env['GITLAB_BASE_URL'] = 'https://git.acme.test/';
      expect(repoCloneUrl({ provider: 'gitlab', owner: 'acme', name: 'widgets' })).toBe(
        'https://git.acme.test/acme/widgets.git',
      );
    } finally {
      if (previous === undefined) delete process.env['GITLAB_BASE_URL'];
      else process.env['GITLAB_BASE_URL'] = previous;
    }
  });

  it('returns null for a provider this build cannot address, or blank coordinates', () => {
    expect(repoCloneUrl({ provider: 'bitbucket', owner: 'acme', name: 'widgets' })).toBeNull();
    expect(repoCloneUrl({ provider: 'github', owner: '  ', name: 'widgets' })).toBeNull();
    expect(repoCloneUrl({ provider: 'github', owner: 'acme', name: '' })).toBeNull();
  });
});
