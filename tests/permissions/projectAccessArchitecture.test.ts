import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// THE ARCHITECTURE GUARDS for Story MOTIR-6169 (Subtask MOTIR-6552) — what
// coverage cannot see.
//
//   1. ONE ENTRY RULE. Whether a person may enter a project is `canEnter`
//      (`lib/permissions/resolve.ts`), read through `projectAccessService`. A
//      service that decides entry from the column itself —
//      `project.accessLevel === 'private'`, or a `where: { accessMode: 'members' }`
//      — is a second rule that the first can disagree with, which is exactly the
//      bug class this story closed (MOTIR-6319 was three such reads). So nothing
//      under `lib/` outside the entry rule's own modules compares the mode or the
//      level with anything but `'public'`: Public is the one value that is a
//      PUBLICATION fact (the public reading surface, the build-in-public slot),
//      not an entry fact.
//   2. TOTALITY. Every lookup keyed on `ProjectAccessMode`, `WorkspaceAccessScope`
//      or `RoleMigrationReason` is a plain `Record<Enum, …>`, which the compiler
//      holds total — so the two ways out of that promise, `Partial<Record<Enum…>>`
//      and a cast `as Record<Enum…>`, are refused here, and a new enum value is a
//      compile error at every lookup rather than a raw key at runtime.
//   3. NOTHING READS THE RETIRED LEVEL (Story MOTIR-6554 · Subtask MOTIR-6687).
//      A project is public — to the RLS policies, the listings, the directory and
//      the tag counts — exactly when `accessMode = 'public'`. So nothing under
//      `lib/` or `app/` reads `accessLevel` off a project row: no `where`, no
//      `select`, no `Pick`, no property read, no `"accessLevel"` in raw SQL. The
//      column is still WRITTEN (the previous image reads it during the deploy
//      window), and a derived `accessLevel` is still PUBLISHED on the DTO, API v1
//      and MCP; those sites are named below, and phase 2 (MOTIR-6692) retires the
//      write path.
//
// Each guard is also shown FAILING on a synthetic source (the last block), so a
// scanner that matches nothing cannot pass for one that found nothing.

const ROOT = join(import.meta.dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}
const rel = (file: string) => relative(ROOT, file).split(sep).join('/');

/** The entry rule's own modules — the only places allowed to read the column for entry. */
const ENTRY_RULE = [
  /^lib\/permissions\//,
  /^lib\/services\/projectAccessService\.ts$/,
  // The mode ⇄ level mapping itself (MOTIR-6541).
  /^lib\/projects\/accessMode\.ts$/,
];

/**
 * An entry decision made from the column: a comparison, or a Prisma filter, of
 * `accessLevel` / `accessMode` against a literal that is not `'public'`. A type
 * union (`accessMode: 'workspace' | 'members'`) is a declaration, not a filter,
 * and is not matched.
 */
function entryDecisions(source: string): string[] {
  const found: string[] = [];
  const lines = source.split('\n');
  const compare =
    /access(?:Level|Mode)\s*(?:===|!==|==|!=)\s*'(\w+)'|'(\w+)'\s*(?:===|!==|==|!=)\s*[\w.]*access(?:Level|Mode)\b/;
  const filter = /access(?:Level|Mode)\s*:\s*'(\w+)'(?!\s*\|)/;
  const filterObject = /access(?:Level|Mode)\s*:\s*\{\s*(?:not|in|notIn|equals)\b/;
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    const c = line.match(compare);
    const value = c?.[1] ?? c?.[2];
    if (value && value !== 'public') found.push(`${i + 1}: ${line.trim()}`);
    const f = line.match(filter);
    if (f && f[1] !== 'public') found.push(`${i + 1}: ${line.trim()}`);
    if (filterObject.test(line)) found.push(`${i + 1}: ${line.trim()}`);
  });
  return found;
}

const ENUMS = 'ProjectAccessMode|WorkspaceAccessScope|RoleMigrationReason';
/** The two ways out of a `Record<Enum, …>`'s totality. */
function totalityEscapes(source: string): string[] {
  const escape = new RegExp(
    `Partial<\\s*Record<\\s*(?:${ENUMS})\\b|\\bas\\s+Record<\\s*(?:${ENUMS})\\b`,
  );
  return source
    .split('\n')
    .map((line, i) => (escape.test(line) ? `${i + 1}: ${line.trim()}` : null))
    .filter((x): x is string => x !== null);
}

