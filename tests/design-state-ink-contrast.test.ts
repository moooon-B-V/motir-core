import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MUTED_TOKEN } from './theme/inkContrastMockScan';
import { contrast } from './theme/colorMetrics';
import {
  AA_SMALL_TEXT,
  STATE_PSEUDO_CLASSES,
  formatStateInkFinding,
  scanMockStateInk,
  stampSourceLines,
} from './theme/mockStateInkScan';

// MOTIR-4255 — the STATE arm of the design-asset ink guard.
//
// ── The hole ────────────────────────────────────────────────────────────────
// `design-ink-contrast.test.ts` enforces the MUTED arm at ZERO across the whole
// tree and is green. That reads as *the assets are clean*. It means *the assets
// are clean in their RESTING state*: `inkContrastMockScan`'s `stylePaint`
// abstains on every selector carrying a pseudo-class, so a `:hover` tint is
// unmeasured by construction — and hovering the row you are reading is not an
// edge case, it is what reading a row IS.
//
// The abstention is correct and stays. A static walk cannot know whether a
// state obtains, so it may not clear an ink on one (a false negative) or claim
// a tint from one (a false positive nobody can act on). What it can never be is
// COVERAGE, and at zero it looked like coverage twice over. The remedy is the
// instrument that has the answer: a real DOM, a real cascade, and the
// containment question asked of the tree. `mockStateInkScan`'s header carries
// the mechanics, the two engine behaviours it is written around, and the
// boundary it declares.
//
// ── The measurement this shipped with ───────────────────────────────────────
// Taken on `origin/main` @ 802f1edfc, over all 165 mocks in the tree:
//   • 279 state rules declare a background, across 81 assets;
//   • 216 elements paint `--el-text-muted` under one of those surfaces at under
//     4.5:1, across 22 assets — every one of them invisible to the resting arm,
//     and collapsing to 28 ink DECLARATIONS, which is what the sweep edited.
// The sweep in this pull request took that to zero, so it is 28 rules rather
// than MOTIR-3122's 391 sites and needs no per-area children. The command is the
// spec you are reading: `pnpm vitest run --config vitest.design.config.ts
// tests/design-state-ink-contrast.test.ts`.
//
// The DECLINED population, measured the same way and asserted non-empty below so
// the boundary cannot outlive its subject: 75 attribute-selector background rules
// across 48 assets.
//
// ⚠️ There was a SECOND declined population, and MOTIR-4277 emptied it. This spec
// shipped asserting `unTokenisedInkCount` non-zero — 18 elements across 2 assets
// whose failing ink named no `--el-*` token at all, so the remedy this arm
// applies (a token SWAP) had no token to swap. Both assets now consume the token
// layer and the count is 0 across all 167 mocks, so the assertion and the counter
// behind it are DELETED with their subject rather than reworded (the precedent is
// MOTIR-3068). The scanner still rules only on `--el-text-muted`; ink outside the
// token layer is the never-invent-a-colour rule's subject and is enforced there.
//
// ⚠️ MOTIR-4342 widened the COLOUR PARSER under all of this, and the tree-wide
// numbers did not move: 279 state background rules, 0 findings, 0 abstentions,
// before and after, over all 167 mocks (`npx tsx` over `scanMockStateInk`, the
// same walk this spec runs). That is the point rather than an anticlimax — 47
// elements paint a background the scanner could not read (20 an 8-digit
// `#rrggbbaa` across 6 assets, 27 a `currentcolor`), and every one of them
// happens to sit off the chains the state arm walks. It is a coincidence of
// which assets carry `:hover` tints this week, not a boundary anybody drew, so
// the counterfactual lives in the FIXTURES below: each of the four new grounding
// cases ABSTAINED on `origin/main` @ 37b791035, every one of them saying
// "translucent over no opaque ground" — including the one whose ground was an
// opaque `#223344ff`.
//
// ── This spec belongs to the `design/*` lane ────────────────────────────────
// It reads `design/**` and nothing else, so a `design/*` branch — where the
// root Vitest job is deliberately skipped — is exactly the branch that must run
// it (MOTIR-2442). `vitest.design.config.ts` lists it, and
// `tests/ci-design-guards-lane.test.ts` re-derives that list from the tree.

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
const SCANS = MOCKS.map((file) => scanMockStateInk(file, readFileSync(join(ROOT, file), 'utf8')));
const FINDINGS = SCANS.flatMap((scan) => scan.findings);
const ABSTENTIONS = SCANS.flatMap((scan) => scan.abstentions);
const sum = (pick: (scan: (typeof SCANS)[number]) => number) =>
  SCANS.reduce((total, scan) => total + pick(scan), 0);

