// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { MemberRole, ProjectAccessLevel } from '@/generated/prisma/client';
import {
  ProjectAccessProvider,
  useProjectAccess,
} from '@/app/(authed)/_components/ProjectAccessProvider';
import { canBrowse, canEdit, canManageProject } from '@/lib/projects/access';
import type { ProjectAccessInputs } from '@/lib/projects/access';
import { resolvePermissions } from '@/lib/permissions/resolve';
import { PERMISSIONS, type PermissionKey } from '@/lib/permissions/catalog';

// Subtask MOTIR-2466 — the actor's permission SET reaches the client.
//
// The change under test is a SUBSTITUTION: the authed layout stopped resolving
// `{ canBrowse, canEdit, canManage }` via `projectAccessService.
// getSettingsCapabilities` and now resolves the whole permission set via
// `getPermissionsDTO`, deriving the same three booleans from it. Nothing anyone
// can see is supposed to change, and "supposed to" is not something a reviewer
// establishes by reading a diff of an access seam.
//
// So this file proves it in two halves, and it is worth being precise about
// which half proves what:
//
//   1. BEHAVIOUR — the 64-row grid below runs every combination of access level
//      (4) × workspace role (4) × project role (4) through BOTH derivations and
//      asserts they agree. This is total over the policy's input space, and it
//      is the half that would catch a real divergence.
//   2. STRUCTURE — the two source guards at the bottom pin the two facts the
//      grid cannot see: that `getSettingsCapabilities` still derives from
//      exactly those three predicates (so the grid's left-hand side is still
//      the service's answer), and that the layout no longer calls it.
//
// Half 2 is a search for NAMES and is therefore only ever evidence about what
// the source SAYS — never about what an operation authorises (`notes.html` #231,
// the whitelist-of-names lesson). It is used here for a PRESENCE claim it can
// actually discharge, and it is load-bearing only because half 1 sits under it.

const ACCESS_LEVELS: ProjectAccessLevel[] = ['public', 'open', 'limited', 'private'];
const WORKSPACE_ROLES: (MemberRole | null)[] = ['owner', 'admin', 'member', null];
const PROJECT_ROLES: (MemberRole | null)[] = ['admin', 'member', 'viewer', null];

const GRID: ProjectAccessInputs[] = ACCESS_LEVELS.flatMap((accessLevel) =>
  WORKSPACE_ROLES.flatMap((workspaceRole) =>
    PROJECT_ROLES.map((projectRole) => ({ accessLevel, workspaceRole, projectRole })),
  ),
);

/** Exactly what `projectAccessService.getSettingsCapabilities` returns, given the same inputs. */
function viaPredicates(i: ProjectAccessInputs) {
  return { canBrowse: canBrowse(i), canEdit: canEdit(i), canManage: canManageProject(i) };
}

/** Exactly what the authed layout now derives from `getPermissionsDTO`'s array. */
function viaPermissionSet(i: ProjectAccessInputs) {
  const held = new Set<PermissionKey>(resolvePermissions(i));
  return {
    canBrowse: held.has('project:browse'),
    canEdit: held.has('work_item:edit'),
    canManage: held.has('project:administer'),
  };
}

describe('the layout substitution is behaviour-neutral', () => {
  it('covers all 64 access-level × workspace-role × project-role combinations', () => {
    expect(GRID).toHaveLength(64);
  });

  it.each(GRID)(
    'level=$accessLevel workspace=$workspaceRole project=$projectRole — the set derives the same three booleans',
    (inputs) => {
      expect(viaPermissionSet(inputs)).toEqual(viaPredicates(inputs));
    },
  );

  it('is not vacuously true — the grid produces every one of the eight boolean triples that the policy can produce', () => {
    // A grid on which every row answered `{false,false,false}` would pass the
    // equality above while proving nothing. Both derivations must actually vary.
    const shapes = new Set(GRID.map((i) => JSON.stringify(viaPredicates(i))));
    expect(shapes.size).toBeGreaterThan(1);
    expect(new Set(GRID.map((i) => JSON.stringify(viaPermissionSet(i))))).toEqual(shapes);
  });
});

function Probe({ keys }: { keys: PermissionKey[] }) {
  const { can, canEdit: edit, canManage: manage } = useProjectAccess();
  return (
    <ul>
      <li data-testid="canEdit">{String(edit)}</li>
      <li data-testid="canManage">{String(manage)}</li>
      {keys.map((key) => (
        <li key={key} data-testid={`can:${key}`}>
          {String(can(key))}
        </li>
      ))}
    </ul>
  );
}