/**
 * The sites still allowed to name the retired level (MOTIR-6687): the legacy
 * WRITE path phase 2 (MOTIR-6692) retires, the mode ⇄ level mapping, and the
 * derived, never-read-back `accessLevel` the DTO, API v1 and MCP publish.
 */
const LEVEL_ALLOWED = [
  // The legacy `{ accessLevel }` request arm and its setter — retired by phase 2.
  /^app\/api\/projects\/\[key\]\/access\/route\.ts$/,
  /^lib\/services\/projectMembersService\.ts$/,
  /^lib\/projects\/roles\.ts$/,
  // `levelForMode` — the level written beside a mode.
  /^lib\/projects\/accessMode\.ts$/,
  // The derived public contract: DTO types, API v1's schema, MCP's row.
  /^lib\/dto\/projects\.ts$/,
  /^lib\/dto\/projectMembers\.ts$/,
  /^lib\/api\/v1\/projects\/schema\.ts$/,
  /^lib\/mcp\/tools\/listProjects\.ts$/,
];

/**
 * A read of the retired level: any code line naming `accessLevel`, the SQL column
 * `"accessLevel"` or the `project_access_level` type — except the one line shape
 * that WRITES or DERIVES it from the mode, `accessLevel: levelForMode(…)`
 * (`projectRepository.setAccessMode` and the two mappers).
 */
function levelReads(source: string): string[] {
  const found: string[] = [];
  source.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    if (
      !/\baccessLevel\b|\baccess_level\b|\bproject_access_level\b|\bProjectAccessLevel\b/.test(line)
    )
      return;
    if (/\baccessLevel\s*:\s*levelForMode\(/.test(line)) return;
    found.push(`${i + 1}: ${line.trim()}`);
  });
  return found;
}

describe('NOTHING READS THE RETIRED LEVEL — lib/ and app/ key on the mode (MOTIR-6687)', () => {
  it('no where, select, Pick, property read or raw SQL names accessLevel outside the allowed sites', () => {
    const offenders = [...walk(join(ROOT, 'lib')), ...walk(join(ROOT, 'app'))]
      .filter((f) => !LEVEL_ALLOWED.some((re) => re.test(rel(f))))
      .flatMap((f) => levelReads(readFileSync(f, 'utf8')).map((hit) => `${rel(f)}:${hit}`));
    expect(
      offenders,
      "A project is public exactly when accessMode = 'public' — read the mode, never the level.",
    ).toEqual([]);
  });

  it('every allowed site still exists', () => {
    const files = [...walk(join(ROOT, 'lib')), ...walk(join(ROOT, 'app'))].map(rel);
    for (const re of LEVEL_ALLOWED)
      expect(
        files.some((f) => re.test(f)),
        String(re),
      ).toBe(true);
  });
});

describe('ONE ENTRY RULE — nothing under lib/ decides entry from the column', () => {
  it('no service, repository or reader compares the mode or level with an entry value', () => {
    const offenders = walk(join(ROOT, 'lib'))
      .filter((f) => !ENTRY_RULE.some((re) => re.test(rel(f))))
      .flatMap((f) => entryDecisions(readFileSync(f, 'utf8')).map((hit) => `${rel(f)}:${hit}`));
    expect(
      offenders,
      'Ask the entry rule (`projectAccessService` → `canEnter`) instead of reading the column.',
    ).toEqual([]);
  });

  it('the scan reaches lib/services and lib/repositories', () => {
    const scanned = walk(join(ROOT, 'lib')).map(rel);
    expect(scanned).toContain('lib/services/projectsService.ts');
    expect(scanned).toContain('lib/repositories/projectRepository.ts');
  });
});

describe('TOTALITY — every lookup keyed on the story’s enums stays a total Record', () => {
  const files = [...walk(join(ROOT, 'lib')), ...walk(join(ROOT, 'app'))];

  it('none escapes through Partial<Record<…>> or a cast', () => {
    const offenders = files.flatMap((f) =>
      totalityEscapes(readFileSync(f, 'utf8')).map((hit) => `${rel(f)}:${hit}`),
    );
    expect(offenders).toEqual([]);
  });

  it('the lookups this story added are there to be held total', () => {
    const lookups = files
      .filter((f) => new RegExp(`Record<\\s*(?:${ENUMS})\\b`).test(readFileSync(f, 'utf8')))
      .map(rel);
    expect(lookups).toEqual(
      expect.arrayContaining([
        'app/(authed)/settings/project/members/_components/ProjectMembersSettings.tsx',
        'app/(authed)/settings/workspace/_components/RoleMigrationNotice.tsx',
        'app/(authed)/settings/workspace/_components/InviteAccessFields.tsx',
      ]),
    );
  });
});