describe('design state-ink — the scanned set is the set that was searched', () => {
  // The check every guard in this family opens with: a walk that silently found
  // nothing reports a clean tree, and this guard exists precisely because a
  // clean signal was wrong once.
  it('scans a real, non-empty set of design mocks', () => {
    expect(MOCKS.length).toBeGreaterThan(100);
  });

  it('finds state rules that actually paint a background', () => {
    // The vacuity guard that matters here, and it is not the one above. The
    // file set can be real and the arm still rule on nothing at all — if the
    // CSSOM walk broke, if the engine stopped parsing `<style>`, if the
    // selector list changed shape. Then every assertion below passes over an
    // empty population.
    expect(sum((scan) => scan.stateBackgroundRules)).toBeGreaterThan(100);
  });

  it('reaches the asset the defect was found on', () => {
    // MOTIR-4246 measured `.lt-row:hover { background: var(--el-surface) }` with
    // `.cell-title .lr-id { color: var(--el-text-muted) }` inside it, by hand.
    // If this arm cannot see that asset's state rules it is measuring something
    // else.
    const list = SCANS.find((scan) => scan.file === 'design/work-items/list.mock.html');
    expect(list, 'design/work-items/list.mock.html is in the tree').toBeDefined();
    expect(list!.stateBackgroundRules).toBeGreaterThan(0);
  });
});

