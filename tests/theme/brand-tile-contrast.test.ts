import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-2557 — the shell brand tile's glyph-on-fill contrast
// (`design/shell/design-notes.md` § *The context row* → *The brand tile*).
//
// ── WHY THIS TEST EXISTS AT ALL ─────────────────────────────────────────────
// The repo already guards ink contrast — `tests/theme/inkContrastLint.test.ts`
// — and it CANNOT see this pair. That guard reads `className` strings out of
// the AST and reasons about the ink/surface tokens it finds named together on
// one element. Here the ink is not in a className: the glyph takes its colour
// from `.brand-glyph` in `app/globals.css`, and only the FILL is a utility. So
// the lint passes whatever the fill is, including one the mark disappears into.
// A green guard is not evidence about this pair, which is exactly the shape of
// defect that ships looking fine to whoever picked it on a good monitor.
//
// ── AND IT ASSERTS EVERY PALETTE, NOT JUST THE DEFAULT ──────────────────────
// The design measured the default palette (6.03:1 light, 4.24:1 dark) and
// pinned two tokens. But `data-palette` is a shipped axis: ten more palettes
// re-point `--color-primary` and `--color-surface` TOGETHER, and the tile is a
// NEW coloured surface, so each of them is a pair nobody had reason to check
// before this card. Deriving the ratio from the token CHAIN rather than from
// hexes is what makes that cheap — and what makes a future palette that breaks
// the pair fail HERE rather than in a screenshot nobody takes.
//
// WCAG 1.4.11 (non-text contrast) asks 3:1 for a graphical object that carries
// meaning. All 21 blocks clear it today; the lowest is the default dark.

const ROOT = resolve(import.meta.dirname, '../..');
const THEME = readFileSync(resolve(ROOT, 'packages/design-system/theme.css'), 'utf8');
const TOP_NAV = readFileSync(resolve(ROOT, 'app/(authed)/_components/TopNav.tsx'), 'utf8');
const GLOBALS = readFileSync(resolve(ROOT, 'app/globals.css'), 'utf8');

interface Rule {
  selector: string;
  body: string;
}

/** Every TOP-LEVEL rule in theme.css, selector and body.
 *
 *  A substring search for `[data-theme='dark']` is the trap here: eighteen
 *  selectors contain it, seventeen of them palette-qualified
 *  (`[data-palette='candy'][data-theme='dark']`), so both "first match" and
 *  "last match" read the wrong block — one silently returns a LIGHT value, the
 *  other the last palette's. The selector has to be matched exactly. */
function topLevelRules(): Rule[] {
  const out: Rule[] = [];
  let selectorStart = 0;
  for (let i = 0; i < THEME.length; i++) {
    if (THEME[i] !== '{') continue;
    const selector = THEME.slice(selectorStart, i).trim();
    let depth = 0;
    let end = -1;
    for (let j = i; j < THEME.length; j++) {
      if (THEME[j] === '{') depth++;
      else if (THEME[j] === '}' && --depth === 0) {
        end = j;
        break;
      }
    }
    if (end === -1) break;
    out.push({ selector, body: THEME.slice(i + 1, end) });
    i = end;
    selectorStart = end + 1;
  }
  return out;
}

const RULES = topLevelRules();
const HEX = /^#[0-9a-f]{6}$/i;

function declaration(body: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(body);
  return m?.[1]?.trim() ?? null;
}

/** The `--color-*` token an `--el-*` token aliases.
 *
 *  Read from the file rather than from a located BLOCK: the Tier-3 layer is
 *  declared once, and finding "the :root rule" is the part that is fiddly —
 *  theme.css nests, so a top-level walk does not necessarily surface it. The
 *  alias itself is unambiguous. */
function tier0Alias(el: string): string {
  const m = new RegExp(`${el}\\s*:\\s*var\\((--color-[a-z0-9-]+)\\)`).exec(THEME);
  if (!m?.[1]) throw new Error(`${el} does not alias a --color-* token`);
  return m[1];
}

function relativeLuminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(ch[0]!) + 0.7152 * lin(ch[1]!) + 0.0722 * lin(ch[2]!);
}

