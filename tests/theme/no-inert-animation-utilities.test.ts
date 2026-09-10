import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, stripComments } from '../helpers/importGraph';

// MOTIR-4889 — the `tailwindcss-animate` VOCABULARY, at zero.
//
// ── The defect this exists to prevent ───────────────────────────────────────
// `animate-in`, `animate-out`, `fade-in-0`, `zoom-in-95`, `slide-in-from-top-2`
// are not Tailwind utilities. They come from the `tailwindcss-animate` /
// `tw-animate-css` PLUGIN, which this repository has never installed:
//
//   grep -n 'animate' package.json packages/design-system/package.json  → 0
//   grep -n 'animate' pnpm-lock.yaml                                    → 0
//   ls node_modules/.pnpm | grep -i animate                             → 0
//
// `app/globals.css` imports exactly three things — `tailwindcss`,
// `@motir/design-system/theme.css` and `@motir/brand/brand.css` — and none of
// them declares an `enter` / `exit` keyframe, an `--animate-in` theme key or a
// `--tw-enter-*` property. So the class is emitted into the DOM, matches no
// rule, and the element renders with no animation at all.
//
// Four shipped components had asked for one for their whole lives (measured on
// `origin/main` at `5135085852f0`): `Popover.tsx:98`, `Tooltip.tsx:47`,
// `Toast.tsx:25-26` and `components/ui/Sidebar.tsx:281`.
//
// ── Why nothing else catches it ────────────────────────────────────────────
// It fails in the one direction this project has no instrument for. A missing
// animation is invisible in a screenshot, invisible in a DOM assertion, and
// invisible to `design-ink-contrast`, `design-state-ink-contrast`,
// `design-token-layer` and `design-dark-parity` — every one of which reads what
// a rule SAYS rather than whether any rule APPLIES. For shipped app code the
// compiler is supposed to answer that, and for a class the compiler does not
// recognise it has nothing to say. The class list also reads as deliberate and
// well-formed, which is how it was transcribed verbatim into two design mocks —
// where `tests/design-mock-utility-correspondence.test.ts` (MOTIR-4687), the one
// guard that DOES ask whether a rule applies, finally reported it from the asset
// side, seven months after the components shipped (MOTIR-4813).
//
// ── Why the disposition was DELETE and not INSTALL ─────────────────────────
// Overlay motion in this design system is the THEME's, not a component's.
// `packages/design-system/theme.css` declares `@keyframes immersive-menu-open`
// and applies it to `[data-surface='popover'], [data-menu-surface]` inside
// `@scope ([data-style='3d-immersive'])`, gated behind
// `prefers-reduced-motion: no-preference` — and deliberately withholds it from
// toasts and drag overlays ("so a drag-overlay or toast doesn't unexpectedly
// fold open"). Motion is a per-STYLE decision, taken once, in the layer that can
// express it. A class list on a primitive cannot: it forces one motion on all
// eleven styles and lands a second `animation` declaration on the very elements
// the theme already animates. Installing the plugin would not have made the
// shipped code true — it would have added a competing mechanism for something
// the design system already owns.
//
// ── The scope, and what is deliberately outside it ─────────────────────────
// `app/`, `components/` and `packages/design-system/src/` — everything that
// compiles against this `@theme`. `design/**` is NOT scanned: a `*.mock.html`
// ships its own inlined vanilla stylesheet and is covered by
// `tests/design-mock-utility-correspondence.test.ts`, which asks the same
// question of an asset. Nor is `lib/`, which paints nothing.
//
// ── The BAN is the plugin's vocabulary, not the four classes that were here ─
// Banning only the four utilities the four sites happened to carry would let
// `zoom-in-95` in tomorrow, which is the same defect one word over. What is
// banned is every utility that exists ONLY with the plugin installed. Tailwind
// core's own animation utilities are NOT touched — `animate-spin` (used on
// every spinner, with `prefers-reduced-motion` handled in `theme.css` per
// MOTIR-3844), `animate-pulse`, `animate-none`, `animate-[…]`, and the
// `duration-*` / `delay-*` / `ease-*` modifiers, all of which compile.
//
// ── COMMENTS ARE NOT CODE, and here that is load-bearing ───────────────────
// `Popover.tsx` names `animate-in` / `fade-in-0` in a comment, precisely so the
// next person to reach for the class list finds the reason at the site. A guard
// built on a raw `grep` would fail on the documentation that exists to prevent
// the defect, and the only way to make it pass would be to blunt that warning
// into uselessness. The scan therefore reads `stripComments`'d source, the same
// scanner `tests/theme/namedMaxWidthUtilities.test.ts` uses for the same reason.
// It blanks comments to SPACES, so reported line numbers stay true.