describe('design state-ink — the scanner, on fixtures it must and must not report', () => {
  // A guard whose negative case is never exercised is a guard nobody knows is
  // running (`inkContrastScan`'s own words, MOTIR-2459). Every fixture below is
  // the shape it is named for, taken from the real tree.
  const TOKENS = `:root {
    --el-text-muted: #787671;
    --el-text-secondary: #5d5b54;
    --el-surface: #f6f5f4;
    --el-card: #ffffff;
    --el-page-bg: #ffffff;
  }
  body { background: var(--el-page-bg); color: #1a1a1a; }`;

  const scan = (body: string, style = '') =>
    scanMockStateInk(
      'fixture.mock.html',
      `<!doctype html><html><head><style>${TOKENS}${style}</style></head><body>${body}</body></html>`,
    );

  it('reports the muted ink under a :hover tint — the defect this card was filed for', () => {
    const found = scan(
      `<div class="row"><span class="id">PROD-12</span></div>`,
      `.row:hover { background: var(--el-surface); } .id { color: var(--el-text-muted); }`,
    ).findings;
    expect(found.map((f) => [f.state, f.surface, f.ratio])).toEqual([['hover', '#f6f5f4', 4.17]]);
    // The CONTROL the resting arm cannot supply: the same ink clears AA on the
    // page white, which is why nothing was ever red about it.
    expect(found[0]!.restingRatio).toBe(4.54);
  });

  it.each(STATE_PSEUDO_CLASSES.map((state) => [state]))('resolves :%s', (state) => {
    const found = scan(
      `<div class="row"><span class="id">PROD-12</span></div>`,
      `.row:${state} { background: var(--el-surface); } .id { color: var(--el-text-muted); }`,
    ).findings;
    expect(found.map((f) => f.state)).toEqual([state]);
  });

  it('clears the same ink under a state surface that IS the white page/card', () => {
    expect(
      scan(
        `<div class="row"><span class="id">PROD-12</span></div>`,
        `.row:hover { background: var(--el-card); } .id { color: var(--el-text-muted); }`,
      ).findings,
    ).toEqual([]);
  });

  it('stops at an opaque surface between the ink and the state tint', () => {
    // The containment question in its sharpest form, and the one no string
    // matcher can answer: the ink IS inside the hovered row, and the row's tint
    // does not reach it, because a white card is painted in between.
    expect(
      scan(
        `<div class="row"><div class="card"><span class="id">PROD-12</span></div></div>`,
        `.row:hover { background: var(--el-surface); } .card { background: var(--el-card); } ` +
          `.id { color: var(--el-text-muted); }`,
      ).findings,
    ).toEqual([]);
  });

  it('reports only ink INSIDE the hovered element, not a sibling', () => {
    expect(
      scan(
        `<div class="row"></div><span class="id">PROD-12</span>`,
        `.row:hover { background: var(--el-surface); } .id { color: var(--el-text-muted); }`,
      ).findings,
    ).toEqual([]);
  });

  it('takes the same two 1.4.3 grants as the resting arm', () => {
    const style = `.row:hover { background: var(--el-surface); } .id { color: var(--el-text-muted); }`;
    expect(
      scan(`<div class="row"><span class="id" aria-hidden="true">x</span></div>`, style).findings,
    ).toEqual([]);
    expect(
      scan(`<div class="row"><span class="id" aria-disabled="true">x</span></div>`, style).findings,
    ).toEqual([]);
    expect(
      scan(`<div class="row"><span class="id" disabled>x</span></div>`, style).findings,
    ).toEqual([]);
  });

  it('rules on the element that PAINTS the text, not the container above it', () => {
    const found = scan(
      `<div class="row"><span class="id"><b>PROD-12</b></span></div>`,
      `.row:hover { background: var(--el-surface); } .id { color: var(--el-text-muted); }`,
    ).findings;
    expect(found.map((f) => f.element)).toEqual(['b']);
  });

  it('composites a translucent state tint rather than abstaining on it', () => {
    // `rgba(0, 0, 0, 0.08)` paints real pixels over a known ground. Declining to
    // measure it because it carries an alpha would be an abstention with no
    // warrant.
    const found = scan(
      `<div class="row"><span class="id">PROD-12</span></div>`,
      `.row:hover { background: rgba(0, 0, 0, 0.08); } .id { color: var(--el-text-muted); }`,
    ).findings;
    expect(found).toHaveLength(1);
    expect(found[0]!.surface).toBe('#ebebeb');
  });

  it('composites a TRANSLUCENT ANCESTOR into the ground, rather than walking past it', () => {
    // MOTIR-4317, the shape verbatim: white chrome inside a lightbox whose
    // 80%-black scrim sits on the board's own light page. `restingBackground`
    // walked THROUGH the scrim — `toHex` returns null for any alpha under 1,
    // and the walk read that as *this element paints nothing* — so the ground
    // was the page the scrim hides, and the hover tint composited over THAT.
    //
    // ⚠️ The white ink is the element the defect was measured on and it is not
    // the one that can READ the surface: correctly grounded it clears AA, and a
    // passing pair produces no finding to assert against. So the button carries
    // a muted-token label as well — the same pixels, the same host, and the arm
    // rules on it — and the white ink is then checked against the surface the
    // scanner itself resolved.
    const found = scanMockStateInk(
      'fixture.mock.html',
      `<!doctype html><html><head><style>` +
        `:root { --el-text-muted: #787671; }` +
        `body { background: #f6f5f4; }` +
        `.lightbox { background: rgba(0, 0, 0, 0.8); }` +
        `.lb-btn { color: #ffffff; }` +
        `.lb-btn:hover { background: rgba(255, 255, 255, 0.2); }` +
        `.lb-name { color: var(--el-text-muted); }` +
        `</style></head><body><div class="lightbox">` +
        `<button class="lb-btn">Download<span class="lb-name">report-v2.pdf</span></button>` +
        `</div></body></html>`,
    ).findings;

    expect(found).toHaveLength(1);
    // 0.8 x #000 over #f6f5f4 = #313131 — the scrim's real pixels. Pre-fix this
    // read #f6f5f4, the page the scrim covers.
    expect(found[0]!.restingSurface).toBe('#313131');
    // and the hover tint over THAT ground, not over the page: pre-fix #f8f7f6.
    expect(found[0]!.surface).toBe('#5a5a5a');
    // The number the card was filed on. Against the pre-fix #f8f7f6 the same
    // white measured 1.07:1 — 6.4x wrong, in the direction that manufactures a
    // finding.
    expect(Number(contrast('#ffffff', found[0]!.surface).toFixed(2))).toBe(6.9);
    expect(contrast('#ffffff', found[0]!.surface)).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
  });

  it('folds a STACK of translucent ancestors, in paint order', () => {
    // Two scrims over one page. The fold has to run bottom-up — the layer
    // nearest the ground is painted first — and a walk that stops at the first
    // translucent layer, or folds them the other way round, gets a different
    // colour rather than an error.
    const found = scanMockStateInk(
      'fixture.mock.html',
      `<!doctype html><html><head><style>` +
        `:root { --el-text-muted: #787671; }` +
        `body { background: #ffffff; }` +
        `.outer { background: rgba(0, 0, 0, 0.5); }` +
        `.inner { background: rgba(0, 0, 0, 0.5); }` +
        `.row:hover { background: rgba(255, 255, 255, 0.2); }` +
        `.id { color: var(--el-text-muted); }` +
        `</style></head><body><div class="outer"><div class="inner">` +
        `<div class="row"><span class="id">PROD-12</span></div>` +
        `</div></div></body></html>`,
    ).findings;

    // #ffffff -> 0.5 black -> #808080 -> 0.5 black -> #404040.
    expect(found.map((f) => f.restingSurface)).toEqual(['#404040']);
  });

  it('still ABSTAINS where the chain is translucent all the way to the document', () => {
    // AC 3, and the half the fix must NOT change: with no opaque ground
    // anywhere above the element there is nothing to composite over, and the
    // honest answer is still nothing. A fabricated ground here would be the
    // same defect wearing the fix.
    const scanned = scanMockStateInk(
      'fixture.mock.html',
      `<!doctype html><html><head><style>` +
        `:root { --el-text-muted: #787671; }` +
        `.scrim { background: rgba(0, 0, 0, 0.8); }` +
        `.row:hover { background: rgba(255, 255, 255, 0.2); }` +
        `.id { color: var(--el-text-muted); }` +
        `</style></head><body><div class="scrim">` +
        `<div class="row"><span class="id">PROD-12</span></div>` +
        `</div></body></html>`,
    );
    expect(scanned.findings).toEqual([]);
    expect(scanned.abstentions.map((a) => a.reason)).toEqual([
      'the state background "rgba(255, 255, 255, 0.2)" resolved to "rgba(255, 255, 255, 0.2)", ' +
        'which is translucent over no opaque ground',
    ]);
  });

  // ── MOTIR-4342 — the PARSER under the grounding walk ──────────────────────
  // `toHex` read a 3- or 6-digit hex and an `rgb()` / `rgba()`, and nothing
  // else. So an 8-digit `#rrggbbaa` — the SAME colour the block above already
  // composites, spelled the other way — and a `currentcolor` background both
  // came back as *not a colour I can read*, which the grounding walk read as
  // *translucent* and then failed to fold. 47 elements paint one of the two on
  // `origin/main` @ `e6d85218d`.
  //
  // ⚠️ Every fixture below asserts a FIXED VALUE, never a ratio, and every one
  // of them ABSTAINED before this card: the counterfactual is a named colour,
  // not a smaller number. Fixture one is MOTIR-4317's lightbox with both alphas
  // respelled as hex, and it lands on the same two hexes byte for byte — which
  // is the whole point of the defect.

  it('folds an 8-digit-hex TRANSLUCENT ancestor into the ground', () => {
    const found = scanMockStateInk(
      'fixture.mock.html',
      `<!doctype html><html><head><style>` +
        `:root { --el-text-muted: #787671; }` +
        `body { background: #f6f5f4; }` +
        `.scrim { background: #000000cc; }` +
        `.row:hover { background: #ffffff33; }` +
        `.id { color: var(--el-text-muted); }` +
        `</style></head><body><div class="scrim">` +
        `<div class="row"><span class="id">PROD-12</span></div>` +
        `</div></body></html>`,
    ).findings;

    expect(found).toHaveLength(1);
    // `#000000cc` IS `rgba(0, 0, 0, 0.8)` — 0xcc/255 — so the two spellings owe
    // the same two hexes as the MOTIR-4317 fixture above, and get them.
    expect(found[0]!.restingSurface).toBe('#313131');
    expect(found[0]!.surface).toBe('#5a5a5a');
  });

  it('takes an 8-digit-hex OPAQUE (`…ff`) ancestor as the ground', () => {
    // The other half of the widening, and the one a ratio cannot show: an
    // `…ff` hex is not translucent at all, so it must STOP the walk rather than
    // join the fold. Pre-fix it did neither — `toHex` refused it, the walk
    // pushed it onto the composite stack, and the site abstained.
    const found = scanMockStateInk(
      'fixture.mock.html',
      `<!doctype html><html><head><style>` +
        `:root { --el-text-muted: #787671; }` +
        `body { background: #f6f5f4; }` +
        `.panel { background: #223344ff; }` +
        `.row:hover { background: #ffffff33; }` +
        `.id { color: var(--el-text-muted); }` +
        `</style></head><body><div class="panel">` +
        `<div class="row"><span class="id">PROD-12</span></div>` +
        `</div></body></html>`,
    ).findings;

    expect(found).toHaveLength(1);
    // The panel itself, NOT the page behind it and NOT a composite of the two.
    expect(found[0]!.restingSurface).toBe('#223344');
    expect(found[0]!.surface).toBe('#4e5c69');
  });

  it('treats a `#rrggbb00` ancestor as painting nothing', () => {
    // Zero alpha is *paints no colour*, which `PAINTS_NO_COLOUR` already says
    // for the keyword spellings and `alphaIn` says for `rgba(…, 0)`. The hex
    // form has to arrive at the same answer, or the ground becomes a colour
    // nobody can see — here, a navy that paints not one pixel.
    const found = scanMockStateInk(
      'fixture.mock.html',
      `<!doctype html><html><head><style>` +
        `:root { --el-text-muted: #787671; }` +
        `body { background: #f6f5f4; }` +
        `.ghost { background: #12345600; }` +
        `.row:hover { background: #ffffff33; }` +
        `.id { color: var(--el-text-muted); }` +
        `</style></head><body><div class="ghost">` +
        `<div class="row"><span class="id">PROD-12</span></div>` +
        `</div></body></html>`,
    ).findings;

    expect(found).toHaveLength(1);
    // The page, not `#123456` and not a composite over it.
    expect(found[0]!.restingSurface).toBe('#f6f5f4');
    expect(found[0]!.surface).toBe('#f8f7f6');
  });

  it("grounds a `currentcolor` background on the element's OWN ink", () => {
    // `currentcolor` means *whatever this element's ink is* — a value AT a
    // site, which is the class of question this file renders to answer. The
    // body's ink is deliberately different from the panel's, so an answer taken
    // from the wrong element would show as `#1a1a1a` rather than as a number
    // that merely happens to be right.
    const found = scanMockStateInk(
      'fixture.mock.html',
      `<!doctype html><html><head><style>` +
        `:root { --el-text-muted: #787671; }` +
        `body { background: #f6f5f4; color: #1a1a1a; }` +
        `.panel { color: #3a2f6d; background: currentcolor; }` +
        `.row:hover { background: #ffffff33; }` +
        `.id { color: var(--el-text-muted); }` +
        `</style></head><body><div class="panel">` +
        `<div class="row"><span class="id">PROD-12</span></div>` +
        `</div></body></html>`,
    ).findings;

    expect(found).toHaveLength(1);
    expect(found[0]!.restingSurface).toBe('#3a2f6d');
    expect(found[0]!.surface).toBe('#61598a');
  });

  it('names an UNREADABLE ancestor as the reason, not the missing ground', () => {
    // AC 4. MOTIR-4317 left `restingBackground` with two nulls sharing one
    // return value and one sentence — *translucent over no opaque ground* — for
    // both. The widening above shrinks the unreadable set; it does not empty
    // it, and a guard that fails for the wrong reason sends the first reader to
    // the asset's stacking when the answer is in the parser.
    const scanned = scanMockStateInk(
      'fixture.mock.html',
      `<!doctype html><html><head><style>` +
        `:root { --el-text-muted: #787671; }` +
        `body { background: #f6f5f4; }` +
        `.mystery { background: rebeccapurple; }` +
        `.row:hover { background: #ffffff33; }` +
        `.id { color: var(--el-text-muted); }` +
        `</style></head><body><div class="mystery">` +
        `<div class="row"><span class="id">PROD-12</span></div>` +
        `</div></body></html>`,
    );
    expect(scanned.findings).toEqual([]);
    expect(scanned.abstentions.map((a) => a.reason)).toEqual([
      'the state background "#ffffff33" resolved to "#ffffff33", which is translucent over an ' +
        'ancestor painting "rebeccapurple", which this scanner cannot read as a colour',
    ]);
  });

  it('names an UNREADABLE state background as the reason, not a missing ground', () => {
    // The third of the three answers the one sentence used to cover: here it is
    // the TINT itself the file cannot read, and there is a perfectly good
    // opaque ground under it.
    const scanned = scanMockStateInk(
      'fixture.mock.html',
      `<!doctype html><html><head><style>` +
        `:root { --el-text-muted: #787671; }` +
        `body { background: #f6f5f4; }` +
        `.row:hover { background: rebeccapurple; }` +
        `.id { color: var(--el-text-muted); }` +
        `</style></head><body>` +
        `<div class="row"><span class="id">PROD-12</span></div>` +
        `</body></html>`,
    );
    expect(scanned.findings).toEqual([]);
    expect(scanned.abstentions.map((a) => a.reason)).toEqual([
      'the state background "rebeccapurple" resolved to "rebeccapurple", which this scanner ' +
        'cannot read as a colour',
    ]);
  });

  it('reports a NULL control where only the CONTROL is ungrounded', () => {
    // The same ungrounded chain under an OPAQUE state tint. The surface is
    // knowable, so the pair is ruled on — and `restingSurface` is null, which
    // is what `formatStateInkFinding` renders as *nothing opaque grounds it at
    // rest*. That sentence has to stay reachable: it is the one honest answer
    // when the ground is unknown, and it is the thing a fabricated ground would
    // replace.
    const found = scanMockStateInk(
      'fixture.mock.html',
      `<!doctype html><html><head><style>` +
        `:root { --el-text-muted: #787671; --el-surface: #f6f5f4; }` +
        `.scrim { background: rgba(0, 0, 0, 0.8); }` +
        `.row:hover { background: var(--el-surface); }` +
        `.id { color: var(--el-text-muted); }` +
        `</style></head><body><div class="scrim">` +
        `<div class="row"><span class="id">PROD-12</span></div>` +
        `</div></body></html>`,
    ).findings;
    expect(found.map((f) => [f.surface, f.restingSurface, f.restingRatio])).toEqual([
      ['#f6f5f4', null, null],
    ]);
  });

  it('treats `background: transparent` as a resolved answer, not an abstention', () => {
    const scanned = scan(
      `<div class="row"><span class="id">PROD-12</span></div>`,
      `.row:hover { background: transparent; } .id { color: var(--el-text-muted); }`,
    );
    expect(scanned.findings).toEqual([]);
    expect(scanned.abstentions).toEqual([]);
  });

  it('ABSTAINS on a state pseudo-class inside :not(), where dropping it inverts the rule', () => {
    // The one selector shape where rewriting the selector would change the
    // verdict rather than widen it. The tree contains none today; this is what
    // stops the check rotting if one is written.
    const scanned = scan(
      `<div class="row"><span class="id">PROD-12</span></div>`,
      `.row:not(:hover) { background: var(--el-surface); } .id { color: var(--el-text-muted); }`,
    );
    expect(scanned.findings).toEqual([]);
    expect(scanned.abstentions.map((a) => a.reason)).toEqual([
      'the state pseudo-class sits inside :not(), where removing it inverts the rule',
    ]);
  });

  it('does NOT claim an ink written as a raw colour', () => {
    // The arm rules on `--el-text-muted`, read off the DECLARATION — so an ink
    // aliased to a raw hex on a local `:root` is not its subject, however the
    // pixels measure. MOTIR-4277 emptied that population from the tree and
    // retired the counter that reported it; what stays is this negative case,
    // because a guard whose negative case is never exercised is a guard nobody
    // knows is running.
    const scanned = scanMockStateInk(
      'fixture.mock.html',
      `<!doctype html><html><head><style>` +
        `:root { --muted: #787671; --soft: #f6f5f4; }` +
        `.row:hover { background: var(--soft); } .id { color: var(--muted); }` +
        `</style></head><body><div class="row"><span class="id">PROD-12</span></div></body></html>`,
    );
    expect(scanned.findings).toEqual([]);
  });

  it('does NOT claim a DIFFERENT token that resolves to the same colour', () => {
    // The false positive that made the declaration the classifier rather than
    // the pixel: inside these assets' nested dark scopes `--el-text-secondary`
    // and `--el-text-muted` compute to the same value, and a hex comparison
    // reported thirteen secondary-inked rows in design/settings as violations.
    const scanned = scanMockStateInk(
      'fixture.mock.html',
      `<!doctype html><html><head><style>` +
        `:root { --el-text-muted: #787671; --el-text-secondary: #787671; --el-surface: #f6f5f4; }` +
        `.row:hover { background: var(--el-surface); } ` +
        `.id { color: var(--el-text-secondary); }` +
        `</style></head><body><div class="row"><span class="id">PROD-12</span></div></body></html>`,
    );
    expect(scanned.findings).toEqual([]);
  });

  it('addresses every finding by its own source line', () => {
    // A finding without a source position sends a reader to search a
    // two-thousand-line asset for a `<span>` that appears eighteen times.
    const html =
      `<!doctype html>\n<html>\n<head>\n<style>\n${TOKENS}\n` +
      `.row:hover { background: var(--el-surface); }\n.id { color: var(--el-text-muted); }\n` +
      `</style>\n</head>\n<body>\n<div class="row">\n<span class="id">PROD-12</span>\n</div>\n</body>\n</html>`;
    // Derived from the fixture rather than written down, so editing the token
    // block above cannot turn this into an assertion about the wrong line.
    const expected = html.split('\n').findIndex((l) => l.includes('class="id"')) + 1;
    const found = scanMockStateInk('fixture.mock.html', html).findings;
    expect(found.map((f) => f.line)).toEqual([expected]);
  });

  it('stamps a line onto every opening tag and nothing inside a <style> or a comment', () => {
    const stamped = stampSourceLines(
      `<!doctype html><html><head><style>.a { color: red }</style></head>` +
        `<body><!-- <p class="x">c</p> --><div>d</div></body></html>`,
    );
    expect(stamped).toContain('<div data-mock-source-line="1">');
    expect(stamped).toContain('<style data-mock-source-line="1">.a { color: red }</style>');
    expect(stamped).toContain('<!-- <p class="x">c</p> -->');
  });
});