function contrast(a: string, b: string): number {
  const ls = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (ls[0]! + 0.05) / (ls[1]! + 0.05);
}

/** Every block that declares BOTH sides of the pair — i.e. every theme the tile
 *  can actually render under. */
function pairs(): { selector: string; glyph: string; fill: string }[] {
  const glyphToken = tier0Alias('--el-accent-on-surface');
  const fillToken = tier0Alias('--el-surface');
  return RULES.flatMap((r) => {
    const glyph = declaration(r.body, glyphToken);
    const fill = declaration(r.body, fillToken);
    if (!glyph || !fill || !HEX.test(glyph) || !HEX.test(fill)) return [];
    return [{ selector: r.selector.split('\n').pop()!.trim(), glyph, fill }];
  });
}

describe('the shell brand tile (MOTIR-2557)', () => {
  it('paints the mark’s box with the tokens the design pinned', () => {
    const link = /<Link\s+href="\/dashboard"[\s\S]*?className="([^"]+)"/.exec(TOP_NAV);
    expect(link, 'the brand slot is a Link to /dashboard').toBeTruthy();
    const classes = link![1]!.split(/\s+/);

    expect(classes).toContain('bg-(--el-surface)');
    expect(classes).toContain('border');
    expect(classes).toContain('border-(--el-border)');
    // the geometry is untouched — this card paints, it does not resize
    expect(classes).toContain('h-8');
    expect(classes).toContain('w-8');
    expect(classes).toContain('rounded-(--radius-control)');
    expect(classes).toContain('md:flex');
  });

  it('leaves the glyph’s GLOBAL rule alone — five other brand surfaces share it', () => {
    // `.brand-glyph` is the colour of the auth card, ExploreTopBar,
    // PublicTopBar, the OG images and the specimen. The tile was chosen so this
    // rule would not have to move; asserting it is what stops a later "just
    // darken the glyph a bit" from repainting all of them.
    expect(GLOBALS).toMatch(/\.brand-glyph\s*\{[^}]*color:\s*var\(--el-accent-on-surface\)/);
  });

  it('drops the divider the tile’s own edge replaced', () => {
    // §7a introduced a hairline to say the brand sits outside the tier
    // hierarchy. The tile says that now, and the 9px goes back to the row.
    expect(TOP_NAV).not.toMatch(/h-5 w-px[^"]*bg-\(--el-border\)/);
  });

  it('finds the pair declared by every theme the tile renders under', () => {
    const found = pairs();
    // the default (@theme + its light/dark blocks) plus the palette axis
    expect(found.length).toBeGreaterThanOrEqual(21);
    expect(found.map((p) => p.selector)).toContain("[data-theme='dark']");
    expect(found.map((p) => p.selector)).toContain("[data-palette='candy'][data-theme='dark']");
  });

  it('clears WCAG 1.4.11’s 3:1 for the graphic in EVERY palette and theme', () => {
    const failing = pairs()
      .map((p) => ({ ...p, ratio: contrast(p.glyph, p.fill) }))
      .filter((p) => p.ratio < 3);

    expect(
      failing.map((p) => `${p.selector}: ${p.glyph} on ${p.fill} = ${p.ratio.toFixed(2)}:1`),
      'the brand mark must stay legible on its own tile under every palette',
    ).toEqual([]);
  });

  it('still measures what the design measured — 6.03:1 light, 4.24:1 dark', () => {
    // The design's own numbers, re-derived. Drift here is not automatically a
    // failure (the pair may still clear 3:1, and the check above is the one
    // that gates), but it means the asset and the app disagree and one of them
    // needs amending ON THE RECORD.
    const bySelector = new Map(pairs().map((p) => [p.selector, p]));
    const light = bySelector.get("[data-theme='light']")!;
    const dark = bySelector.get("[data-theme='dark']")!;
    expect(contrast(light.glyph, light.fill)).toBeCloseTo(6.03, 1);
    expect(contrast(dark.glyph, dark.fill)).toBeCloseTo(4.24, 1);
  });
});
