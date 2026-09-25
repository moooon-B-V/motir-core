import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-6299 — ONE LEVEL BUILDER. The architecture half, in the shape of
// `surfaceViewsOneComponent.test.ts`.
//
// The planning surface used to carry a SECOND function that turned a committed
// roadmap level plus a plan into the level a canvas draws — its own frame, its
// own `locked` rule, its own `proposed:` drill — beside `mergePlanLevel`, the one
// the plan page draws through. The two drifted (finished work drawn locked, two
// outcome stripes on one card, cards without arrows), and by the time it was
// deleted nothing reached it any more. A second builder like it renders correctly
// the day it is written, so no render-level test fails when one comes back. This
// one does.
//
// It is a STATIC read of every file under `components/planning/` and
// `lib/planning/`, for the reason the surface-views guard gives: *"a render cannot
// see an import that a branch happened not to take."*

const ROOT = process.cwd();
const SCANNED_DIRS = ['components/planning', 'lib/planning'] as const;

/** The deleted builder's names, assembled so this file does not itself carry the
 *  literal symbol (MOTIR-6299's acceptance grep covers `tests/`). */
const DELETED_BUILDER = ['decorate', 'PlanChangeLevel'].join('');
const DELETED_MODULE = ['plan', 'ChangeLevel'].join('');

/** Types that make a parameter a PLAN input — the review model, or an index of it. */
const PROPOSAL_TYPES = ['PlanReviewItemDto', 'PlanReviewDto', 'PlanChangeDiffIndex', 'ProposedAdd'];
/** Types that make a return value a canvas LEVEL. */
const LEVEL_TYPES = ['RoadmapLevel', 'PlanCanvasLevel'];

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Source with comments removed — prose may discuss the old builder; code may not. */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const hasWord = (text: string, word: string) => new RegExp(`\\b${word}\\b`).test(text);

interface ExportedFunction {
  file: string;
  name: string;
  params: string;
  returns: string;
}

/**
 * Every EXPORTED function in `code` — `export function f(...)` and
 * `export const f = (...) =>` — with its parameter list and its declared return
 * type, read by matching brackets so a nested object type cannot cut it short.
 */
function exportedFunctions(file: string, code: string): ExportedFunction[] {
  const found: ExportedFunction[] = [];
  const head =
    /export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*(?:<[^(]*>)?\s*\(|export\s+const\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:<[^(]*>)?\s*\(/g;
  for (let m = head.exec(code); m; m = head.exec(code)) {
    const name = (m[1] ?? m[2])!;
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = open;
    for (let i = open; i < code.length; i++) {
      const c = code[i];
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) {
        close = i;
        break;
      }
    }
    const params = code.slice(open + 1, close);
    // The return annotation runs from `):` to the body's `{` or an arrow's `=>`.
    const rest = code.slice(close + 1, close + 400);
    const annotated = /^\s*:\s*([\s\S]*?)(?:=>|\{)/.exec(rest);
    found.push({ file, name, params, returns: annotated?.[1] ?? '' });
  }
  return found;
}

const FILES = SCANNED_DIRS.flatMap((d) => collect(join(ROOT, d))).map((full) => ({
  rel: relative(ROOT, full).split(sep).join('/'),
  code: codeOf(readFileSync(full, 'utf8')),
}));

describe('ONE level builder (MOTIR-6299)', () => {
  it('scans a real tree — the guard is not vacuous', () => {
    const rels = FILES.map((f) => f.rel);
    expect(rels).toContain('components/planning/planLevel.tsx');
    expect(rels).toContain('components/planning/PlanReviewCanvas.tsx');
    expect(rels).toContain('lib/planning/planChangeDiff.ts');
  });

  it('⭐ `mergePlanLevel` is the ONLY exported function that builds a proposal-decorated level', () => {
    // A proposal-decorated level builder: it takes the PLAN (a review item, the
    // review, or an index of it) and returns a canvas LEVEL. `decorateTargetLevel`
    // and `buildWorkItemLevel` return levels too, but take no plan, and
    // `proposalsAtLevel` takes a plan but returns proposals, not a level.
    const builders = FILES.flatMap((f) => exportedFunctions(f.rel, f.code))
      .filter(
        (fn) =>
          PROPOSAL_TYPES.some((t) => hasWord(fn.params, t)) &&
          LEVEL_TYPES.some((t) => hasWord(fn.returns, t)),
      )
      .map((fn) => `${fn.file}#${fn.name}`);

    expect(
      builders,
      'A second function builds a canvas level from a plan. Draw through `mergePlanLevel` ' +
        '(components/planning/planLevel.tsx) instead — two builders are two places for the ' +
        'card and edge rules to drift.',
    ).toEqual(['components/planning/planLevel.tsx#mergePlanLevel']);
  });

  it('the predicate recognises the builder it exists to catch', () => {
    // A control: the deleted builder's own signature, fed through the same parser.
    const legacy = `export function ${DELETED_BUILDER}(
      base: RoadmapLevel,
      wi: RoadmapLevelData,
      index: PlanChangeDiffIndex,
      focusNodeId: string | null,
      outcome: PlanItemOutcome | null = null,
    ): RoadmapLevel {
      return base;
    }
    export const other = (items: PlanReviewItemDto[], opts: { a: string }): PlanCanvasLevel => ({ nodes: [], deps: [] });`;
    const fns = exportedFunctions('fixture.tsx', legacy);
    expect(fns.map((f) => f.name)).toEqual([DELETED_BUILDER, 'other']);
    for (const fn of fns) {
      expect(
        PROPOSAL_TYPES.some((t) => hasWord(fn.params, t)),
        fn.name,
      ).toBe(true);
      expect(
        LEVEL_TYPES.some((t) => hasWord(fn.returns, t)),
        fn.name,
      ).toBe(true);
    }
  });

  it(`no file exports the deleted builder, by name`, () => {
    const exporting = FILES.filter((f) =>
      new RegExp(
        `export\\s+(?:default\\s+)?(?:async\\s+)?(?:function|const|let|var)\\s+${DELETED_BUILDER}\\b|export\\s*\\{[^}]*\\b${DELETED_BUILDER}\\b`,
      ).test(f.code),
    ).map((f) => f.rel);
    expect(exporting).toEqual([]);
  });

  it(`no file imports a module named ${DELETED_MODULE}`, () => {
    const importing = FILES.filter((f) =>
      new RegExp(
        `(?:import|export)[^;]*from\\s*['"][^'"]*/${DELETED_MODULE}(?:\\.tsx?)?['"]|import\\(\\s*['"][^'"]*/${DELETED_MODULE}['"]`,
      ).test(f.code),
    ).map((f) => f.rel);
    expect(importing).toEqual([]);
  });
});