const SCAN_ROOTS = ['app', 'components', 'packages/design-system/src'] as const;

/**
 * A `tailwindcss-animate` utility, as it appears in a class list.
 *
 * The leading guard is what lets a VARIANT through the front door
 * (`data-[state=open]:animate-in`, `sm:fade-in-0` — `:` is not a word character,
 * so the utility is still matched) while keeping core Tailwind out:
 * `cursor-zoom-in` is not `zoom-in`, because the `-` before `zoom` is part of a
 * longer name. The trailing guard keeps `animate-in` from matching inside a
 * hypothetical `animate-into`, and lets the numeric suffix the plugin's
 * percentage steps carry (`fade-in-0`, `zoom-in-95`, `slide-in-from-top-2`) be
 * part of the match rather than a boundary violation.
 *
 * `animate-spin` / `animate-pulse` / `animate-none` / `animate-[…]` are Tailwind
 * CORE and are deliberately absent from the alternation.
 */
const PLUGIN_ANIMATION_UTILITY =
  /(?<![\w-])(?:animate-(?:in|out)|(?:fade|zoom|spin)-(?:in|out)(?:-\d+)?|slide-(?:in-from|out-to)-(?:top|bottom|left|right)(?:-\d+)?|fill-mode-(?:none|forwards|backwards|both))(?![\w-])/g;

/**
 * The same pattern without `g`, for `.test()`.
 *
 * A global regex carries `lastIndex` between calls, so `.test()` on one is
 * order-dependent and answers `false` on a string it just matched. Not a
 * hypothetical: it is how a guard reports a clean tree on its second file.
 */
const PLUGIN_ANIMATION_UTILITY_ONCE = new RegExp(PLUGIN_ANIMATION_UTILITY.source);

/** Every scannable source file under `dir`, repo-relative with `/` separators. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    // `.css` is in because `@apply animate-in` is the same declaration in a
    // second vocabulary, and it fails the same silent way.
    else if (/\.(tsx?|css)$/.test(entry)) out.push(relative(REPO_ROOT, full).split(sep).join('/'));
  }
  return out;
}

const SOURCE_FILES = SCAN_ROOTS.flatMap((root) => walk(join(REPO_ROOT, root)));

interface Offence {
  file: string;
  line: number;
  utility: string;
  /** The source line, for a failure a reader can act on without opening the file. */
  text: string;
}

/** Every plugin animation utility written as CODE (not in a comment) in `files`. */
function offencesIn(files: readonly string[]): Offence[] {
  const found: Offence[] = [];
  for (const file of files) {
    const code = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
    code.split('\n').forEach((text, index) => {
      for (const match of text.matchAll(PLUGIN_ANIMATION_UTILITY)) {
        found.push({ file, line: index + 1, utility: match[0], text: text.trim() });
      }
    });
  }
  return found;
}

