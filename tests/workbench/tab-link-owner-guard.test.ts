import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// THE TAB-LINK OWNER GUARD (Story MOTIR-5213 · MOTIR-5218).
//
// Every Workbench tab now carries its own `?tab=`, and the bare `/workbench`
// names NO tab — it is an entrance the landing resolves (`design/workbench/
// design-notes.md` § 21). So a link to a tab has exactly one legitimate builder,
// `workbenchTabHref` in `lib/workbench/tab.ts`, and two ways to get it wrong that
// no type can see:
//
//   1. HAND-SPELLING a tab address — `'?tab=todo'`, `` `${AUTHED_LANDING_PATH}?tab=…` ``.
//      A second copy of the slug table, correct on the day it is typed.
//   2. REACHING FOR THE BARE PATH to mean a tab — `href={AUTHED_LANDING_PATH}` in
//      the Workbench's own components, which USED to be To do's spelling and is
//      now whatever the cascade picks for that reader.
//
// `tests/navigation/landing-owner-guard.test.ts` already refuses a `'/workbench?…'`
// string literal. This guard covers what that scan cannot: the slug spelled
// beside the CONSTANT, and the constant used where a tab is meant.

const ROOT = resolve(__dirname, '..', '..');
const ROOTS = ['app', 'components', 'lib'];

/** The one module allowed to spell a `?tab=` out. */
const OWNER = join('lib', 'workbench', 'tab.ts');

/** The Workbench's own surface — where a use of the landing constant can only mean a tab. */
const WORKBENCH_SURFACE = join('app', '(authed)', 'workbench') + sep;

/**
 * A WORKBENCH `tab=` slug spelled inside a string or template literal. Keyed on
 * the five slugs rather than on `tab=` alone: other surfaces have tab params of
 * their own, and a guard that fired on them would be exempted rather than read.
 */
const TAB_QUERY_LITERAL =
  /(['"`])[^'"`\n]*[?&]tab=(approvals|in-progress|todo|finished|watching)\b[^'"`\n]*\1/;

/** The landing constant with a query glued onto it — `${AUTHED_LANDING_PATH}?…` or `AUTHED_LANDING_PATH + '?…'`. */
const LANDING_WITH_QUERY = /AUTHED_LANDING_PATH\}\?|AUTHED_LANDING_PATH\s*\+\s*['"`]\?/;

/** Any use of the landing constant (imports are not uses). */
const LANDING_USE = /\bAUTHED_LANDING_PATH\b/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/** Code lines only: `//` and block-comment lines, and import lines, are not links. */
function codeLines(source: string): Array<{ line: number; text: string }> {
  const lines: Array<{ line: number; text: string }> = [];
  let inBlock = false;
  source.split('\n').forEach((raw, i) => {
    const text = raw.trim();
    if (inBlock) {
      if (text.includes('*/')) inBlock = false;
      return;
    }
    if (text.startsWith('/*')) {
      inBlock = !text.includes('*/');
      return;
    }
    if (text.startsWith('//') || text.startsWith('*') || text.startsWith('import ')) return;
    lines.push({ line: i + 1, text: raw });
  });
  return lines;
}

/** Offending `file:line` hits for a source, as the guard judges it. */
function judge(file: string, source: string): string[] {
  if (file === OWNER) return [];
  const hits: string[] = [];
  for (const { line, text } of codeLines(source)) {
    if (TAB_QUERY_LITERAL.test(text) || LANDING_WITH_QUERY.test(text)) {
      hits.push(`${file}:${line} spells a tab address by hand — use workbenchTabHref`);
    } else if (file.startsWith(WORKBENCH_SURFACE) && LANDING_USE.test(text)) {
      hits.push(
        `${file}:${line} uses the bare landing path on the Workbench — it names no tab; use workbenchTabHref`,
      );
    }
  }
  return hits;
}

describe('the tab-link owner guard', () => {
  it('finds NO hand-built Workbench tab link under app/, components/ or lib/', () => {
    const hits = ROOTS.flatMap((root) =>
      walk(join(ROOT, root)).flatMap((full) =>
        judge(relative(ROOT, full), readFileSync(full, 'utf8')),
      ),
    );
    expect(hits).toEqual([]);
  });

  it('is not vacuous — the owner module really does spell every tab', () => {
    const owner = readFileSync(join(ROOT, OWNER), 'utf8');
    expect(owner).toContain('AUTHED_LANDING_PATH');
    expect(owner).toMatch(/params\.set\('tab'/);
  });

  describe('its judgement, on fixtures', () => {
    const page = join('app', '(authed)', 'workbench', 'page.tsx');
    const elsewhere = join('components', 'Nav.tsx');

    it('refuses a slug spelled in a literal, anywhere', () => {
      expect(judge(elsewhere, `const href = '/x?tab=todo';`)).toHaveLength(1);
      expect(judge(elsewhere, 'const href = `${base}?page=2&tab=approvals`;')).toHaveLength(1);
    });

    it('refuses a query glued onto the landing constant', () => {
      expect(judge(elsewhere, 'const href = `${AUTHED_LANDING_PATH}?tab=${slug}`;')).toHaveLength(
        1,
      );
      expect(judge(elsewhere, `const href = AUTHED_LANDING_PATH + '?tab=' + slug;`)).toHaveLength(
        1,
      );
    });

    it('refuses the bare landing path used on the Workbench, and allows it elsewhere', () => {
      expect(judge(page, '<Link href={AUTHED_LANDING_PATH}>To do</Link>')).toHaveLength(1);
      // A door to the Workbench from OUTSIDE it is exactly what the constant is for.
      expect(judge(elsewhere, '<Link href={AUTHED_LANDING_PATH}>Workbench</Link>')).toEqual([]);
    });

    it('leaves another surface’s own tab param alone', () => {
      expect(judge(elsewhere, `const href = '/items/M-1?tab=activity';`)).toEqual([]);
    });

    it('ignores comments, imports and the owner module', () => {
      expect(judge(page, `// AUTHED_LANDING_PATH is where '?tab=todo' used to be absent`)).toEqual(
        [],
      );
      expect(
        judge(page, `import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';`),
      ).toEqual([]);
      expect(judge(OWNER, 'return `${AUTHED_LANDING_PATH}?${params}`;')).toEqual([]);
    });
  });
});
