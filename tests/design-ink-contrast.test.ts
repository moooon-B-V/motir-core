import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MUTED_CLASS,
  SAFE_SURFACE_TOKENS,
  TINTED_SURFACE_TOKENS,
  formatMockFinding,
  scanMock,
  violations,
} from './theme/inkContrastMockScan';

// MOTIR-3014 — the ink-contrast guard, pointed at the DESIGN ASSETS.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// `tests/theme/inkContrastLint.test.ts` scans `components/**`, `app/**`,
// `lib/**` and the design system's `src/**`. It does not scan `design/**` — and
// the design asset is the thing an implementer copies FROM. That ordering is
// not hypothetical: `components/github/DevelopmentSection.tsx` shipped
// `--el-text-muted` on `--el-surface-soft` (4.34:1, fails AA) because
// `design/work-items/repository-set.mock.html` specified it; the code guard
// caught the component on MOTIR-2725's PR, and the two assets it had been
// copied from merged clean, because nothing measured them.
//
// The constraint was not missing. It is in `CLAUDE.md`'s measured table
// (MOTIR-2455) and restated in `design/work-items/design-notes.md` about two
// hundred lines above the section that violated it. A rule written down twice
// and violated anyway is a rule nothing measures.
//
// ── What is enforced, and what is not ───────────────────────────────────────
// `inkContrastMockScan`'s header carries both boundaries in full. One line
// each: the UTILITY-CLASS layer (`text-(--el-text-muted)` written on the
// element) is enforced at zero across the whole tree; the mock's own `<style>`
// block is READ, so the surface walk is accurate, but not RULED on — it paints
// the board chrome as well as the product surface, and nothing in the markup
// tells them apart. The last describe below asserts that second population is
// non-empty, so the boundary cannot quietly outlive its subject.
//
// ── This spec belongs to the `design/*` lane ────────────────────────────────
// It reads `design/**` and nothing else, so a `design/*` branch — where the
// root Vitest job is deliberately skipped — is exactly the branch that must run
// it (MOTIR-2442). `vitest.design.config.ts` lists it, and
// `tests/ci-design-guards-lane.test.ts` re-derives that list from the tree, so
// the entry cannot rot.

const ROOT = process.cwd();
const DESIGN_ROOT = join(ROOT, 'design');

/** Every `*.mock.html` in the asset tree, as a repo-relative POSIX path. */
function mockSources(dir: string = DESIGN_ROOT, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) mockSources(path, out);
    else if (entry.endsWith('.mock.html')) out.push(relative(ROOT, path).split(sep).join('/'));
  }
  return out.sort();
}

const MOCKS = mockSources();
const TEXT_BY_MOCK = new Map(MOCKS.map((file) => [file, readFileSync(join(ROOT, file), 'utf8')]));
const FINDINGS = MOCKS.flatMap((file) => scanMock(file, TEXT_BY_MOCK.get(file)!));

describe('design ink-contrast — the scanned set is the set that was searched', () => {
  // notes.html #195, the check `inkContrastLint` opens with too: a guard is
  // worth exactly what its file set is, and a walk that silently found nothing
  // reports a clean tree. That is the one failure mode this guard must not
  // have, because it exists precisely because a clean signal was wrong once.
  it('scans a real, non-empty set of design mocks', () => {
    expect(MOCKS.length).toBeGreaterThan(100);
  });

  it.each([
    ['work-items', 'design/work-items/repository-set.mock.html'],
    ['work-items (quick view)', 'design/work-items/repository-set-quick-view.mock.html'],
    ['brand', 'design/brand/brand-mark.mock.html'],
    ['boards', 'design/boards/board.mock.html'],
  ])('reaches %s', (_area, file) => {
    expect(MOCKS).toContain(file);
  });

  it('reads mocks that actually carry the ink', () => {
    // The counterpart: a file set can be real and still be the wrong one. If
    // nothing in the scanned tree mentioned the class, the enforcement below
    // would pass by ruling on nothing at all.
    const carriers = MOCKS.filter((file) => TEXT_BY_MOCK.get(file)!.includes(MUTED_CLASS));
    expect(carriers.length).toBeGreaterThan(0);
  });
});

