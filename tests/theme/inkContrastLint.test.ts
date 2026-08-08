import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAINT_CLASS, formatFinding, scanSource, violations } from './inkContrastScan';

// MOTIR-2475 — the repo-wide INK-CONTRAST guard, pointed at the tree by the
// sweep that made it passable.
//
// MOTIR-2455 measured `--el-text-faint` at 2.37–2.61:1 on all four surfaces in
// both themes: it clears AA on none of them. That leaves it exactly two
// legitimate jobs — a decorative glyph whose meaning lives in a label, and
// disabled / inactive text, which WCAG 1.4.3 exempts. Both are STRUCTURE, which
// is why the check is the MOTIR-2459 parser rather than a grep: the parser sees
// the element the class lands on and can say which of the three cases it is.
//
// ── Why this guard has no allowlist ─────────────────────────────────────────
// `swapLayerLint` (the mould this follows) enumerates its exceptions, because
// a Tier-0 hex in an email template is genuinely correct and there is nowhere
// else to put it. Here there is no such case: every faint site is either text,
// which takes `--el-text-secondary` (6.18–6.80:1 everywhere, in both themes),
// or a glyph, which is fixed by SAYING SO on the element — `aria-hidden`, or a
// labelled `role="img"`. Both fixes cost one edit, so an exemption would only
// ever be a defect with a comment attached. A file-scoped escape hatch is also
// what would make the rule optional: the sweep covered the whole tree at once
// precisely so that nobody has to wonder whether their surface is in scope.
//
// ── Why the MUTED arm is not on here ────────────────────────────────────────
// The scanner rules on `--el-text-muted` too, and 130 of those findings stand
// today. That ink fails only on TINTED surfaces, so its verdict depends on an
// ancestor background — which the scanner can only resolve inside one file, and
// abstains on when a `<Card>` in another module paints it. That is a different
// sweep with a different blind spot (MOTIR-2477); turning it on here would have
// made this diff unreviewable. This guard therefore asserts on the FAINT ink
// only, and says so out loud rather than leaving the silence to be read as
// coverage.

const REPO = process.cwd();

/**
 * Every TRACKED source file that can put ink on screen. The same four roots
 * `swapLayerLint` scans, for the same reason: the contract is not "components
 * are clean", it is "nothing paints unreadable text anywhere".
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

const SOURCES = renderedSources();

/**
 * Every scanned file's text, read ONCE. Both describes below need it, and a
 * second `readFileSync` pass over 1703 files is pure cost.
 */
const TEXT_BY_FILE = new Map(SOURCES.map((file) => [file, readFileSync(join(REPO, file), 'utf8')]));

/**
 * The files worth PARSING. `scanSource` can only report a faint finding for a
 * file whose text contains the class, so a substring pre-filter is not a
 * sampling of the tree — it is the same answer without building 1600 ASTs that
 * cannot produce one. It matters: parsing every file took the whole 15s test
 * budget on a loaded CI shard, and a guard that times out is a guard that
 * teaches people to rerun it.
 */
const CARRIERS = SOURCES.filter((file) => TEXT_BY_FILE.get(file)!.includes(FAINT_CLASS));

describe('ink-contrast lint — the scanned set is the set that was searched', () => {
  // notes.html #195: a guard is only worth what its file set is. A `ls-files`
  // glob that silently matches nothing reports a clean tree, which is the one
  // failure mode this check exists to make impossible — so each ROOT has to
  // prove it is present, not just the total.
  it('scans a real, non-empty set of rendered sources', () => {
    expect(SOURCES.length).toBeGreaterThan(1000);
  });

  it.each([
    ['app', 'app/(authed)/backlog/_components/BacklogRow.tsx'],
    ['components', 'components/issues/EstimateBadge.tsx'],
    ['lib', 'lib/workflows/statusColor.ts'],
    ['packages/design-system/src', 'packages/design-system/src/components/ui/Segmented.tsx'],
  ])('reaches into %s', (_root, file) => {
    expect(SOURCES).toContain(file);
  });

  it('reads files that actually carry the ink under measurement', () => {
    // The counterpart to the check above: a file set can be real and still be
    // the wrong one. If NOTHING in the scanned tree mentions the token, the
    // guard is watching a tree the ink does not live in — and the pre-filter
    // below would then make it pass by scanning nothing at all.
    expect(CARRIERS.length).toBeGreaterThan(0);
  });
});

describe('ink-contrast lint — --el-text-faint carries no active informational text', () => {
  it('leaves no faint violation anywhere in the scanned tree', () => {
    // Derived over the scanned set, never compared to a frozen count: the sweep
    // that made this pass measured 132 defects, and writing 132 down here would
    // turn every new file into a reason to edit the assertion.
    const offenders = CARRIERS.flatMap((file) =>
      violations(scanSource(file, TEXT_BY_FILE.get(file)!)),
    ).filter((finding) => finding.ink === 'faint');

    expect(
      offenders.map(formatFinding).join('\n'),
      'Every one of these paints text at 2.37–2.61:1. Give it `--el-text-secondary` ' +
        '(6.18–6.80:1 on every surface, both themes); if the element is really a glyph, ' +
        'say so with `aria-hidden` or a labelled `role="img"` and the guard will agree.',
    ).toBe('');
  });
});