describe('NO PAGE SENDS A NULL ACTIVE PROJECT TO /sign-in (MOTIR-6548)', () => {
  // A reader who can enter none of the workspace's projects resolves NO active
  // project. `/sign-in` bounces a signed-in reader straight back to the landing,
  // so a page answering null with it is a redirect loop — the one MOTIR-6319's
  // first cut hit in CI. Every such page answers with `NO_PROJECT_PATH`, or with
  // a destination of its own that is not the sign-in page.
  const pages = [...walk(join(ROOT, 'app'))].filter((f) => /\/(page|layout)\.tsx$/.test(f));

  it('every page that reads the active project routes a null one away from sign-in', () => {
    const loops = pages.flatMap((f) => {
      const src = readFileSync(f, 'utf8');
      const reads = [...src.matchAll(/const (\w+) = await getActiveProject\(\)/g)];
      return reads.flatMap((m) => {
        const after = src.slice(m.index!, m.index! + 900);
        return new RegExp(`if \\(!${m[1]}\\) redirect\\('/sign-in'\\)`).test(after)
          ? [`${rel(f)} (${m[1]})`]
          : [];
      });
    });
    expect(loops, 'answer a null active project with redirect(NO_PROJECT_PATH)').toEqual([]);
  });

  it('the scan reaches the project-scoped pages', () => {
    const withReads = pages.filter((f) => readFileSync(f, 'utf8').includes('getActiveProject()'));
    expect(withReads.length).toBeGreaterThan(40);
  });
});

describe('the guards have been SEEN to fail', () => {
  it("a direct `project.accessLevel === 'private'` check in a service is caught", () => {
    const fixture = [
      'export async function leak(project: Project) {',
      "  if (project.accessLevel === 'private') return [];",
      "  return db.project.findMany({ where: { accessMode: 'members' } });",
      "  return db.project.findMany({ where: { accessLevel: { not: 'private' } } });",
      '}',
    ].join('\n');
    expect(entryDecisions(fixture)).toHaveLength(3);
  });

  it('the publication fact and a type union are NOT caught', () => {
    const fixture = [
      "if (project.accessMode === 'public') publish();",
      "where: { accessLevel: 'public', archivedAt: null }",
      "accessMode: 'workspace' | 'members' | 'public';",
      "// a comment naming accessLevel === 'private' is a record, not a read",
    ].join('\n');
    expect(entryDecisions(fixture)).toEqual([]);
  });

  it('a page answering a null active project with /sign-in is caught', () => {
    const src = "const ctx = await getActiveProject();\n  if (!ctx) redirect('/sign-in');";
    const m = /const (\w+) = await getActiveProject\(\)/.exec(src)!;
    expect(new RegExp(`if \\(!${m[1]}\\) redirect\\('/sign-in'\\)`).test(src)).toBe(true);
  });

  it('a read of the retired level is caught, and the derived write is not', () => {
    const fixture = [
      "return db.project.findMany({ where: { accessLevel: 'public' } });",
      'select: { id: true, accessLevel: true },',
      "type Row = Pick<Project, 'id' | 'accessLevel'>;",
      "if (project.accessLevel === 'public') publish();",
      'WHERE p."accessLevel" = \'public\'::"project_access_level"',
      'accessLevel: levelForMode(accessMode),',
      '// a comment naming accessLevel is a record, not a read',
    ].join('\n');
    expect(levelReads(fixture)).toHaveLength(5);
  });

  it('both totality escapes are caught', () => {
    expect(
      totalityEscapes(
        [
          'const A: Partial<Record<ProjectAccessMode, string>> = {};',
          'const B = {} as Record<RoleMigrationReason, string>;',
          'const C: Record<WorkspaceAccessScope, string> = { full: "", limited: "" };',
        ].join('\n'),
      ),
    ).toHaveLength(2);
  });
});
