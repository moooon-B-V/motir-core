import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-1278 · 1266.7 — the swap-layer LINT guard.
//
// The Tier-3 contract (motir-core/CLAUDE.md, theme.css's Tier-3 header) is that
// a component renders colour ONLY through an `--el-*` element token: never a
// Tier-0 `--color-*`, never a raw hex. 1266.2–1266.6 migrated the surfaces that
// were violating it (the StatusPicker `--color-*` dot, the `bg-card` orphan);
// this guard is what stops the next component from re-introducing one.
//
// ── Why the check strips comments first ─────────────────────────────────────
// A bare `grep -r -- --color- components/` reports ~16 files today and every
// single hit is PROSE — the migration comments the family cards left behind
// ("routed through `--el-avatar-*`… was `--color-info`"). A guard that matched
// those would have to be deleted on its first run, and a guard asserted against
// a search nobody ran is its own failure mode (notes.html #195). So the scan
// strips block + line comments and asserts against CODE, and every surviving
// hit is enumerated below with the reason it is legitimate — an allowlist that
// is asserted EXACTLY, so a fixed exception must be deleted here and a new
// violation cannot hide behind an old one.

const REPO = process.cwd();

/**
 * Every TRACKED source file that can put a colour on screen — components, app
 * routes, the extracted design system, and `lib/` (where the colour LOGIC lives:
 * `lib/workflows/statusColor.ts`, `lib/issues/priorityMeta.ts`, the email
 * templates). Scanning the whole surface rather than a slice is the point: the
 * contract is not "components are clean", it is "nothing paints past the layer".
 */
function renderedSources(): string[] {
  return execFileSync(
    'git',
    [
      'ls-files',
      'components/*.tsx',
      'components/**/*.tsx',
      'components/**/*.ts',
      'app/**/*.tsx',
      'app/**/*.ts',
      'lib/**/*.tsx',
      'lib/**/*.ts',
      'packages/design-system/src/**/*.tsx',
      'packages/design-system/src/**/*.ts',
    ],
    { cwd: REPO, encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);
}

/** Drop block comments and line comments, keeping `https://` intact. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const SOURCES = renderedSources();

describe('swap-layer lint — no component reaches past the --el-* layer', () => {
  it('scans a real, non-empty set of rendered sources', () => {
    // notes.html #195: the guard has to be the search that was actually run.
    expect(SOURCES.length).toBeGreaterThan(1000);
    expect(SOURCES).toContain('components/issues/StatusPicker.tsx');
    expect(SOURCES).toContain('packages/design-system/src/components/ui/Pill.tsx');
    expect(SOURCES).toContain('lib/workflows/statusColor.ts');
  });

  it('references no Tier-0 --color-* token outside the /tokens specimen route', () => {
    // The ONE legitimate consumer: `/tokens` is the design-system reference
    // page, whose whole job is to render the Tier-0 scale as labelled swatches.
    const ALLOWED = ['app/tokens/page.tsx'];

    const offenders = SOURCES.filter((file) =>
      /--color-/.test(stripComments(readFileSync(join(REPO, file), 'utf8'))),
    );
    expect(offenders.sort()).toEqual(ALLOWED);
  });

  it('hardcodes no raw hex colour outside the documented non-themeable surfaces', () => {
    // A hex in code cannot re-skin — it is invisible to all three axes. These
    // are the surfaces where that is the CORRECT behaviour.
    //
    // Email templates are allowed as a DIRECTORY, not file-by-file: mail clients
    // strip `<style>` and do not support custom properties, so every template
    // must inline hex, and a new template is not a new decision. (Listing the
    // ten current files instead would go stale the day an eleventh lands — the
    // rule is to write the assertion as a derivation, never a frozen roster.)
    const ALLOWED_PREFIXES = ['lib/emailTemplates/'];
    const ALLOWED = [
      // Third-party BRAND marks. Google's logo is Google's colours; re-tinting
      // it per palette would misrepresent the brand (and breach its guidelines).
      'app/(auth)/_components/GoogleButton.tsx',
      'app/(authed)/settings/account/_components/PasswordSecurityCard.tsx',
      // Open Graph images are rasterised at the edge by Satori, which never
      // sees the stylesheet — there is no cascade to read a token from.
      'app/(public)/explore/opengraph-image.tsx',
      'app/(public)/p/[identifier]/opengraph-image.tsx',
      // The brand mark's BAKED-COLOUR literals (MOTIR-1150). The glyph itself
      // paints `currentColor` and follows the theme everywhere it is inline —
      // but `currentColor` resolves to BLACK through an <img src>, as a favicon,
      // and inside next/og, so those four surfaces (the icon set, the manifest's
      // two colours, the OG cards, the email header) need the value baked. This
      // module is where the bake happens ONCE, with each literal naming the
      // token it came from, rather than the hex being retyped at four call
      // sites. It renders nothing itself.
      'components/brand/waveBand.ts',
      // The appearance PREVIEW swatches must show each palette's OWN literal
      // colours side by side, so they cannot resolve through the active one.
      'packages/design-system/src/components/theme/AppearancePickers.tsx',
      // Label / avatar colour picker: the swatch shows the colour being chosen,
      // and the chosen key is PERSISTED — the swatch is data, not chrome.
      'packages/design-system/src/components/ui/ColorSwatchPicker.tsx',
      // The palette REGISTRY. Its hexes are PROSE inside the `inspiration`
      // strings — the documented source-brand codes each palette was built from
      // ("the bold gold #F0B90B/#FCD535 over … #0B0E11"). Provenance a reader
      // can check, in a string literal rather than a comment, so the
      // comment-stripping pass cannot see it. Nothing here is rendered.
      'packages/design-system/src/theme/palettes.ts',
    ];

    const offenders = SOURCES.filter(
      (file) =>
        !ALLOWED_PREFIXES.some((prefix) => file.startsWith(prefix)) &&
        /#[0-9a-fA-F]{3,8}\b/.test(stripComments(readFileSync(join(REPO, file), 'utf8'))),
    );
    expect(offenders.sort()).toEqual([...ALLOWED].sort());

    // The prefix must still be earning its keep — if the email templates ever
    // stop inlining hex, this exemption should be deleted, not left standing.
    expect(SOURCES.some((file) => file.startsWith('lib/emailTemplates/'))).toBe(true);
  });
});

describe('swap-layer lint — the specific orphans 1266.2 / 1266.4 closed stay closed', () => {
  it('leaves no `bg-card` orphan (1266.4 gave the untinted card its own --el-card)', () => {
    // `bg-card` was a Tailwind utility with no `--color-card` behind it — it
    // painted nothing. The fix was the `--el-card` token, not the utility.
    const orphans = SOURCES.filter((file) =>
      /\bbg-card\b/.test(readFileSync(join(REPO, file), 'utf8')),
    );
    expect(orphans).toEqual([]);
    expect(readFileSync(join(REPO, 'packages/design-system/theme.css'), 'utf8')).toMatch(
      /--el-card\s*:/,
    );
  });

  it('keeps the StatusPicker on the element layer (the one true 1266.2 violation)', () => {
    const picker = readFileSync(join(REPO, 'components/issues/StatusPicker.tsx'), 'utf8');
    expect(stripComments(picker)).not.toMatch(/--color-/);
    expect(picker).toContain('statusDotColor');
  });
});