describe('`tailwindcss-animate` utilities (MOTIR-4889)', () => {
  it('finds source files at all — the scan is not vacuous', () => {
    // Without this, the assertion below passes on an empty set, which is how a
    // totality check dies quietly.
    expect(SOURCE_FILES.length).toBeGreaterThan(400);
    expect(SOURCE_FILES).toContain('packages/design-system/src/components/ui/Popover.tsx');
    expect(SOURCE_FILES).toContain('components/ui/Sidebar.tsx');
  });

  it('the pattern MATCHES the shapes it is written for, and only those', () => {
    // The negative control. A guard whose regex has stopped matching reports a
    // clean tree in exactly the same words as a tree that is clean. Every
    // offending line below is one that stood on `origin/main` before this card,
    // or is the next step of the same vocabulary.
    const offending: readonly [string, number][] = [
      ["'data-[state=open]:animate-in data-[state=closed]:animate-out fade-in-0 fade-out-0',", 4],
      ["'data-[state=delayed-open]:animate-in data-[state=closed]:animate-out fade-in-0'", 3],
      ["'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-80',", 2],
      ['<Collapsible.Content className="data-[state=closed]:animate-out">', 1],
      ['<div className="zoom-in-95 slide-in-from-top-2">', 2],
      ['<div className="spin-out-90 fill-mode-forwards">', 2],
      ['<div className="fade-in slide-out-to-right">', 2],
      ['@apply animate-in fade-in-0;', 2],
    ];
    for (const [line, count] of offending) {
      expect(
        [...line.matchAll(PLUGIN_ANIMATION_UTILITY)].map((m) => m[0]),
        `missed: ${line}`,
      ).toHaveLength(count);
    }

    const allowed = [
      '<Loader2 className="size-4 animate-spin" aria-hidden />', // Tailwind core
      '<div className="animate-pulse animate-none">',
      '<div className="animate-[wiggle_1s_ease-in-out_infinite]">',
      '<div className="cursor-zoom-in cursor-zoom-out">', // a longer name, not the utility
      '<div className="duration-200 delay-150 ease-in-out ease-out ease-in">',
      "animation: 'immersive-menu-open 200ms'", // the theme's own mechanism
      'const FADE_IN = 0;',
      '<div className="transition-opacity motion-reduce:transition-none">',
    ];
    for (const line of allowed) {
      expect(
        [...line.matchAll(PLUGIN_ANIMATION_UTILITY)].map((m) => m[0]),
        `false positive: ${line}`,
      ).toEqual([]);
    }
  });

  it('the COMMENT explaining the trap is not an offence — the warning survives', () => {
    // The guard must not be satisfiable by deleting the documentation that
    // exists to prevent the defect. `Popover.tsx` carries the class names in
    // prose and nowhere else; if `stripComments` ever stops being applied, it is
    // the file that goes red first, and the "fix" would be to blunt it.
    const file = 'packages/design-system/src/components/ui/Popover.tsx';
    const raw = readFileSync(join(REPO_ROOT, file), 'utf8');
    expect(PLUGIN_ANIMATION_UTILITY_ONCE.test(raw), `${file} no longer documents the trap`).toBe(
      true,
    );
    expect(offencesIn([file]), `${file} writes a plugin utility as CODE`).toEqual([]);
  });

  it('NO file under app/, components/ or packages/design-system/src/ writes one', () => {
    const offences = offencesIn(SOURCE_FILES);
    const report = offences.map((o) => `  ${o.file}:${o.line}  ${o.utility}  ${o.text}`).join('\n');
    expect(
      offences,
      `A \`tailwindcss-animate\` utility generates NOTHING here — the plugin is not\n` +
        `installed and no keyframe, theme key or custom property stands in for one, so\n` +
        `the element renders with no animation and nothing reports it.\n` +
        `Overlay motion is the THEME's: declare it in \`packages/design-system/theme.css\`\n` +
        `against the surface's \`data-surface\` / \`data-menu-surface\` hook, scoped to the\n` +
        `style it belongs to and gated behind \`prefers-reduced-motion\` — see the\n` +
        `\`immersive-menu-open\` block. See MOTIR-4889 and this file's header.\n${report}`,
    ).toEqual([]);
  });
});
