import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectSchema } from '@/lib/api/v1/projects/schema';

// Story MOTIR-2588 · Subtask MOTIR-2681 — the three guards a coverage
// percentage cannot see.
//
// Each one protects a DECISION rather than a behaviour, and each protects it
// against the most likely way it gets undone: not by someone disagreeing, but
// by someone who never knew a decision was made. A percentage of covered lines
// says nothing about any of them.
//
//   1. NO FALLBACK MARK. `docs/decisions/entity-marks.md` §3 renders NOTHING
//      for a project with no logo. Every comparable product draws a generated
//      square, so "the corner looks empty" reads as a bug to a fresh pair of
//      eyes and the fix is one line of good-faith improvement.
//   2. THE `--el-avatar-*` RAMP STILL HAS CONSUMERS. `ProjectAvatar` was its
//      most visible one and is gone. The three theme tests assert the tokens
//      EXIST and stay perceptibly apart; none asserts anything USES them, so a
//      later "unused token" sweep could strand the ramp and pass every one.
//   3. THE v1 PROJECT RESOURCE DID NOT CHANGE. This story added a column, a DTO
//      field and a route; publishing `image` by accident would be an ADDITIVE
//      change that no existing test fails on, and ADR §8 makes additions
//      irreversible.
//
// ⚠️ Every guard here is paired with a proof that it BITES — the detector run
// against a synthetic source carrying exactly the shape it hunts. A guard whose
// condition can never be true reads as protection and is worse than none, and
// this file is entirely made of guards, so the proofs are not optional.

const REPO = process.cwd();

