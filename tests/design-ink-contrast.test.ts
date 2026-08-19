import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FAINT_CLASS,
  MUTED_CLASS,
  SAFE_SURFACE_TOKENS,
  TINTED_SURFACE_TOKENS,
  counted,
  formatMockFinding,
  scanMock,
  violations,
} from './theme/inkContrastMockScan';

// MOTIR-3014 / MOTIR-3054 — the ink-contrast guard, pointed at the DESIGN ASSETS.
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
// `inkContrastMockScan`'s header carries both in full. One line each: the MUTED
// arm is enforced at zero across the whole tree, over BOTH layers a mock paints
// in — the `text-(--el-text-muted)` utility written on the element AND the
// mock's own `<style>` block. MOTIR-3014 shipped enforcing only the first and
// declined the second (277 findings, 51 files) pending a decision about whether
// a design board's own chrome owes AA; MOTIR-3054 decided it does
// (`docs/decisions/design-board-chrome-aa.md`), swept all 277, and removed the
// filter. The FAINT arm is COUNTED and not ruled on — 1745 findings across 101
// files, declined for SIZE and nothing else, owned by MOTIR-3068. The last
// describe below asserts that population is non-empty, so the one remaining
// boundary cannot quietly outlive its subject.
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

  it('rules on ink the stylesheet declares, exactly as it rules on the utility class', () => {
    // MOTIR-3054 removed the `via === 'class'` filter this fixture used to
    // assert the other way round. The layer an ink is WRITTEN in changes
    // nothing about the pixels it puts on screen, so it changes nothing about
    // the verdict — and 51 of the tree's assets painted the failing pair from
    // here rather than from a class.
    const found = violations(
      scan(
        `<div class="bg-(--el-surface)"><p class="note">x</p></div>`,
        `.note { color: var(--el-text-muted); }`,
      ),
    );
    expect(found.map((f) => f.via)).toEqual(['stylesheet']);
    expect(found.map((f) => f.surface)).toEqual(['--el-surface']);
  });

  it('rules on ink an inline style attribute declares', () => {
    // The third way a mock writes an ink, and 15 of the 277 sites MOTIR-3054
    // swept were this one. It is reported as `stylesheet` rather than as a
    // fourth `via`: what that field records is whether the ink is in the
    // Tailwind-shaped layer a mock is supposed to be built from.
    const found = violations(
      scan(`<div class="bg-(--el-muted)"><p style="color: var(--el-text-muted)">x</p></div>`),
    );
    expect(found.map((f) => f.via)).toEqual(['stylesheet']);
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

  it('reads a DESCENDANT rule, and a CHILD and COMPOUND one (MOTIR-3122)', () => {
    // The blind spot this widening closes. `.zoomctl .pct { color: faint }`
    // paints `80%` on screen in EVERY render, and the bare-selector map could
    // not see it — 299 such rules over ~775 text-carrying elements, plus 391
    // MUTED violations on the arm that is actually enforced.
    expect(
      counted(
        scan(
          `<div class="zoomctl"><span class="pct">80%</span></div>`,
          `.zoomctl .pct { color: var(--el-text-faint); }`,
        ),
      ).map((f) => f.via),
      'descendant',
    ).toEqual(['stylesheet']);
    expect(
      counted(
        scan(
          `<div class="panel"><p class="cap">x</p></div>`,
          `.panel > .cap { color: var(--el-text-faint); }`,
        ),
      ).map((f) => f.via),
      'child combinator',
    ).toEqual(['stylesheet']);
    expect(
      counted(scan(`<p class="seam sm">x</p>`, `.seam.sm { color: var(--el-text-faint); }`)).map(
        (f) => f.via,
      ),
      'compound',
    ).toEqual(['stylesheet']);
    // …and the muted arm sees the same shape, which is what took it 0 -> 391.
    expect(
      violations(
        scan(
          `<div class="bg-(--el-surface)"><p class="note">x</p></div>`,
          `.panel .note { color: var(--el-text-muted); }`,
        ),
      ),
      'an unmatched ancestor must NOT match',
    ).toEqual([]);
    expect(
      violations(
        scan(
          `<div class="panel bg-(--el-surface)"><p class="note">x</p></div>`,
          `.panel .note { color: var(--el-text-muted); }`,
        ),
      ).map((f) => f.surface),
    ).toEqual(['--el-surface']);
  });

  it('still ABSTAINS on a state, pseudo-element, attribute or tag rule', () => {
    // The original warrant, unchanged and still load-bearing: a state rule
    // paints in one render and not another, so reading one would be a false
    // positive nobody can act on. A widening that swallowed these would trade a
    // blind spot for a false-positive engine.
    const abstains = (style: string, label: string) =>
      expect(
        counted(scan(`<div class="zoomctl"><span class="pct">80%</span></div>`, style)),
        label,
      ).toEqual([]);
    abstains(`.zoomctl:hover .pct { color: var(--el-text-faint); }`, ':hover');
    abstains(`.zoomctl .pct:focus { color: var(--el-text-faint); }`, ':focus');
    abstains(`.zoomctl .pct::before { color: var(--el-text-faint); }`, '::before');
    abstains(`.zoomctl[data-open] .pct { color: var(--el-text-faint); }`, 'attribute');
    abstains(`div.zoomctl span { color: var(--el-text-faint); }`, 'tag');
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

describe('design ink-contrast — the FAINT arm is counted, and its subject still exists', () => {
  it('still finds faint ink the mocks carry', () => {
    // The scanner header's one remaining boundary, kept honest. That population
    // is 1745 findings across 101 files, dominated by the uppercase micro-label
    // idiom (`.panel-label` alone is 519), and it is declined for SIZE — not
    // because a design board's chrome is outside the product's contract, which
    // MOTIR-3054 settled the other way.
    //
    // The assertion is that the population EXISTS. If MOTIR-3068 empties it,
    // this fails — which is the intended outcome: the boundary should be
    // deleted on the day it stops having a subject, not silently kept.
    expect(
      counted(FINDINGS).length,
      'The faint population is empty. If a sweep cleared it, promote the faint arm into ' +
        '`violations()` and delete the remaining boundary from `inkContrastMockScan.ts` — ' +
        'the decline has outlived its subject (MOTIR-3068).',
    ).toBeGreaterThan(0);
  });

  it('counts faint ink from both layers, and takes the same two exemptions', () => {
    // The counted arm is a measurement somebody will act on, so its own
    // classification is exercised rather than assumed. No surface walk: faint
    // is 2.37–2.61:1 against every surface in the table, so nothing under it
    // changes the answer.
    const wrap = (body: string, style = '') =>
      `<!doctype html><html><head><style>${style}</style></head><body>${body}</body></html>`;
    const scan = (body: string, style = '') => scanMock('fixture.mock.html', wrap(body, style));

    expect(counted(scan(`<p class="${FAINT_CLASS}">x</p>`)).map((f) => f.via)).toEqual(['class']);
    expect(
      counted(scan(`<p class="cap">x</p>`, `.cap { color: var(--el-text-faint); }`)).map(
        (f) => f.via,
      ),
    ).toEqual(['stylesheet']);
    expect(
      counted(scan(`<div class="bg-(--el-card)"><p class="${FAINT_CLASS}">x</p></div>`)).map(
        (f) => f.surface,
      ),
      'no surface rescues faint, so none is resolved',
    ).toEqual([null]);
    expect(counted(scan(`<p class="${FAINT_CLASS}" aria-hidden="true">x</p>`))).toEqual([]);
    expect(counted(scan(`<p class="${FAINT_CLASS}" disabled>x</p>`))).toEqual([]);
    expect(
      counted(scan(`<span class="${FAINT_CLASS}"><svg aria-hidden="true"></svg></span>`)),
      'a container that paints no text of its own is not a text finding',
    ).toEqual([]);
  });
});