describe('design ink-contrast — the scanner, on fixtures it must and must not report', () => {
  // A lint whose negative case is never exercised is a lint nobody knows is
  // running (`inkContrastScan`'s own words, MOTIR-2459). Every fixture below is
  // a shape taken from the real tree, kept inline so the guard's behaviour can
  // be read without opening a 2 000-line asset.
  const wrap = (body: string, style = '') =>
    `<!doctype html><html><head><style>${style}</style></head><body>${body}</body></html>`;

  const scan = (body: string, style = '') => scanMock('fixture.mock.html', wrap(body, style));

  it('reports muted ink on each tinted surface', () => {
    for (const surface of TINTED_SURFACE_TOKENS) {
      const found = violations(
        scan(`<div class="bg-(${surface})"><p class="${MUTED_CLASS}">x</p></div>`),
      );
      expect(
        found.map((f) => f.surface),
        surface,
      ).toEqual([surface]);
    }
  });

  it('clears muted ink on each surface that IS the white page/card', () => {
    for (const surface of SAFE_SURFACE_TOKENS) {
      const found = violations(
        scan(`<div class="bg-(${surface})"><p class="${MUTED_CLASS}">x</p></div>`),
      );
      expect(found, surface).toEqual([]);
    }
  });

  it('stops the surface walk at the nearest painted ancestor', () => {
    // A white card nested inside a tinted panel ends the search — the same
    // walk `inkContrastScan.nearestSurface` performs, and the reason a false
    // positive here is not free: the cheapest way to silence one is to swap
    // the token for its identical twin, which changes no pixels and leaves a
    // colour chosen for a parser.
    const found = violations(
      scan(
        `<div class="bg-(--el-surface-soft)">` +
          `<div class="bg-(--el-card)"><p class="${MUTED_CLASS}">x</p></div></div>`,
      ),
    );
    expect(found).toEqual([]);
  });

  it('reads a background painted by the mock’s own stylesheet', () => {
    // The half a JSX scanner cannot have. A mock is self-contained, so
    // `.panel { background: var(--el-surface) }` is as knowable as the utility
    // class — and NOT reading it would abstain on the majority of the tree.
    const found = violations(
      scan(
        `<div class="panel"><p class="${MUTED_CLASS}">x</p></div>`,
        `.panel { background: var(--el-surface); }`,
      ),
    );
    expect(found.map((f) => f.surface)).toEqual(['--el-surface']);
  });

  it('does not rule on ink the stylesheet declares — it only counts it', () => {
    // Boundary (2) in the scanner's header, asserted from both sides: the
    // finding is SEEN (so the census is real) and does not FAIL the guard.
    const all = scan(
      `<div class="bg-(--el-surface)"><p class="note">x</p></div>`,
      `.note { color: var(--el-text-muted); }`,
    );
    expect(all.map((f) => f.via)).toEqual(['stylesheet']);
    expect(violations(all)).toEqual([]);
  });

  it('takes the two exemptions 1.4.3 actually grants, and no others', () => {
    const tint = (attrs: string) =>
      violations(
        scan(`<div class="bg-(--el-surface)"><p ${attrs} class="${MUTED_CLASS}">x</p></div>`),
      );
    expect(tint('aria-hidden="true"'), 'aria-hidden').toEqual([]);
    expect(tint('disabled'), 'disabled').toEqual([]);
    expect(tint('aria-disabled="true"'), 'aria-disabled').toEqual([]);
    // …and the near-misses, which are violations rather than exemptions: an
    // `aria-hidden="false"` says the opposite of the exemption, and a labelled
    // element that DOES render text is text a person reads.
    expect(tint('aria-hidden="false"'), 'aria-hidden=false').toHaveLength(1);
    expect(tint('aria-disabled="false"'), 'aria-disabled=false').toHaveLength(1);
    expect(tint('aria-label="Close"'), 'labelled but rendering text').toHaveLength(1);
  });

  it('clears a labelled control whose content is glyphs only', () => {
    const found = violations(
      scan(
        `<div class="bg-(--el-surface)">` +
          `<button aria-label="Close" class="${MUTED_CLASS}"><svg aria-hidden="true"></svg></button></div>`,
      ),
    );
    expect(found).toEqual([]);
  });

  it('addresses each finding by LINE, so a repeated row is locatable', () => {
    // The reason the scanner tokenizes rather than reaching for a DOM library:
    // a mock repeats the same row across panels, so a finding without a line
    // number cannot be found again.
    const html = wrap(
      `<div class="bg-(--el-surface)">\n<p class="${MUTED_CLASS}">a</p>\n<p class="${MUTED_CLASS}">b</p>\n</div>`,
    );
    expect(violations(scanMock('fixture.mock.html', html)).map((f) => f.line)).toEqual([2, 3]);
  });

  it('never rules on markup inside a <style> or a comment', () => {
    // The stylesheet quotes the utility class to DECLARE it
    // (`.text-\(--el-text-muted\) { … }`), and every mock in the tree does. A
    // scanner that tokenized that as markup would report the declaration.
    const style = `.text\\(--el-text-muted\\) { color: var(--el-text-muted); }`;
    const found = scan(`<!-- <p class="${MUTED_CLASS}">commented out</p> -->`, style);
    expect(found).toEqual([]);
  });
});

describe('design ink-contrast — --el-text-muted carries no text over a TINTED surface', () => {
  it('leaves no violation in any design mock', () => {
    // Derived over the scanned tree, never compared to a frozen count — the
    // sweep that made this pass measured 26 findings in 4 files, and writing 26
    // down here would turn every new asset into a reason to edit the assertion.
    expect(
      violations(FINDINGS).map(formatMockFinding).join('\n'),
      '`--el-text-muted` clears AA on the white page/card by 0.04 and fails on every tint ' +
        '(4.12–4.34:1). Give each of these `--el-text-secondary`, which is 6.18–6.80:1 on all four ' +
        'surfaces in both themes and so is right whichever surface the element lands on. If the ' +
        'element is really a glyph, say so with `aria-hidden` or a labelled `role="img"` and the ' +
        'guard will agree. And a design asset is not authority here: `CLAUDE.md`’s table is.',
    ).toBe('');
  });
});

describe('design ink-contrast — the declined half is real, and is not shrinking silently', () => {
  it('still finds muted ink the mocks’ own stylesheets declare', () => {
    // Boundary (2) of the scanner's header, kept honest. That population is
    // 277 findings across 51 files, dominated by the board chrome a mock is
    // PRESENTED on rather than the surface it specifies — the fold
    // measurements, the panel captions, the numbered annotations. Deciding
    // whether a design board's own annotations owe AA is a question about what
    // the artefact IS, and it is not this guard's to settle.
    //
    // The assertion is that the population EXISTS. If a later sweep empties it,
    // this fails — which is the intended outcome: the boundary above should be
    // reconsidered on the day it stops having a subject, not silently kept.
    const declined = FINDINGS.filter((finding) => finding.via === 'stylesheet');
    expect(
      declined.length,
      'The stylesheet-declared population is empty. If a sweep cleared it, promote the ' +
        'stylesheet layer into `violations()` and delete boundary (2) from ' +
        '`inkContrastMockScan.ts` — the exemption has outlived its subject.',
    ).toBeGreaterThan(0);
  });
});
