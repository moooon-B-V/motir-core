import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAINT_CLASS, MUTED_CLASS, formatFinding, scanSource, violations } from './inkContrastScan';

// MOTIR-2475 / MOTIR-2477 — the repo-wide INK-CONTRAST guard, pointed at the
// tree by the two sweeps that made it passable: the faint arm below is
// MOTIR-2475's, the muted arm MOTIR-2477's.
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
// ── The MUTED arm, and the half of the tree it CANNOT rule on ───────────────
// MOTIR-2477 swept the 130 muted findings that stood here and turned its arm
// on. That ink is a different shape of defect: `--el-text-muted` is 4.54:1 on
// the white page/card — legal, by 0.04 — and 4.12–4.34:1 on `--el-surface`,
// `--el-surface-soft` and `--el-muted`. No site is a defect on its own; the
// verdict is a property of the ink AND the background under it.
//
// ⚠️ SO THIS ARM'S GREEN IS NARROWER THAN THE FAINT ARM'S, and the difference is
// structural, not a backlog item. `nearestSurface` walks up the JSX tree WITHIN
// ONE FILE. An element whose background is painted by a `<Card>`, a
// `<Popover.Content>` or a layout in ANOTHER module reads as "no surface found
// here" and the rule ABSTAINS — it does not rule the site safe, it declines to
// rule at all. Cross-component surface inheritance is out of reach by
// construction, so a green muted arm means "no muted ink over a tint a single
// file could prove", never "no muted ink over a tint".
//
// Two narrower edges of the same boundary, for whoever widens this later:
//   • A CONDITIONAL background (`selected && 'bg-(--el-surface-soft)'`) reads as
//     tinted for every branch, because the surface lookup matches the className
//     blob and cannot correlate a branch with the ink beside it. That direction
//     over-reports, which is the safe way to be wrong; MOTIR-2477 fixed those
//     sites rather than teaching the walk to correlate.
//   • The walk stops at the first ancestor that paints ANY background, so a
//     white `--el-card` nested inside a tinted panel correctly ends the search.
// Widening the surface resolution across module boundaries needs the import
// graph, not this walk. (MOTIR-2489 is the open card on the scanner's element
// resolution; it is a different axis from this one.)

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
 * The files worth PARSING, per ink. `scanSource` can only report a finding for
 * a file whose text contains the class, so a substring pre-filter is not a
 * sampling of the tree — it is the same answer without building 1600 ASTs that
 * cannot produce one. It matters: parsing every file took the whole 15s test
 * budget on a loaded CI shard, and a guard that times out is a guard that
 * teaches people to rerun it.
 *
 * The two arms carry SEPARATE sets rather than one union: each arm's file set
 * is what its own "reads files that carry the ink" check proves, and a union
 * would let a muted-only tree satisfy the faint check (and the reverse).
 */
const FAINT_CARRIERS = SOURCES.filter((file) => TEXT_BY_FILE.get(file)!.includes(FAINT_CLASS));
const MUTED_CARRIERS = SOURCES.filter((file) => TEXT_BY_FILE.get(file)!.includes(MUTED_CLASS));

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

  it.each([
    ['--el-text-faint', FAINT_CARRIERS],
    ['--el-text-muted', MUTED_CARRIERS],
  ])('reads files that actually carry %s', (_ink, carriers) => {
    // The counterpart to the check above: a file set can be real and still be
    // the wrong one. If NOTHING in the scanned tree mentions the token, the
    // guard is watching a tree the ink does not live in — and the pre-filter
    // below would then make it pass by scanning nothing at all. Asserted per
    // INK, because the muted arm survives a sweep that empties the tree of the
    // faint one and would otherwise inherit its proof.
    expect(carriers.length).toBeGreaterThan(0);
  });
});

describe('ink-contrast lint — --el-text-faint carries no active informational text', () => {
  it('leaves no faint violation anywhere in the scanned tree', () => {
    // Derived over the scanned set, never compared to a frozen count: the sweep
    // that made this pass measured 132 defects, and writing 132 down here would
    // turn every new file into a reason to edit the assertion.
    const offenders = FAINT_CARRIERS.flatMap((file) =>
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

describe('ink-contrast lint — --el-text-muted carries no text over a TINTED surface', () => {
  it('leaves no muted violation the scanner can resolve a surface for', () => {
    // Derived over the scanned set, never compared to a frozen count: the sweep
    // that made this pass measured 130 defects across 75 files, and writing 130
    // down here would turn every new file into a reason to edit the assertion.
    //
    // Read the name of this test literally. It is "no violation the scanner can
    // resolve a surface for", not "no violation" — the abstention documented at
    // the top of this file is the whole difference, and a rename that drops it
    // would be claiming coverage this arm does not have.
    const offenders = MUTED_CARRIERS.flatMap((file) =>
      violations(scanSource(file, TEXT_BY_FILE.get(file)!)),
    ).filter((finding) => finding.ink === 'muted');

    expect(
      offenders.map(formatFinding).join('\n'),
      '`--el-text-muted` clears AA on the white page/card by 0.04 and fails on every tint ' +
        '(4.12–4.34:1). Give each of these `--el-text-secondary`, which is 6.18–6.80:1 on all ' +
        'four surfaces in both themes and so is right whichever surface the element lands on. ' +
        'Moving the element onto `--el-card` also fixes the pair, but it changes layout intent — ' +
        'reach for the ink first.',
    ).toBe('');
  });
});
