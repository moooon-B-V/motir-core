// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanReviewRail } from '@/components/planning/PlanReviewRail';
import { DraftErrorNotice } from '@/components/issues/DraftWithAi';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import { contrast, flattenColorMix } from '../theme/colorMetrics';
import { loadTokenLayer, resolveToken } from '../theme/paletteCascade';

// MOTIR-3663 — the assertion that would have caught this bug, and the one
// MOTIR-1553 asked for and never got.
//
// ── WHY A PRESENCE ASSERTION IS NOT ENOUGH ──────────────────────────────────
// The repo has two component tests about this exact defect
// (`tests/components/filters-directory.test.tsx`,
// `tests/components/automation-settings.test.tsx`) and both are written as
// `expect(el.className).not.toContain('text-(--el-danger-text)')`. That is a
// check on the SPELLING of a class, and MOTIR-1553's own note records what it
// bought: a presence-only Vitest "found the item" for the entire time that item
// was invisible. A negative spelling check also cannot generalise — it forbids
// one token and says nothing about what replaced it, so it passes just as
// happily on a hue that fails AA as on one that clears it.
//
// So this file asserts the COLOUR, and it takes that colour out of the RENDERED
// DOM rather than from a fixture: whatever ink the component actually carries is
// resolved through the real `theme.css` chain and measured against the surface
// it actually sits on. Change the component to any other token and this test
// re-measures the new one — it never has to be edited to stay true, and it goes
// red the moment the pair stops clearing AA.
//
// ── WHY THE TOKEN LAYER AND NOT `getComputedStyle` ──────────────────────────
// happy-dom resolves neither a `var()` chain nor the `[data-palette]` /
// `[data-theme]` attribute cascade, so a `getComputedStyle` here would return
// the literal string `var(--el-danger-on-surface)` and an assertion on it would
// be a spelling check wearing a computed-style costume. `paletteCascade` is the
// repo's model of exactly the part of CSS the token layer uses, and it is what
// `brand-tile-contrast.test.ts` and the ink lint already measure with — so this
// test resolves the ink the same way the guard does, one layer further in.
//
// ── AND IT MEASURES ALL TWENTY, NOT THE DEFAULT ─────────────────────────────
// The defect survived fourteen months because the DEFAULT palette is one of the
// four where the old token rendered — near-white, wrong, but rendering. A
// spot-check of the palette in front of you is precisely what let that stand.

afterEach(cleanup);

const AA = 4.5;
const { rules, css } = loadTokenLayer();

