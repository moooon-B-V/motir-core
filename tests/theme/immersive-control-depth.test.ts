import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-3522 — the 3D / Immersive style promises "PHYSICAL buttons with real
// thickness … Nothing is flat" (STYLE_REGISTRY['3d-immersive'].dimensions), and
// docs/styles/3d-immersive.md §4 assigns every control a plane. The stylesheet
// can only see CLASS NAMES, so that promise is bound to a set of radius
// utilities — and it silently narrows every time a surface is built on a radius
// nobody added to the rule. That is exactly how it shipped covering
// `rounded-(--radius-btn)` alone while 199 of 280 interactive controls stayed
// flat, with nothing red anywhere.
//
// So this suite is the thing that breaks. It reads the radius utilities the
// codebase ACTUALLY emits on interactive tags, and fails when one of them has
// no classification in CLASSIFICATION below — which forces a decision (§4a:
// key / quiet / flat / recessed) rather than silence. It then checks the
// classification against the shipped CSS, so the table and the stylesheet
// cannot drift apart.
//
// It asserts the CLASSIFICATION, never a COUNT: the tallies in MOTIR-3522's
// body are a reading of one commit and are expected to drift.

const REPO = process.cwd();
const SCAN_DIRS = ['app', 'components', 'packages/design-system/src'];
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'tests', 'dist', '.next']);

/** JSX tags that render something a pointer can act on. */
const INTERACTIVE_TAGS = ['button', 'a', 'Link', 'input', 'textarea', 'select', 'summary'] as const;

const OPEN_TAG = new RegExp(`<(${INTERACTIVE_TAGS.join('|')})(\\s)`, 'g');
/** `rounded-(--radius-foo)` (a shape token) or `rounded-foo` (a raw scale step). */
const RADIUS_UTILITY = /rounded-(?:\((--radius-[a-z]+)\)|(full|none|xs|sm|md|lg|xl|2xl|3xl))/g;

type Plane = 'key' | 'quiet' | 'flat' | 'recessed';

/**
 * Every radius utility this codebase puts on an interactive tag, and the plane
 * docs/styles/3d-immersive.md §4 puts it on. Adding a row is a DESIGN decision,
 * which is the point of the gate: a new control class cannot reach `main`
 * without someone naming its plane.
 *
 * `key` here means "raised BY DEFAULT, on this class alone". A token whose
 * families disagree is classified by the SAFE default (`quiet` / `flat`) and the
 * controls that need lifting out of it declare `data-depth="key"` — §4a.
 */
const CLASSIFICATION: Record<string, { plane: Plane; why: string }> = {
  '--radius-btn': {
    plane: 'key',
    why: 'The button radius. Worn by the Button primitive and by links styled as buttons — one family, and it is keys.',
  },
  '--radius-input': {
    plane: 'recessed',
    why: 'Text fields are wells. The one exception is a dropdown TRIGGER styled as an input, which the CSS raises by scoping that arm to `button`.',
  },
  '--radius-control': {
    plane: 'quiet',
    why: 'Shared by square icon buttons (keys), menu/option/full-width rows and inline text affordances. Quiet is the safe default; the `.justify-center` icon-button shape is raised out of it.',
  },
  '--radius-badge': {
    plane: 'flat',
    why: 'A chip does not float (§4). Shared with a few hero action buttons, which declare `data-depth="key"`.',
  },
  '--radius-card': {
    plane: 'flat',
    why: 'A clickable panel already floats on --shadow-card from the global panel rule; it is a surface, not a key.',
  },
  '--radius-sm': {
    plane: 'quiet',
    why: 'A raw scale step used on one full-width picker row. Rows are quiet.',
  },
  full: {
    plane: 'flat',
    why: 'Circular affordances: Switch tracks, a colour swatch, an avatar, a tag remove-×. The Plan-with-AI orb is the one key among them and declares `data-depth="key"`.',
  },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/**
 * The radius utilities that appear INSIDE an interactive element's opening tag.
 * Deliberately shallow: it reads the tag, not the component tree, because that
 * is the same thing a CSS selector can see.
 */
function emittedRadiusUtilities(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(REPO, dir))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(OPEN_TAG)) {
        // Walk to this tag's closing `>`, ignoring `>` inside JSX expressions.
        let depth = 0;
        let end = -1;
        for (let i = m.index! + m[0].length; i < src.length && i < m.index! + 8000; i += 1) {
          const c = src[i];
          if (c === '{') depth += 1;
          else if (c === '}') depth -= 1;
          else if (c === '>' && depth === 0) {
            end = i;
            break;
          }
        }
        if (end < 0) continue;
        const tag = src.slice(m.index!, end);
        for (const r of tag.matchAll(RADIUS_UTILITY)) {
          // One of the two alternates always matches, but the regex type cannot
          // say so — the `??` is exhaustive and the fallback is unreachable.
          const token = r[1] ?? r[2] ?? '';
          if (!token) continue;
          const where = `${file.slice(REPO.length + 1)}:${src.slice(0, m.index!).split('\n').length}`;
          const seen = found.get(token) ?? [];
          if (seen.length < 5) seen.push(where);
          found.set(token, seen);
        }
      }
    }
  }
  return found;
}

