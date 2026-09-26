// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { PALETTE_IDS } from '@/lib/theme/palettes';
import { ReadinessBadge } from '@/components/ui/ReadinessBadge';
import { loadTokenLayer, resolveToken } from '../theme/paletteCascade';
import { contrast, flattenColorMix } from '../theme/colorMetrics';

// MOTIR-6377 — the readiness banner's SOFT variant, built to the approved delta
// `design/work-items/relationships--soft-block.mock.html` (design card
// MOTIR-6371, design-notes § "Soft block (ancestor-only) banner"):
//
//  1 ready                           → mint, unchanged
//  2 HARD (own open blockers)        → peach · CircleAlert in --el-warning · "Blocked"
//  3 SOFT (no own, ancestor blocked) → --el-tint-yellow · CircleAlert in
//                                      --el-text-strong · "Parent blocked"
//  4 both                            → HARD wins, the ancestor is not mentioned
//  5 neither                         → bare HARD "Blocked", no detail line

afterEach(cleanup);

const ANCESTOR = { identifier: 'PROD-12', href: '/items/PROD-12', title: 'Accounts & sign-in' };
const OWN = { identifier: 'PROD-3', href: '/items/PROD-3' };

function shell(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement;
}
function glyph(container: HTMLElement): SVGElement {
  return shell(container).querySelector('svg') as SVGElement;
}

describe('ReadinessBadge — SOFT vs HARD (MOTIR-6377)', () => {
  it('state 3 · SOFT: yellow surface, text-strong glyph, "Parent blocked", the parent named', () => {
    const { container } = render(
      <ReadinessBadge ready={false} blockers={[]} blockedByAncestor={ANCESTOR} />,
    );
    const root = shell(container);
    expect(root.getAttribute('data-readiness')).toBe('soft');
    expect(root.className).toContain('bg-(--el-tint-yellow)');
    expect(root.className).not.toContain('--el-tint-peach');
    // Same shape as the HARD shell — only the surface changes.
    expect(root.className).toContain('rounded-(--radius-card) px-3.5 py-3');
    expect(glyph(container).getAttribute('class')).toContain('text-(--el-text-strong)');
    expect(glyph(container).getAttribute('class')).not.toContain('--el-warning');

    screen.getByText('Parent blocked');
    expect(screen.queryByText('Blocked')).toBeNull();
    screen.getByText(/Waiting on a parent item —/);
    const link = screen.getByRole('link', { name: 'PROD-12' });
    expect(link.getAttribute('href')).toBe('/items/PROD-12');
    expect(link.getAttribute('target')).not.toBe('_blank');
    screen.getByText(/· Accounts & sign-in/);
  });

  it('state 2 · HARD: one own blocker keeps the peach banner and the warning glyph', () => {
    const { container } = render(<ReadinessBadge ready={false} blockers={[OWN]} />);
    const root = shell(container);
    expect(root.getAttribute('data-readiness')).toBe('hard');
    expect(root.className).toContain('bg-(--el-tint-peach)');
    expect(root.className).not.toContain('--el-tint-yellow');
    expect(glyph(container).getAttribute('class')).toContain('text-(--el-warning)');
    screen.getByText('Blocked');
    expect(screen.queryByText('Parent blocked')).toBeNull();
    screen.getByText(/Waiting on 1 work item —/);
  });

  it('state 4 · both own blockers and a blocked ancestor: HARD wins, the ancestor is not named', () => {
    const { container } = render(
      <ReadinessBadge ready={false} blockers={[OWN]} blockedByAncestor={ANCESTOR} />,
    );
    expect(shell(container).className).toContain('bg-(--el-tint-peach)');
    expect(glyph(container).getAttribute('class')).toContain('text-(--el-warning)');
    screen.getByText('Blocked');
    expect(screen.queryByText('Parent blocked')).toBeNull();
    expect(screen.queryByText(/Waiting on a parent item/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'PROD-12' })).toBeNull();
  });

  it('state 5 · not ready with neither cause: the bare peach "Blocked", no detail line', () => {
    const { container } = render(<ReadinessBadge ready={false} />);
    expect(shell(container).className).toContain('bg-(--el-tint-peach)');
    screen.getByText('Blocked');
    expect(screen.queryByText('Parent blocked')).toBeNull();
    expect(screen.queryByText(/Waiting on/)).toBeNull();
  });

  it('state 1 · ready is unchanged, even with a stale ancestor passed in', () => {
    const { container } = render(<ReadinessBadge ready blockedByAncestor={ANCESTOR} />);
    expect(shell(container).className).toContain('bg-(--el-tint-mint)');
    screen.getByText('Ready to start');
    expect(screen.queryByText('Parent blocked')).toBeNull();
  });

  it('state 6 · the peek (new-tab links, mt-4) renders the same SOFT variant', () => {
    const { container } = render(
      <ReadinessBadge
        ready={false}
        blockers={[]}
        blockedByAncestor={ANCESTOR}
        blockerLinksNewTab
        className="mt-4"
      />,
    );
    expect(shell(container).className).toContain('bg-(--el-tint-yellow)');
    expect(shell(container).className).toContain('mt-4');
    const link = screen.getByRole('link', { name: 'PROD-12' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('panel C · zh: 上级受阻 for SOFT, 受阻 for HARD', () => {
    render(<ReadinessBadge ready={false} blockers={[]} blockedByAncestor={ANCESTOR} />, {
      locale: 'zh',
      messages: zhMessages,
    });
    screen.getByText('上级受阻');
    screen.getByText(/正在等待上级工作项 —/);
    cleanup();
    render(<ReadinessBadge ready={false} blockers={[OWN]} />, {
      locale: 'zh',
      messages: zhMessages,
    });
    screen.getByText('受阻');
    expect(screen.queryByText('上级受阻')).toBeNull();
  });
});

describe('ReadinessBadge — the SOFT pair clears AA in every palette and theme (MOTIR-6377)', () => {
  // The repo's ink guard measures the muted/faint inks, not --el-text-strong, so
  // the soft pair is measured here directly. Design notes: 11.38:1 light /
  // 9.89:1 dark on the base palette, lowest 9.89:1 across all palettes. Text
  // needs 4.5:1 (1.4.3); the glyph shares the ink, so it clears 3:1 (1.4.11).
  const { rules } = loadTokenLayer();
  const contexts = PALETTE_IDS.flatMap((palette) =>
    (['light', 'dark'] as const).map((theme) => ({ palette, theme })),
  );

  it.each(contexts)('$palette · $theme: --el-text-strong on --el-tint-yellow ≥ 4.5:1', (ctx) => {
    const surface = resolveToken(rules, ctx, '--el-tint-yellow');
    const ink = resolveToken(rules, ctx, '--el-text-strong');
    expect(surface.unresolved).toEqual([]);
    expect(ink.unresolved).toEqual([]);
    const ratio = contrast(flattenColorMix(ink.value), flattenColorMix(surface.value));
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});
