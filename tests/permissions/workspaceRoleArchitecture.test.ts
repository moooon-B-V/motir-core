import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripSourceComments } from '../helpers/stripSourceComments';

// THE STORY GATE's architecture guards (Story MOTIR-6168 · MOTIR-6467) —
// properties of the CODEBASE that no run of the product can see, each a rule a
// later card could break while passing every test it wrote for itself:
//
//   1. THE RESOLVER IS BLIND TO PROJECT ROLES. `lib/permissions/resolve.ts`
//      imports nothing from the project-membership repository or the project
//      role types — a role is read from the workspace, and the one fact a
//      project still holds (was this person added?) arrives as a boolean.
//   2. NOTHING READS OR WRITES THE RETIRED STORAGE (widened by Story MOTIR-6469 ·
//      MOTIR-6563). No production file under `lib/`, `app/` or `scripts/`
//      (minus `scripts/plan-seed/data/`, historical seed prose):
//        * reads or writes `workspace_membership.role`, `project_membership.role`
//          or `project_membership.role_definition_id` — a Prisma key in any call
//          on those models (`data` / `where` / `select` / `orderBy` / `by`), a
//          nested `workspaceMemberships` / `projectMemberships` block, a field
//          read off a row, or raw SQL naming the column;
//        * imports `MemberRole` from the generated client;
//        * reaches the `projectRoleDefinition` client accessor.
//      The columns keep their database default until the phase-3 DROP; only the
//      migrations and the Prisma schema still name them, outside these trees.
//   3. ONE WRITER OF THE WORKSPACE ROLE. Every write of `workspaceRole` goes
//      through `workspaceMembershipRepository.setWorkspaceRole` — or is the
//      membership's creation, which sets its first role. A second writer is a
//      second place the last-Manager guard and the org-managed refusal can be
//      skipped.
//
// Each scanner is proven to FIRE on a planted violation below, so a green run is
// a finding, not a scanner that matches nothing.

const ROOT = process.cwd();

function sourcesUnder(dir: string, exclude: readonly string[] = []): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(d, name);
      if (exclude.includes(relative(ROOT, p))) continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
  };
  walk(join(ROOT, dir));
  return out;
}

const PRODUCTION = [
  ...sourcesUnder('lib'),
  ...sourcesUnder('app'),
  ...sourcesUnder('scripts', ['scripts/plan-seed/data']),
].map((abs) => ({
  file: relative(ROOT, abs),
  src: stripSourceComments(readFileSync(abs, 'utf8')),
}));

