import type { GithubRepo, ProjectRepoRole, ProjectRepoState } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { resolveRepoRoles } from '@/lib/projectRepos/roleResolution';
import { PROJECT_REPO_STATES } from '@/lib/projectRepos/vocabulary';
import type { ProjectRepoWithRealized } from '@/lib/mappers/projectRepoMappers';

// ADR §5.3's three outcomes as PURE policy (Story MOTIR-1775 · MOTIR-1913).
//
// This is where the rule can be wrong without a database noticing, so every
// branch is pinned here and the integration suite proves the WRITE, not the
// decision:
//
//   1. Exactly one established row → the realized repo's name, host casing.
//   2. No established row → null, for every non-established state, one by one.
//   3. A repeated role → null, counted over rows in ANY state — the property
//      that makes the pass order-independent.
//   4. Roles are independent of one another.

let seq = 0;

function repo(name: string, opts: { owner?: string } = {}): GithubRepo {
  seq += 1;
  return {
    id: `gh-${seq}`,
    provider: 'github',
    workspaceId: 'ws-1',
    installationId: 'inst-1',
    repoId: `host-${seq}`,
    owner: opts.owner ?? 'acme',
    name,
    defaultBranch: 'main',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as GithubRepo;
}

function row(
  role: ProjectRepoRole,
  state: ProjectRepoState,
  githubRepo: GithubRepo | null = null,
  name = 'authored',
): ProjectRepoWithRealized {
  seq += 1;
  return {
    id: `row-${seq}`,
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    role,
    label: null,
    name,
    seedSource: 'initialised',
    state,
    failureReason: null,
    proposalSignal: null,
    githubRepoId: githubRepo?.id ?? null,
    position: `a${seq}`,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    githubRepo,
  } as ProjectRepoWithRealized;
}

describe('a role that matches EXACTLY ONE established row', () => {
  it("resolves to that row's repository name — the only outcome that writes a pin", () => {
    const resolved = resolveRepoRoles([row('web', 'created', repo('acme-web'))]);
    expect(resolved.get('web')).toMatchObject({
      role: 'web',
      outcome: 'resolved',
      repoName: 'acme-web',
    });
  });

  it('resolves a CONNECTED row too — an adopted repo is as established as a created one', () => {
    // `ESTABLISHED_PROJECT_REPO_STATES` is both states; a monorepo collapses the
    // set to one `connected` row and must still pin.
    const resolved = resolveRepoRoles([row('web', 'connected', repo('acme'))]);
    expect(resolved.get('web')?.outcome).toBe('resolved');
    expect(resolved.get('web')?.repoName).toBe('acme');
  });

  it("prefers the REALIZED repo name over the row's authored one", () => {
    // The host's spelling is what `work_item.targetRepo` stores and what the CLI
    // keys `<root>/<name>` on; the two diverge as soon as a repo is renamed on the
    // host, and the authored intent then names no checkout.
    const resolved = resolveRepoRoles([row('api', 'created', repo('Acme-API'), 'acme-api')]);
    expect(resolved.get('api')?.repoName).toBe('Acme-API');
  });

  it('resolves each role INDEPENDENTLY — a two-repo project pins both halves', () => {
    const resolved = resolveRepoRoles([
      row('web', 'created', repo('acme-web')),
      row('api', 'created', repo('acme-api')),
    ]);
    expect(resolved.get('web')?.repoName).toBe('acme-web');
    expect(resolved.get('api')?.repoName).toBe('acme-api');
  });

  it('does NOT collapse two roles whose realized repos share a bare NAME', () => {
    // The dispatch-domain de-duplication in `toProjectRepoNames` would drop one of
    // these; resolution asks a per-ROW question, so both repositories still exist
    // and both roles still resolve. Deliberately not reusing that helper is what
    // keeps this true.
    const resolved = resolveRepoRoles([
      row('web', 'created', repo('platform', { owner: 'acme' })),
      row('api', 'created', repo('platform', { owner: 'acme-services' })),
    ]);
    expect(resolved.get('web')?.outcome).toBe('resolved');
    expect(resolved.get('api')?.outcome).toBe('resolved');
  });
});

describe('a role that matches NO established row', () => {
  it.each(PROJECT_REPO_STATES.filter((s) => s !== 'created' && s !== 'connected'))(
    'resolves to null for a %s row — honestly unrouted, not a failure',
    (state) => {
      const resolved = resolveRepoRoles([row('web', state)]);
      expect(resolved.get('web')).toMatchObject({ outcome: 'unestablished', repoName: null });
    },
  );

  it('resolves to null when the row is `created` but its mirror row is GONE', () => {
    // A deleted `GithubRepo` leaves the set row's state intact (the shipped delete
    // contract), so the state alone does not prove a checkout exists.
    const resolved = resolveRepoRoles([row('web', 'created', null)]);
    expect(resolved.get('web')?.outcome).toBe('unestablished');
  });

  it('reports nothing at all for a role the set never mentions', () => {
    expect(resolveRepoRoles([row('web', 'created', repo('acme-web'))]).get('api')).toBeUndefined();
  });

  it('resolves an EMPTY set to no roles — the project that never ran the step', () => {
    expect(resolveRepoRoles([]).size).toBe(0);
  });
});

describe('a REPEATED role (ADR §1.2)', () => {
  it('resolves to null and names the rows that caused it — never an arbitrary pick', () => {
    const rows = [
      row('api', 'created', repo('acme-api-billing')),
      row('api', 'created', repo('acme-api-search')),
    ];
    const resolved = resolveRepoRoles(rows);
    expect(resolved.get('api')).toMatchObject({ outcome: 'ambiguous', repoName: null });
    // The evidence travels with the verdict, so the refusal is explainable.
    expect(resolved.get('api')?.rowIds).toEqual([rows[0]!.id, rows[1]!.id]);
  });

  it('is ambiguous even when only ONE of the two rows is established', () => {
    // The literal §5.3 reading ("exactly one ESTABLISHED row") would pin here, and
    // that is the guess the ADR forbids: the plan pinned items to "api", half of
    // them belong to the row that was skipped, and sending those into its sibling's
    // checkout is strictly worse than no answer.
    const resolved = resolveRepoRoles([
      row('api', 'created', repo('acme-api-billing')),
      row('api', 'skipped'),
    ]);
    expect(resolved.get('api')?.outcome).toBe('ambiguous');
  });

  it('is ambiguous BEFORE anything is created — the verdict is a property of the SET', () => {
    // This is what makes the resolution order-independent: it cannot pin to row 1
    // while row 2 is still `creating` and then change its mind once row 2 lands.
    const resolved = resolveRepoRoles([row('api', 'proposed'), row('api', 'proposed')]);
    expect(resolved.get('api')?.outcome).toBe('ambiguous');
  });

  it("leaves the project's OTHER roles resolvable", () => {
    const resolved = resolveRepoRoles([
      row('web', 'created', repo('acme-web')),
      row('api', 'created', repo('acme-api-billing')),
      row('api', 'created', repo('acme-api-search')),
    ]);
    expect(resolved.get('web')?.outcome).toBe('resolved');
    expect(resolved.get('api')?.outcome).toBe('ambiguous');
  });
});