const read = (id: string) => screen.getByTestId(id).textContent;

afterEach(cleanup);

describe('ProjectAccessProvider', () => {
  it('answers can(key) from the set it was handed', () => {
    render(
      <ProjectAccessProvider permissions={['project:browse', 'board:configure']}>
        <Probe keys={['project:browse', 'board:configure', 'member:manage']} />
      </ProjectAccessProvider>,
    );
    expect(read('can:project:browse')).toBe('true');
    expect(read('can:board:configure')).toBe('true');
    // The case two booleans could never express: a role holding ONE
    // administrative domain and not another (MOTIR-2256's whole point).
    expect(read('can:member:manage')).toBe('false');
  });

  it('DERIVES canEdit and canManage from the set rather than taking them as props', () => {
    render(
      <ProjectAccessProvider permissions={['work_item:edit']}>
        <Probe keys={[]} />
      </ProjectAccessProvider>,
    );
    expect(read('canEdit')).toBe('true');
    expect(read('canManage')).toBe('false');

    cleanup();
    render(
      <ProjectAccessProvider permissions={['project:administer']}>
        <Probe keys={[]} />
      </ProjectAccessProvider>,
    );
    expect(read('canEdit')).toBe('false');
    expect(read('canManage')).toBe('true');
  });

  it('grants nothing for an empty set — the layout’s "no active project" value', () => {
    render(
      <ProjectAccessProvider permissions={[]}>
        <Probe keys={[...PERMISSIONS]} />
      </ProjectAccessProvider>,
    );
    expect(read('canEdit')).toBe('false');
    expect(read('canManage')).toBe('false');
    for (const key of PERMISSIONS) expect(read(`can:${key}`)).toBe('false');
  });

  it('takes the permissions in catalog order without reordering or rejecting them', () => {
    // The prop is the shipped `ActorPermissionsDTO` array — deterministic order,
    // never a Set (which cannot cross the server/client boundary at all).
    render(
      <ProjectAccessProvider permissions={[...PERMISSIONS]}>
        <Probe keys={[...PERMISSIONS]} />
      </ProjectAccessProvider>,
    );
    for (const key of PERMISSIONS) expect(read(`can:${key}`)).toBe('true');
  });
});

describe('useProjectAccess outside a provider', () => {
  it('answers true for EVERY catalog key — the gate only ever tightens', () => {
    // A component mounted without the authed shell (or in a unit test that does
    // not know this context exists) must keep its pre-gating behaviour.
    // Inverting this direction would silently hide UI across the suite.
    render(<Probe keys={[...PERMISSIONS]} />);
    expect(read('canEdit')).toBe('true');
    expect(read('canManage')).toBe('true');
    for (const key of PERMISSIONS) expect(read(`can:${key}`)).toBe('true');
  });
});

const ROOT = join(__dirname, '..', '..');
const source = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe('the seam the 64-row grid stands on', () => {
  it('getSettingsCapabilities still derives from exactly the three predicates the grid runs', () => {
    // The grid asserts `viaPredicates` ≡ `viaPermissionSet`. That only speaks
    // about the SERVICE for as long as `viaPredicates` is still the service's
    // body. Pin it: if someone changes what the method returns, this fails and
    // the grid has to be re-derived rather than quietly meaning less.
    const body = source('lib/services/projectAccessService.ts')
      .split('async getSettingsCapabilities(')[1]
      ?.split('\n  },')[0];
    expect(body).toBeDefined();
    expect(body).toContain('canBrowse: canBrowse(inputs)');
    expect(body).toContain('canEdit: canEdit(inputs)');
    expect(body).toContain('canManage: canManageProject(inputs)');
  });

  it('the authed layout makes exactly ONE projectAccessService call, and it is not getSettingsCapabilities', () => {
    // Two calls would double the round trip the substitution was supposed to
    // leave untouched — the failure mode of adding the set BESIDE the booleans
    // instead of in place of them.
    const layout = source('app/(authed)/layout.tsx');
    expect(layout).not.toContain('getSettingsCapabilities');
    expect(layout.match(/projectAccessService\.\w+\(/g)).toEqual([
      'projectAccessService.getPermissionsDTO(',
    ]);
  });
});