describe('design state-ink — the declared boundary still has a subject', () => {
  // A decline that outlives its reason is how the next reader re-derives it.
  // This one is counted rather than ruled on, and asserted non-empty so the
  // boundary cannot go quiet while the population is still there.
  // `mockStateInkScan`'s header carries the reason.
  //
  // ⚠️ There were TWO. The other — ink naming no `--el-*` token at all — was
  // emptied tree-wide by MOTIR-4277, and its assertion and its counter were
  // deleted with it rather than reworded (MOTIR-3068's precedent). That is what
  // this describe is FOR: a decline is kept honest by an assertion that its
  // population is still real, and when the population goes, so does the decline.
  it('still declines a real population of ATTRIBUTE-painted surfaces', () => {
    expect(sum((scan) => scan.attributeBackgroundRules)).toBeGreaterThan(0);
  });
});

describe('design state-ink — every asset is ruled on or NAMED', () => {
  it('leaves no site the render could not resolve unreported', () => {
    // A coverage claim over a population owes its population. An asset the
    // engine could not rule on is not a clean asset — it is an unmeasured one,
    // and the difference is invisible from a green run. There are none today;
    // if one appears, this fails with the reason rather than passing quietly.
    expect(
      ABSTENTIONS.map((a) => `${a.file} — ${a.stateSelector}: ${a.reason}`),
      'the state-ink arm could not resolve these sites. Each is UNMEASURED, not clean — ' +
        'either make the site resolvable or record it here as a decision with its reason.',
    ).toEqual([]);
  });
});

