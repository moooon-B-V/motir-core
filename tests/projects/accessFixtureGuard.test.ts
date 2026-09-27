import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// No test writes a project's `accessLevel` itself (MOTIR-6685).
//
// A project's access is its MODE. Every test that sets it goes through
// `tests/helpers/projectAccess.ts`, which writes the mode and the level it maps to
// together — exactly what `projectRepository.setAccessMode` writes. A fixture that
// writes `accessLevel` alone only worked while `accessModeOf` derived a NULL mode
// from the level; once `access_mode` is NOT NULL (MOTIR-6686) it silently seeds an
// Open-to-the-workspace project instead, and the test fails — or worse, passes —
// for a reason unrelated to what it tests.
//
// So this is a SOURCE assertion: which test files may WRITE the column at all. It
// reads the TypeScript AST rather than grepping, because the writes come in shapes
// a line regex cannot tell apart from a read: a shorthand `{ accessLevel }`, a
// conditional spread `...(x ? { accessLevel: 'public' } : {})`, a factory option
// that its own body writes. And it must NOT flag the reads that stay: an assertion
// on the DERIVED `accessLevel` a DTO, API v1 or MCP payload still carries, or an
// in-memory `ProjectContext` literal that never reaches the database.

/** The files allowed to write `accessLevel`. */
const ALLOWED = new Set([
  // The helper itself: it writes the level `levelForMode` maps the mode to.
  'tests/helpers/projectAccess.ts',
  // The LEGACY-MAPPING tests: they seed a legacy level ON PURPOSE, because the
  // level-to-mode mapping, the storage split and the mapping migration are what
  // they test. Each says so beside its fixture.
  'tests/project-access-storage.test.ts',
  'tests/migrations/projectAccessMapping.test.ts',
  'tests/projects/accessMode.test.ts',
  // This file: its self-check below carries direct writes as SOURCE TEXT.
  'tests/projects/accessFixtureGuard.test.ts',
]);

/**
 * A single write that seeds a LEGACY level on purpose, in a file that is otherwise
 * held to the rule, says so on the line above it: `// legacy-access-level: <why>`.
 * The reason is required — a bare marker is not an exemption.
 */
const LEGACY_MARKER = /\/\/\s*legacy-access-level:\s*\S/;

/** A Prisma write's payload keys: `create({ data })`, `update({ data })`, `upsert({ create, update })`. */
const WRITE_KEYS = new Set(['data', 'create', 'update']);

/**
 * A raw SQL statement that writes the column (`INSERT … "accessLevel"`, `UPDATE … "accessLevel" =`).
 * SQL cannot spread the helper, so a raw write passes only when it writes the MODE
 * in the same statement — the helper's contract, stated in SQL.
 */
const RAW_WRITE = /\b(INSERT|UPDATE)\b[\s\S]*"accessLevel"/i;
const RAW_WRITES_MODE = /"accessMode"|\baccess_mode\b/;

type Hit = { line: number; text: string };

function propertyName(node: ts.Node): string | null {
  if (ts.isShorthandPropertyAssignment(node)) return node.name.text;
  if (ts.isPropertyAssignment(node)) {
    const n = node.name;
    if (ts.isIdentifier(n) || ts.isStringLiteral(n)) return n.text;
  }
  return null;
}

/** True when `node` sits inside a `data` / `create` / `update` payload of the same expression. */
function insideWritePayload(node: ts.Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    // A function or a statement ends the expression: an object built there is
    // not, by construction, the payload of a write outside it.
    if (ts.isFunctionLike(p) || ts.isBlock(p) || ts.isSourceFile(p)) return false;
    const name = propertyName(p);
    if (name !== null && WRITE_KEYS.has(name)) return true;
  }
  return false;
}