function tracked(...globs: string[]): string[] {
  return execFileSync('git', ['ls-files', ...globs], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

const read = (file: string) => readFileSync(join(REPO, file), 'utf8');

/** Drop block + line comments, so a guard matches CODE and never prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ── Guard 1 — nothing renders a project mark without an image ───────────────

/**
 * A MONOGRAM derived from a project's own identity: some slice of the project's
 * `name` or `identifier` taken with `charAt` / `slice` / `substring` / an
 * `initials(...)` helper. This is the shape a generated fallback takes; a person
 * monogram (`member.name.charAt(0)`, `login.charAt(0)`) is a different subject
 * and is deliberately NOT matched — the members lists and the git-account discs
 * are full of them and they are all legitimate.
 */
const PROJECT_MONOGRAM =
  /\b(?:project|activeProject)\??\.(?:name|identifier)\s*(?:\?\?[^;\n]*)?\.\s*(?:charAt|slice|substring|substr)\s*\(|\binitials\s*\(\s*(?:project|activeProject)\b/;

function projectMonogramOffenders(files: string[]): string[] {
  return files.filter((file) => PROJECT_MONOGRAM.test(stripComments(read(file))));
}

describe('guard 1 — a project with no logo renders NOTHING', () => {
  // The surfaces that draw a project's mark. Asserted EXACTLY rather than
  // scanned loosely: a NEW project-identity surface is something this guard
  // must be pointed at deliberately, and an exact list is what makes adding one
  // fail here until someone does.
  const MARK_SURFACES = [
    'app/(authed)/_components/ProjectMark.tsx',
    'app/(authed)/_components/ProjectSwitcher.tsx',
    'app/(authed)/_components/SettingsSidebarHeader.tsx',
  ];

  it('names every surface that renders one — no more, no fewer', () => {
    const importers = tracked('app/**/*.tsx', 'components/**/*.tsx').filter((file) =>
      /\bProjectMark\b/.test(read(file)),
    );
    expect(importers.sort()).toEqual([...MARK_SURFACES].sort());
  });

  it('none of them derives a tile from the project’s own name or key', () => {
    expect(
      projectMonogramOffenders(MARK_SURFACES),
      'a project-identity surface reintroduced a generated mark — `docs/decisions/entity-marks.md` §3 says it renders nothing, so change the ADR first',
    ).toEqual([]);
  });

  it('…and the detector FAILS on the shape it is hunting', () => {
    // The proof. Three plausible forms a fallback would actually be written in.
    for (const shape of [
      'const mark = project.identifier.charAt(0);',
      'return <span>{activeProject.name.slice(0, 2).toUpperCase()}</span>;',
      'const tile = initials(project.name);',
    ]) {
      expect(PROJECT_MONOGRAM.test(shape), shape).toBe(true);
    }
    // And does NOT fire on the person monograms the app is full of, which is
    // what keeps it from being deleted on its first run.
    for (const legitimate of [
      'const initial = (member.name || member.email).charAt(0).toUpperCase();',
      'const initial = login.charAt(0).toUpperCase();',
      '{name.charAt(0).toUpperCase()}',
    ]) {
      expect(PROJECT_MONOGRAM.test(legitimate), legitimate).toBe(false);
    }
  });

  it('the renderer itself keeps its no-image early return', () => {
    // The single branch the whole stance rests on. Read structurally rather
    // than behaviourally (that is `tests/components/project-mark.test.tsx`'s
    // job) so a refactor that keeps the RENDER and loses the DECISION — an
    // `image ?? somethingGenerated` upstream — still trips something.
    const source = stripComments(read('app/(authed)/_components/ProjectMark.tsx'));
    expect(source).toMatch(/if\s*\(\s*!image\s*\)/);
    expect(source).toMatch(/return\s+reserveSlot\s*\?/);
    // No text node anywhere in it: a mark that renders a character is a monogram
    // however it was computed.
    expect(source).not.toMatch(/>\s*\{[^}]*\}\s*</);
  });
});

// ── Guard 2 — the `--el-avatar-*` ramp still has consumers ─────────────────

describe('guard 2 — the `--el-avatar-*` ramp is not stranded', () => {
  const AVATAR_TOKEN = /--el-avatar-[\w-]+/g;

  /** Every tracked source that PAINTS with the ramp (not the specimen route). */
  function consumers(): string[] {
    return tracked('app/**/*.tsx', 'app/**/*.ts', 'components/**/*.tsx', 'lib/**/*.ts').filter(
      (file) => file !== 'app/tokens/page.tsx' && AVATAR_TOKEN.test(stripComments(read(file))),
    );
  }

  it('at least one shipped surface still paints with it', () => {
    // `ProjectAvatar` was the ramp's most visible consumer and MOTIR-2679
    // deleted it. What remains is PERSON avatars, which is why the ramp stays
    // rather than being retired alongside the project mark.
    const found = consumers();
    expect(
      found,
      'the --el-avatar-* ramp has no consumer left — either a surface stopped using it, or the ramp should be retired deliberately rather than left defined',
    ).not.toEqual([]);
    expect(found).toContain('app/(authed)/triage/_components/TriageAvatar.tsx');
  });

  it('the FALLBACK tile token has its own consumers, distinct from the pastel ramp', () => {
    const fallbackUsers = consumers().filter((file) =>
      /--el-avatar-fallback/.test(stripComments(read(file))),
    );
    expect(fallbackUsers.length).toBeGreaterThan(0);
  });

  it('…and the detector FAILS when nothing paints with the ramp', () => {
    // The proof: the same matcher over sources that do not use it.
    const blind = ['const c = "bg-(--el-tint-peach)";', 'export const x = 1;'];
    for (const source of blind) {
      AVATAR_TOKEN.lastIndex = 0;
      expect(AVATAR_TOKEN.test(source), source).toBe(false);
    }
  });
});

// ── Guard 3 — the v1 project resource did not change ───────────────────────

describe('guard 3 — the published v1 Project is byte-identical across this story', () => {
  // Frozen deliberately as a LITERAL, not derived from the schema: a list
  // computed from the thing it checks would move with it and assert nothing.
  const PUBLISHED = ['key', 'name', 'accessLevel', 'archived'];

  it('publishes exactly these four fields', () => {
    expect(Object.keys(projectSchema.shape).sort()).toEqual([...PUBLISHED].sort());
  });

  it('does NOT publish `image` — the mark this story added is internal', () => {
    // The specific accident this guard exists for. `image` rides ProjectDTO and
    // every internal surface reads it; adding it here would be an ADDITIVE
    // change (ADR §8 permits those without a version bump) that no other test
    // fails on, and additions to a published resource cannot be withdrawn.
    expect(Object.keys(projectSchema.shape)).not.toContain('image');
  });

  it('parses a payload of exactly those fields, and strips anything else', () => {
    const parsed = projectSchema.parse({
      key: 'MOTIR',
      name: 'Motir',
      accessLevel: 'open',
      archived: false,
      image: 'https://cdn.example.test/projects/p1/logo.png',
    });
    expect(Object.keys(parsed as object).sort()).toEqual([...PUBLISHED].sort());
  });

  it('…and the assertion FAILS on a schema that grew a field', () => {
    // The proof, run against a synthetic widening rather than the real schema.
    const widened = projectSchema.extend({ image: projectSchema.shape.name });
    expect(Object.keys(widened.shape).sort()).not.toEqual([...PUBLISHED].sort());
    expect(Object.keys(widened.shape)).toContain('image');
  });
});