describe('design state-ink — no design mock specifies muted ink on a state surface', () => {
  it('leaves no violation in any design mock', () => {
    // Derived over the scanned tree, never compared to a frozen count — the
    // sweep that made this pass measured 205 findings in 25 assets, and writing
    // 205 down here would turn every new asset into a reason to edit the
    // assertion.
    expect(
      FINDINGS.map(formatStateInkFinding).join('\n'),
      `${MUTED_TOKEN} is 4.12–4.34:1 on every tinted surface and clears AA only on the white ` +
        `page/card (CLAUDE.md's measured table), so an asset that paints it inside a row whose ` +
        `HOVER tint is that surface specifies a pair that fails AA for as long as the pointer is ` +
        `on the row. Give it --el-text-secondary (6.18–6.80:1 on all four surfaces in both ` +
        `themes), or --el-text-identifier where the element is a monospace item key — the token ` +
        `theme.css names for that job. If the element is really a glyph, say so with aria-hidden ` +
        `or a labelled role="img" and the guard will agree. Then re-export the .png. ` +
        `The RESTING arm (design-ink-contrast.test.ts) cannot see any of this: ` +
        `inkContrastMockScan's stylePaint abstains on every pseudo-class selector, deliberately ` +
        `and correctly — which is why this arm renders instead of parsing.`,
    ).toBe('');
  });

  it('measures against the same floor as both resting arms', () => {
    expect(AA_SMALL_TEXT).toBe(4.5);
  });
});