/** The balanced `(…)` argument text starting at `open` (an index of `(`). */
function balancedArgs(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

// ── 1. the resolver's imports ────────────────────────────────────────────────

const FORBIDDEN_RESOLVER_IMPORT =
  /from\s+'@\/lib\/(repositories\/projectMembershipRepository|projects\/roles)'|\b(ProjectRole|ProjectMembership|MemberRole)\b/;

function resolverViolations(src: string): string[] {
  return (
    src
      .split('\n')
      .filter((line) => /^\s*import\b|^\s*\}?\s*from\s+'/.test(line) || /^\s+\w+,?$/.test(line))
      .join('\n')
      .match(/import[\s\S]*?from\s+'[^']+';/g)
      ?.filter((stmt) => FORBIDDEN_RESOLVER_IMPORT.test(stmt)) ?? []
  );
}

// ── 2. the retired role storage, read or written ─────────────────────────────

// A key naming a retired column, anywhere in a call's argument text: an object
// key (`role:`), or a `groupBy` column list (`by: ['role']`).
const LEGACY_PM_KEY =
  /\b(role|roleDefinitionId|roleDefinition)\s*:|\bby\s*:\s*\[[^\]]*['"](role|roleDefinitionId)['"]/;
const LEGACY_WM_KEY = /\brole\s*:|\bby\s*:\s*\[[^\]]*['"]role['"]/;

function retiredStorageUses(file: string, src: string): string[] {
  const hits: string[] = [];
  const calls: [RegExp, RegExp, string][] = [
    [/\.projectMembership\.(\w+)\s*\(/g, LEGACY_PM_KEY, 'projectMembership'],
    [/\.workspaceMembership\.(\w+)\s*\(/g, LEGACY_WM_KEY, 'workspaceMembership'],
  ];
  for (const [call, key, model] of calls) {
    for (const m of src.matchAll(call)) {
      const args = balancedArgs(src, m.index! + m[0].length - 1);
      if (key.test(args)) hits.push(`${file}: ${model}.${m[1]} names a retired role column`);
    }
  }
  // A nested read or write through the relation: `projectMemberships: { … role … }`.
  const nested: [RegExp, RegExp][] = [
    [/\bprojectMemberships\s*:\s*\{/g, LEGACY_PM_KEY],
    [/\bworkspaceMemberships\s*:\s*\{/g, LEGACY_WM_KEY],
  ];
  for (const [rel, key] of nested) {
    for (const m of src.matchAll(rel)) {
      const block = balancedArgs(src, m.index! + m[0].length - 1);
      if (key.test(block)) hits.push(`${file}: a nested ${m[0].split(':')[0]} block names a role`);
    }
  }
  // A field read off a row, or its type.
  for (const m of src.matchAll(
    /\b(projectMembership|workspaceMembership)\??\.role\b|\bprojectMembership\??\.roleDefinitionId\b|\b(ProjectMembership|WorkspaceMembership)\[['"]role['"]\]|\bProjectMembership\[['"]roleDefinitionId['"]\]/g,
  )) {
    hits.push(`${file}: reads ${m[0]}`);
  }
  // Raw SQL naming the columns on either membership table.
  for (const m of src.matchAll(/\b(project|workspace)_membership\b/g)) {
    // The statement around the table name — a column can be named before it (SELECT … FROM).
    const window = src.slice(Math.max(0, m.index! - 400), m.index! + 400);
    const column =
      m[1] === 'project'
        ? /\brole_definition_id\b|\bpm"?\."?role\b|project_membership"?\."?role\b/
        : // `wm.role`, a qualified `workspace_membership.role`, or a bare `"role"` in
          // a column list / SET (`workspace_role` is the live column and never matches).
          /\bwm"?\."?role\b|workspace_membership"?\."?"?role\b|(?<![\w"])"role"(?=\s*[,)=])|\bSET\s+role\s*=/i;
    const hit = `${file}: raw SQL names a ${m[1]}_membership role column`;
    if (column.test(window) && !hits.includes(hit)) hits.push(hit);
  }
  // The generated enum, imported or reached through a namespace.
  const imports = src.match(/import[^;]*\bMemberRole\b[^;]*from\s+'@\/generated\/prisma[^']*'/g);
  for (let i = 0; i < (imports?.length ?? 0); i++) {
    hits.push(`${file}: imports MemberRole from the generated client`);
  }
  for (const m of src.matchAll(/\b(Prisma|\$Enums)\.MemberRole\b/g)) hits.push(`${file}: ${m[0]}`);
  // The retired table's client accessor.
  for (const m of src.matchAll(/\.projectRoleDefinition\b/g)) hits.push(`${file}: ${m[0]}`);
  return hits;
}

// ── 3. writers of the workspace role ─────────────────────────────────────────

const WRITE_METHODS = /\.workspaceMembership\.(create|createMany|update|updateMany|upsert)\s*\(/g;
const REPO = 'lib/repositories/workspaceMembershipRepository.ts';

/** The repository method a character offset sits inside (`  async name(`). */
function enclosingMethod(src: string, at: number): string {
  const before = src.slice(0, at);
  const all = [...before.matchAll(/^\s{2}async\s+(\w+)\s*\(/gm)];
  return all.at(-1)?.[1] ?? '<top level>';
}

function workspaceRoleWriters(file: string, src: string): string[] {
  const hits: string[] = [];
  for (const m of src.matchAll(WRITE_METHODS)) {
    const where = file === REPO ? `${file}#${enclosingMethod(src, m.index!)}` : `${file} (${m[1]})`;
    const args = balancedArgs(src, m.index! + m[0].length - 1);
    // Outside the repository, ANY membership write is a second writer (and a layering breach).
    // Inside it, a write that names `workspaceRole` — or passes a caller-built `data` through —
    // is a writer of the role.
    if (file !== REPO || /\bworkspaceRole\b|\{\s*data\s*\}|data\s*:\s*data\b/.test(args)) {
      hits.push(where);
    }
  }
  for (const m of src.matchAll(/(UPDATE|INSERT\s+INTO)\s+"?workspace_membership"?/gi)) {
    const window = src.slice(m.index!, m.index! + 400);
    if (/workspace_role/.test(window)) hits.push(`${file}: raw SQL writes workspace_role`);
  }
  return hits;
}

/** The two sanctioned writers: the role change, and the membership's creation (its first role). */
const SANCTIONED_WRITERS = [`${REPO}#create`, `${REPO}#setWorkspaceRole`];

describe('workspace-role architecture guards', () => {
  it('1 · lib/permissions/resolve.ts imports nothing from project membership or project roles', () => {
    const src = stripSourceComments(readFileSync(join(ROOT, 'lib/permissions/resolve.ts'), 'utf8'));
    expect(resolverViolations(src)).toEqual([]);
  });

  it('1 · …and the scanner fires on a planted import', () => {
    const planted = [
      "import type { ProjectAccessMode } from '@/generated/prisma/client';",
      "import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';",
      "import type { ProjectRole } from '@/lib/projects/roles';",
    ].join('\n');
    expect(resolverViolations(planted)).toHaveLength(2);
  });

  it('2 · no production file under lib/, app/ or scripts/ reads or writes the retired role storage', () => {
    expect(PRODUCTION.flatMap(({ file, src }) => retiredStorageUses(file, src))).toEqual([]);
  });

  it('2 · …over the tree it claims: scripts/ is scanned, its historical seed prose is not', () => {
    const files = PRODUCTION.map(({ file }) => file);
    expect(files).toContain('scripts/plan-seed/systemPrincipal.ts');
    expect(files).toContain('lib/services/workspaceInvitesService.ts');
    expect(files.filter((f) => f.startsWith('scripts/plan-seed/data/'))).toEqual([]);
  });

  it('2 · …and the scanner fires on each planted shape', () => {
    const shapes = [
      // project_membership.role / role_definition_id — read
      'tx.projectMembership.findMany({ where: { projectId }, select: { role: true } })',
      'db.projectMembership.count({ where: { roleDefinitionId: id } })',
      "tx.projectMembership.groupBy({ by: ['role'], _count: true })",
      'tx.user.findMany({ include: { projectMemberships: { select: { role: true } } } })',
      "if (row.projectMembership?.role === 'admin') {}",
      'type R = ProjectMembership["roleDefinitionId"];',
      'tx.$queryRaw`SELECT pm.role FROM project_membership pm`',
      // …and written
      "tx.projectMembership.create({ data: { projectId, userId, role: 'member' } })",
      'tx.projectMembership.update({ where, data: { roleDefinitionId: null } })',
      // workspace_membership.role — read and written
      "tx.workspaceMembership.findFirst({ where: { workspaceId, role: 'owner' } })",
      "tx.workspaceMembership.create({ data: { userId, workspaceId, workspaceRole: 'member', role: 'member' } })",
      "tx.workspaceMembership.groupBy({ by: ['role'], _count: true })",
      "tx.user.findMany({ include: { workspaceMemberships: { where: { role: 'owner' } } } })",
      'const r = row.workspaceMembership.role;',
      "type W = WorkspaceMembership['role'];",
      'tx.$queryRaw`SELECT wm."role" FROM "workspace_membership" wm`',
      'tx.$executeRaw`UPDATE "workspace_membership" SET "role" = \'member\'`',
      'tx.$executeRaw`INSERT INTO "workspace_membership" ("id", "userId", "role") VALUES (1, 2, 3)`',
      // the enum and the retired table
      "import type { MemberRole } from '@/generated/prisma/client';",
      "import { Prisma, type MemberRole, type User } from '@/generated/prisma/client';",
      'const r: Prisma.MemberRole = x;',
      'await tx.projectRoleDefinition.findMany();',
    ];
    for (const s of shapes) expect(retiredStorageUses('planted.ts', s), s).toHaveLength(1);
    // The workspace role, the workspace custom-role pointer and the org role are not retired.
    for (const ok of [
      "tx.workspaceMembership.create({ data: { userId, workspaceId, workspaceRole: 'member' } })",
      'tx.workspaceMembership.update({ where, data: { workspaceRole: r, roleDefinitionId: id } })',
      'tx.projectMembership.create({ data: { workspaceId, projectId, userId } })',
      "tx.organizationMembership.findMany({ where: { role: 'owner' } })",
      'tx.$executeRaw`UPDATE "workspace_membership" SET "workspace_role" = \'member\'`',
      "type L = 'owner' | 'admin' | 'member' | 'viewer'; // a local LegacyMemberRole",
    ]) {
      expect(retiredStorageUses('ok.ts', ok), ok).toEqual([]);
    }
  });

  it('3 · every workspace-role write goes through setWorkspaceRole (or is the membership’s creation)', () => {
    // `lib/` and `app/` only: the seed scripts write memberships directly (their
    // active project), and guard 3 is the product's one-writer rule.
    const writers = PRODUCTION.filter(({ file }) => !file.startsWith('scripts/')).flatMap(
      ({ file, src }) => workspaceRoleWriters(file, src),
    );
    expect(writers.sort()).toEqual([...SANCTIONED_WRITERS].sort());
  });

  it('3 · …and the scanner fires on a planted second writer, in a service and in the repository', () => {
    expect(
      workspaceRoleWriters(
        'lib/services/rogue.ts',
        "await tx.workspaceMembership.update({ where, data: { workspaceRole: 'manager' } });",
      ),
    ).toEqual(['lib/services/rogue.ts (update)']);
    expect(
      workspaceRoleWriters(
        REPO,
        "  async promote(u, w, tx) {\n    return tx.workspaceMembership.updateMany({ where: { u }, data: { workspaceRole: 'manager' } });\n  },",
      ),
    ).toEqual([`${REPO}#promote`]);
    expect(
      workspaceRoleWriters(
        'lib/services/rogueSql.ts',
        "tx.$executeRaw`UPDATE workspace_membership SET workspace_role = 'manager'`",
      ),
    ).toEqual(['lib/services/rogueSql.ts: raw SQL writes workspace_role']);
  });
});