/** Every palette in the token layer, plus the base, which ships no block. */
const PALETTES = [
  'motir',
  ...new Set([...css.matchAll(/\[data-palette=['"]([a-z0-9-]+)['"]\]/g)].map((m) => m[1]!)),
].filter((palette, index, all) => all.indexOf(palette) === index);

const PAIRS = PALETTES.flatMap((palette) =>
  (['light', 'dark'] as const).map((theme) => ({ palette, theme })),
);

const resolve = (palette: string, theme: 'light' | 'dark', token: string) =>
  flattenColorMix(resolveToken(rules, { palette, theme }, token).value);

/**
 * The `--el-*` ink an element carries, read off the rendered node. Returns null
 * when it paints no ink of its own — which the callers assert against, because
 * "the element stopped carrying an ink" is the way this test would silently
 * stop measuring anything.
 */
function inkOf(element: Element): string | null {
  const match = /text-\((--el-[a-z0-9-]+)\)/.exec(element.getAttribute('class') ?? '');
  return match ? match[1]! : null;
}

/** Assert one rendered ink clears AA on one surface, in all 20 combinations. */
function expectReadable(ink: string, surface: string, what: string) {
  const failures = PAIRS.flatMap(({ palette, theme }) => {
    const ratio = contrast(resolve(palette, theme, ink), resolve(palette, theme, surface));
    return ratio < AA ? [`${palette}/${theme}: ${ratio.toFixed(2)}:1`] : [];
  });
  expect(
    failures.join('\n'),
    `${what} paints \`${ink}\` on \`${surface}\`, which is unreadable in these palette × theme ` +
      `combinations. This is the MOTIR-3663 / MOTIR-1553 defect: \`--el-danger-text\` is the ink ` +
      `FOR a danger fill and measures 1.00:1 on a page in every palette's light theme. Danger ` +
      `text on a surface takes \`--el-danger-on-surface\`.`,
  ).toBe('');
}

function review(over: Partial<PlanReviewDto> = {}): PlanReviewDto {
  return {
    id: 'plan_1',
    projectId: 'proj_1',
    status: 'planned',
    title: 'Stripe Connect payouts',
    summary: null,
    itemCount: 3,
    createdAt: '2026-08-19T00:00:00.000Z',
    plannedAt: '2026-08-19T00:00:00.000Z',
    decidedAt: null,
    decidedByName: null,
    decisionReason: null,
    origin: 'user',
    createdByName: null,
    authorSource: null,
    authorHarness: null,
    authorModel: null,
    history: [],
    items: [],
    stale: false,
    staleCount: 0,
    revision: null,
    ...over,
  };
}

describe('the measurement itself is real — it would fail if it measured nothing', () => {
  it('resolves every palette in the token layer, both themes', () => {
    // notes.html #195, one layer down: a regex that matched nothing, or a token
    // layer that failed to load, would make every assertion below vacuously
    // true — the exact failure mode this whole file exists to remove.
    expect(PAIRS).toHaveLength(PALETTES.length * 2);
    expect(PALETTES.length).toBeGreaterThanOrEqual(10);
    expect(PALETTES).toContain('spectrum'); // the palette the bug was reported on
  });

  it('still fails the ink it was written about — `--el-danger-text` on the page', () => {
    // The control. Without this, a bug in `resolve` that returned the same
    // colour for both arguments would make every assertion above pass while
    // measuring nothing, and the file would read as coverage. This is the
    // measured 1.00:1 from the card, asserted rather than quoted.
    const invisible = PAIRS.filter(
      ({ palette, theme }) =>
        contrast(
          resolve(palette, theme, '--el-danger-text'),
          resolve(palette, theme, '--el-page-bg'),
        ) < AA,
    );
    // Sixteen of the twenty are below AA; the other four render near-white,
    // which is the same defect wearing its other face.
    expect(invisible.length).toBeGreaterThanOrEqual(16);
  });
});

describe('PlanReviewRail — the `role="alert"` the bug was reported on', () => {
  // `components/planning/PlanReviewRail.tsx:254`, the approve-failure refusal.
  // This is the surface the dogfooding report ("the error text is white with
  // theme Spectrum") was describing.
  function renderRail(errorCode: string | null) {
    return renderWithIntl(
      <PlanReviewRail
        review={review()}
        onApprove={() => {}}
        onDecline={() => {}}
        busy={false}
        errorCode={errorCode}
      />,
    );
  }

  it('renders the refusal as an alert at all', () => {
    renderRail('SOMETHING_FAILED');
    expect(screen.getByRole('alert').textContent).toBeTruthy();
  });

  it('paints that alert in an ink readable on the page, in all 20 combinations', () => {
    renderRail('SOMETHING_FAILED');
    const alert = screen.getByRole('alert');

    const ink = inkOf(alert);
    // Asserted before it is used: an alert that stopped carrying an ink of its
    // own would otherwise make the measurement below silently vacuous.
    expect(ink, 'the alert carries no --el-* ink — nothing left to measure').not.toBeNull();

    // The rail sits on the page, so the page white/black is the background.
    expectReadable(ink!, '--el-page-bg', "The plan review rail's approve-failure alert");
  });
});

describe('DraftErrorNotice — a danger glyph on the rose tint', () => {
  // `components/issues/DraftWithAi.tsx:140`. The second shape the sweep had to
  // fix: not text on the page, but a glyph on a TINTED callout — where the old
  // token measured 1.14–1.29:1 and where `aria-hidden` (correctly present)
  // exempts it from 1.4.3 without making it any more visible. That is why the
  // danger arm grants no decorative exemption.
  it('paints the alert glyph readably on `--el-tint-rose`, in all 20 combinations', () => {
    renderWithIntl(<DraftErrorNotice onRetry={() => {}} onDismiss={() => {}} errorCode="boom" />);

    const alert = screen.getByRole('alert');
    const glyph = Array.from(alert.querySelectorAll('*')).find((node) =>
      inkOf(node)?.includes('danger'),
    );
    expect(glyph, 'the error notice paints no danger ink — nothing left to measure').toBeTruthy();

    expectReadable(inkOf(glyph!)!, '--el-tint-rose', "The AI-draft failure notice's alert glyph");
  });
});
