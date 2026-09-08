import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// MOTIR-4872 — the guard that keeps the Create-project SCREEN out of the
// project tier.
//
// ── What this exists to prevent ─────────────────────────────────────────────
// `ProjectsEmptyState` was an actionable empty state — an accent "Plan with AI"
// door and a "Create project" button — rendered INSIDE the app shell, for a
// reader with no project. It was a category error rather than a copy problem:
// creating a project is a workspace-tier act, and it was being offered on a
// route that only exists inside a project.
//
// The state it served is gone (MOTIR-4870 seeds a default project at the
// WORKSPACE tier, so `getActiveProject()` returns null on no path a member can
// take), so the component is deleted and this asserts it stays deleted.
//
// ⚠️ IT IS A SEARCH, NOT A LIST OF THE TWO KNOWN SITES, and that is the whole
// point. The call-site count GREW: `/dashboard` had the branch first,
// `docs/decisions/home-scope.md` §2.2 decided `/home` should acquire it, and
// `/workbench` inherited it in the MOTIR-4782 rename. An enumeration of today's
// two would have passed at every step while a third appeared. Modelled on
// `landing-owner-guard.test.ts`, and deliberately dumb for the same reason — a
// string scan over the tree, not an AST walk.

const ROOT = resolve(__dirname, '..', '..');

/**
 * The tiers this is enforced over.
 *
 * `app/(authed)` is the project tier — the shell, its routes, its components —
 * and is where the screen must never come back. `app/(onboarding)` is included
 * because it is the OTHER authenticated tier a projectless reader was routed
 * through, and its entrance dead-ended for exactly the same reason.
 */
const SCANNED = [join('app', '(authed)'), join('app', '(onboarding)')];

/** Source files only — a `.png` under `design/` may of course still depict history. */
const SOURCE = /\.(ts|tsx)$/;

/**
 * A USAGE of the component — an import of its module, or the element itself.
 *
 * ⚠️ NOT the bare word. A comment that RECORDS what was retired, and why, is
 * exactly what a reader meeting an old citation needs, and a guard that forbids
 * naming the thing would forbid the record along with the defect. What must not
 * come back is a call site.
 */
const USAGE = /from\s+['"][^'"]*ProjectsEmptyState['"]|<ProjectsEmptyState[\s/>]/;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE.test(entry)) out.push(full);
  }
  return out;
}

function scannedFiles(): string[] {
  return SCANNED.flatMap((rel) => walk(join(ROOT, rel)));
}

describe('the Create-project SCREEN has no home in the project tier (MOTIR-4872)', () => {
  it('the component itself no longer exists', () => {
    expect(existsSync(join(ROOT, 'app', '(authed)', '_components', 'ProjectsEmptyState.tsx'))).toBe(
      false,
    );
  });

  it('no file under the authed or onboarding tiers names it', () => {
    const offenders = scannedFiles()
      .filter((file) => USAGE.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file).split(sep).join('/'));

    expect(
      offenders,
      `A Create-project screen has come back in the project tier: ${offenders.join(', ')}. ` +
        'Every member is inside a project (MOTIR-4870), so there is no reader for it to serve — ' +
        'and creating a project is a workspace-tier act, which a route that only exists inside a ' +
        'project cannot host. The switcher owns that door.',
    ).toEqual([]);
  });

  it('the scan actually reaches the two files the screen used to live on', () => {
    // ⚠️ A guard asserted only by passing is a guard nobody has watched fire.
    // These two paths are what the assertion above was written for, so if a
    // rename moves them out of the scanned set the guard silently stops
    // covering the thing it is named after.
    const scanned = scannedFiles().map((f) => relative(ROOT, f).split(sep).join('/'));
    expect(scanned).toContain('app/(authed)/workbench/page.tsx');
    expect(scanned).toContain('app/(authed)/dashboard/page.tsx');
    expect(scanned.length).toBeGreaterThan(50);
  });

  it('the scan CATCHES a re-introduction and IGNORES a record of one', () => {
    // The counterfactual, so the emptiness above is evidence about the tree
    // rather than a property of the matcher.
    expect(
      USAGE.test("import { ProjectsEmptyState } from '../_components/ProjectsEmptyState';"),
    ).toBe(true);
    expect(USAGE.test('  return <ProjectsEmptyState aiConfigured={x} />;')).toBe(true);
    expect(USAGE.test('<ProjectsEmptyState/>')).toBe(true);
    // …and a comment recording the retirement is not a call site.
    expect(
      USAGE.test('// This used to render `ProjectsEmptyState` — a Create-project screen.'),
    ).toBe(false);
  });
});

describe('what the screen offered is NOT what was removed (MOTIR-4872)', () => {
  it('the create-project MODAL survives — an additional project is still a real act', () => {
    // The parent story retires the SCREEN a projectless reader was landed on,
    // not the ability to create a project. Deleting this by mistake would take
    // the only remaining door with it, which is the MOTIR-4680 shape (a
    // relocation that rebuilt a surface's content and dropped its actions).
    expect(existsSync(join(ROOT, 'app', '(authed)', '_components', 'CreateProjectModal.tsx'))).toBe(
      true,
    );
  });

  it('the "Plan a new project with AI" action survives on the switcher', () => {
    const switcher = readFileSync(
      join(ROOT, 'app', '(authed)', '_components', 'ProjectSwitcher.tsx'),
      'utf8',
    );
    expect(switcher).toContain('startNewAiProjectAction');
  });
});