/** Every `accessLevel` write in `source`, by line. Exported shape kept local: the self-check drives it. */
function directAccessLevelWrites(fileName: string, source: string): Hit[] {
  if (!source.includes('accessLevel')) return [];
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const lines = source.split('\n');
  const hits: Hit[] = [];
  const at = (node: ts.Node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    if (line > 0 && LEGACY_MARKER.test(lines[line - 1]!)) return;
    hits.push({ line: line + 1, text: lines[line]!.trim() });
  };
  const visit = (node: ts.Node) => {
    if (propertyName(node) === 'accessLevel' && insideWritePayload(node)) at(node);
    if (
      (ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node) ||
        ts.isStringLiteral(node)) &&
      RAW_WRITE.test(node.getText(sf)) &&
      !RAW_WRITES_MODE.test(node.getText(sf))
    ) {
      at(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function testFiles(): string[] {
  return (readdirSync('tests', { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => path.posix.join('tests', f.split(path.sep).join('/')))
    .sort();
}

describe('the access fixture guard — no test writes `accessLevel` directly', () => {
  it('every test sets a project’s access through tests/helpers/projectAccess.ts', () => {
    const offenders: string[] = [];
    for (const file of testFiles()) {
      if (ALLOWED.has(file)) continue;
      for (const hit of directAccessLevelWrites(file, readFileSync(file, 'utf8'))) {
        offenders.push(`${file}:${hit.line}  ${hit.text}`);
      }
    }
    expect(
      offenders,
      'Set a project’s access with projectAccessData(mode) / setProjectAccess(client, id, mode) ' +
        'from tests/helpers/projectAccess.ts — never by writing accessLevel',
    ).toEqual([]);
  });

  it('the allow-list names only files that exist', () => {
    const files = new Set(testFiles());
    for (const allowed of ALLOWED) expect(files, allowed).toContain(allowed);
  });

  // The self-check: the scanner FAILS on each shape a direct write takes, and
  // stays quiet on each read that remains legitimate. Without it, a scanner that
  // matched nothing would read as a clean tree.
  describe('the scanner', () => {
    const scan = (src: string) =>
      directAccessLevelWrites('scratch.test.ts', src).map((h) => h.line);

    it.each([
      [
        'an update data block',
        `await adminDb.project.update({ where: { id }, data: { accessLevel: 'public' } });`,
      ],
      [
        'a create data block',
        `await adminDb.project.create({\n  data: {\n    name: 'P',\n    accessLevel: 'private',\n  },\n});`,
      ],
      [
        'a shorthand key',
        `const p = (accessLevel) => db.project.create({ data: { name: 'P', accessLevel } });`,
      ],
      [
        'a conditional spread',
        `await db.project.update({ where: { id }, data: { ...(pub ? { accessLevel: 'public' } : {}) } });`,
      ],
      [
        'an upsert arm',
        `await db.project.upsert({ where: { id }, create: { accessLevel: 'open' }, update: {} });`,
      ],
      [
        'a raw INSERT',
        'await tx.$executeRaw`INSERT INTO "project" ("id", "accessLevel") VALUES (1, \'public\')`;',
      ],
      [
        'a raw UPDATE',
        'await tx.$executeRawUnsafe(\'UPDATE "project" SET "accessLevel" = \\\'public\\\'\');',
      ],
    ])('flags %s', (_label, src) => {
      expect(scan(src).length).toBeGreaterThan(0);
    });

    it.each([
      [
        'a derived-DTO assertion',
        `expect(res).toEqual({ key, accessMode: 'members', accessLevel: 'private' });`,
      ],
      [
        'an in-memory project context',
        `const PROJECT = { project: { identifier: 'ACME', accessLevel: 'open' } };`,
      ],
      ['a type annotation', `async function seed(accessLevel: 'public' | 'open') {}`],
      ['a read', `expect(row.accessLevel).toBe('open');`],
      ['a raw SELECT', 'await tx.$queryRaw`SELECT "accessLevel" FROM "project"`;'],
      [
        'a raw INSERT writing the mode beside the level',
        'await tx.$executeRaw`INSERT INTO "project" ("id", "access_mode", "accessLevel") VALUES (1, \'public\', \'public\')`;',
      ],
      [
        'the helper',
        `await db.project.update({ where: { id }, data: projectAccessData('public') });`,
      ],
      [
        'a write marked as a legacy seed',
        `await db.project.update({\n  where: { id },\n  // legacy-access-level: the fallback is what this tests.\n  data: { accessLevel: 'limited' },\n});`,
      ],
    ])('does not flag %s', (_label, src) => {
      expect(scan(src)).toEqual([]);
    });

    it('flags a marker with no reason', () => {
      expect(
        scan(
          `await db.project.update({\n  // legacy-access-level:\n  data: { accessLevel: 'limited' },\n});`,
        ),
      ).toEqual([3]);
    });
  });
});