const THEME_CSS = readFileSync(join(REPO, 'packages/design-system/theme.css'), 'utf8');
const DEPTH_BLOCK = THEME_CSS.slice(
  THEME_CSS.indexOf('3D / Immersive — CONTROL DEPTH'),
  THEME_CSS.indexOf('3D / Immersive — DROPDOWNS'),
);

describe('3D / Immersive — control depth', () => {
  it('has a CONTROL DEPTH block to read', () => {
    expect(DEPTH_BLOCK.length).toBeGreaterThan(500);
  });

  it('classifies every radius utility the codebase emits on an interactive tag', () => {
    const emitted = emittedRadiusUtilities();
    expect(emitted.size).toBeGreaterThan(3); // the scan found something at all

    const unclassified = [...emitted.entries()]
      .filter(([token]) => !CLASSIFICATION[token])
      .map(([token, sites]) => `  rounded-${token} — e.g. ${sites.join(', ')}`);

    expect(
      unclassified,
      [
        'A control class reached main with no plane assigned.',
        'Decide it in docs/styles/3d-immersive.md §4, implement it in the',
        'CONTROL DEPTH block of packages/design-system/theme.css, then add a row',
        'to CLASSIFICATION in this file:',
        ...unclassified,
      ].join('\n'),
    ).toEqual([]);
  });

  it('raises exactly the tokens classified `key`, and no others, in the shipped CSS', () => {
    // The key set is the first rule of the block, up to its `box-shadow:`.
    const keySet = DEPTH_BLOCK.slice(0, DEPTH_BLOCK.indexOf('box-shadow:'));

    for (const [token, { plane, why }] of Object.entries(CLASSIFICATION)) {
      const cls = token.startsWith('--')
        ? String.raw`\.rounded-\\\(` + token + String.raw`\\\)`
        : String.raw`\.rounded-` + token.replace(/\./g, String.raw`\\\.`);
      // UNQUALIFIED means the whole class raises: the selector stands alone in
      // the list, with no element/shape qualifier on either side. A token that
      // appears only in a NARROWED form — `button.rounded-(--radius-input)`,
      // `:is(button, a).rounded-(--radius-control).justify-center` — is not
      // raised by default; the qualifier is exactly what keeps the rest of its
      // family off the raised plane, so it must not read as one here.
      const unqualified = new RegExp(
        String.raw`(^|[,\n])\s*` + cls + String.raw`\s*($|[,\n])`,
        'm',
      );
      expect(unqualified.test(keySet), `rounded-${token} is classified '${plane}' (${why})`).toBe(
        plane === 'key',
      );
    }
  });

  it('keeps the `data-depth` escape hatch in both directions', () => {
    expect(DEPTH_BLOCK).toContain("[data-depth='key']");
    expect(DEPTH_BLOCK).toContain("[data-depth='flat']");
  });

  it('never raises a switch, radio, checkbox, menu item or option', () => {
    const keySet = DEPTH_BLOCK.slice(0, DEPTH_BLOCK.indexOf('box-shadow:'));
    for (const role of ['switch', 'radio', 'checkbox', 'menuitem', 'option']) {
      expect(keySet, `role="${role}" must be excluded from the key set`).toContain(
        `[role='${role}']`,
      );
    }
  });

  it('recesses text fields rather than raising them', () => {
    // The `--radius-input` arm of the key set is scoped to `button` so a real
    // field can never be lifted by it.
    expect(DEPTH_BLOCK).toContain('button.rounded-\\(--radius-input\\)');
    expect(DEPTH_BLOCK).not.toContain('input.rounded-\\(--radius-input\\)');
    // …and the field itself gets an INSET.
    const recessed = DEPTH_BLOCK.slice(DEPTH_BLOCK.indexOf("[data-surface='input']"));
    expect(recessed).toMatch(/box-shadow:\s*\n?\s*inset/);
  });

  it('adds no colour token — the style and palette axes stay disjoint', () => {
    // A [data-style] block may READ --el-* but must not DEFINE a colour token.
    const declarations = DEPTH_BLOCK.match(/^\s*--(?:color|el)-[a-z-]+:/gm) ?? [];
    expect(declarations).toEqual([]);
  });
});
