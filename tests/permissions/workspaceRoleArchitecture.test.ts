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
//   2. NOTHING READS THE RETIRED COLUMNS. No production file under `lib/` or
//      `app/` reads `project_membership.role` or `.role_definition_id`: they are
//      still WRITTEN (the column is NOT NULL until the contract story drops it)
//      and read only by the two migrations and the Prisma schema, which live
//      outside the scanned trees.
//   3. ONE WRITER OF THE WORKSPACE ROLE. Every write of `workspaceRole` goes
//      through `workspaceMembershipRepository.setWorkspaceRole` — or is the
//      membership's creation, which sets its first role. A second writer is a
//      second place the last-Manager guard and the org-managed refusal can be
//      skipped.
//
// Each scanner is proven to FIRE on a planted violation below, so a green run is
// a finding, not a scanner that matches nothing.

const ROOT = process.cwd();

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
  };
  walk(join(ROOT, dir));
  return out;
}

const PRODUCTION = [...sourcesUnder('lib'), ...sourcesUnder('app')].map((abs) => ({
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

// ── 2. reads of the retired project-role columns ─────────────────────────────

const READ_METHODS = /\.projectMembership\.(find\w*|count|groupBy|aggregate)\s*\(/g;
const ROLE_KEY = /\b(role|roleDefinitionId|roleDefinition)\s*:/;

function retiredColumnReads(file: string, src: string): string[] {
  const hits: string[] = [];
  for (const m of src.matchAll(READ_METHODS)) {
    const args = balancedArgs(src, m.index! + m[0].length - 1);
    if (ROLE_KEY.test(args)) hits.push(`${file}: projectMembership.${m[1]} selects/filters a role`);
  }
  // A nested read through the relation: `projectMemberships: { select|where: { role … } }`.
  for (const m of src.matchAll(/\bprojectMemberships\s*:\s*\{/g)) {
    const block = balancedArgs(src, m.index! + m[0].length - 1);
    if (ROLE_KEY.test(block)) hits.push(`${file}: a nested projectMemberships read names a role`);
  }
  // A field read off a row, or its type.
  for (const m of src.matchAll(
    /\bprojectMembership\??\.(role|roleDefinitionId)\b|ProjectMembership\[['"](role|roleDefinitionId)['"]\]/g,
  )) {
    hits.push(`${file}: reads ${m[0]}`);
  }
  // Raw SQL naming the columns on the project membership table.
  for (const m of src.matchAll(/project_membership\b/g)) {
    // The statement around the table name — a column can be named before it (SELECT … FROM).
    const window = src.slice(Math.max(0, m.index! - 400), m.index! + 400);
    if (/\brole_definition_id\b|\bpm\.role\b|project_membership\.role\b/.test(window)) {
      hits.push(`${file}: raw SQL reads a project_membership role column`);
    }
  }
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
      "import type { ProjectAccessLevel } from '@/generated/prisma/client';",
      "import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';",
      "import type { ProjectRole } from '@/lib/projects/roles';",
    ].join('\n');
    expect(resolverViolations(planted)).toHaveLength(2);
  });

  it('2 · no production file under lib/ or app/ reads project_membership.role / role_definition_id', () => {
    expect(PRODUCTION.flatMap(({ file, src }) => retiredColumnReads(file, src))).toEqual([]);
  });

  it('2 · …and the scanner fires on each planted read shape', () => {
    const shapes = [
      'tx.projectMembership.findMany({ where: { projectId }, select: { role: true } })',
      'db.projectMembership.count({ where: { roleDefinitionId: id } })',
      'tx.user.findMany({ include: { projectMemberships: { select: { role: true } } } })',
      "if (row.projectMembership?.role === 'admin') {}",
      'type R = ProjectMembership["roleDefinitionId"];',
      'tx.$queryRaw`SELECT pm.role FROM project_membership pm`',
    ];
    for (const s of shapes) expect(retiredColumnReads('planted.ts', s), s).toHaveLength(1);
    // The legitimate WRITE of the still-NOT-NULL column is not a read.
    expect(
      retiredColumnReads('ok.ts', "tx.projectMembership.create({ data: { role: 'member' } })"),
    ).toEqual([]);
  });

  it('3 · every workspace-role write goes through setWorkspaceRole (or is the membership’s creation)', () => {
    const writers = PRODUCTION.flatMap(({ file, src }) => workspaceRoleWriters(file, src));
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
