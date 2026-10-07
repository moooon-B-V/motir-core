// E2E: Hand-Drawn / Indie's rough frame adds NO scrollable overflow to a framed
// scroll container (MOTIR-7693).
//
// ── The defect ──────────────────────────────────────────────────────────────
// The style draws its wavy ink on a `::after` overlay. That overlay used to sit
// at `inset: -1px` with a 2px border, so its BOX was one pixel larger than its
// host on every side. When the host is also a scroll container — `.border` +
// `overflow-*-auto`, the shape of every framed table, picker and code block —
// its own pseudo-element is part of its scrollable overflow: `scrollWidth` and
// `scrollHeight` came back one past `clientWidth` / `clientHeight`, and the
// browser drew a vertical AND a horizontal scroll bar on content that fits.
// The single-side dividers (`[data-surface] .border-b::after`, `bottom: -1px`)
// did the same to a scroller whose last row drops its real border.
//
// ── Why this spec has to RENDER ─────────────────────────────────────────────
// Scroll geometry is layout, and happy-dom does no layout — `scrollWidth` reads
// 0 there whatever the stylesheet says. `@scope` is not implemented there
// either. So the only check that can see this defect is one a real browser
// lays out, against the real compiled stylesheet — which `/tokens` serves (it is
// public, and it carries the Style control every style spec drives).
//
// ── THE ORACLE IS THE CLIENT BOX, plus the base style as a control ──────────
// A box whose content fits must report `scrollWidth === clientWidth` and
// `scrollHeight === clientHeight`. That holds under `warm-editorial` (no
// overlay) by construction, so the spec measures that style too: if the
// fixtures themselves overflowed, the control would fail first and say so.
// And it asserts the overlay is actually PAINTED under hand-drawn-indie, so a
// fix that "passes" by deleting the rough frame is a failure, not a green.

import { expect, test, type Page } from '@playwright/test';

const STYLES = [
  ['warm-editorial', 'Warm Editorial'],
  ['hand-drawn-indie', 'Hand-Drawn / Indie'],
] as const;

/** Drive `<html data-style>` through the page's own Style control. */
async function setStyle(page: Page, id: string, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-style', id);
}

/**
 * Framed scroll containers whose content EXACTLY fits, in the class shapes the
 * app ships (`rg 'overflow(-[xy])?-auto[^"]*\bborder\b'` lists them). Sizes are
 * inline so the fixtures do not depend on which sizing utilities the build kept;
 * the classes under test are the real ones.
 */
const FIXTURES = `
  <div data-fixture="border overflow-auto" class="border overflow-auto rounded-(--radius-card) border-(--el-border)" style="width:16rem;height:8rem"><div style="height:100%"></div></div>
  <div data-fixture="border overflow-x-auto" class="overflow-x-auto rounded-(--radius-card) border border-(--el-border)" style="width:16rem"><div style="height:3rem"></div></div>
  <div data-fixture="border overflow-y-auto" class="border overflow-y-auto rounded-(--radius-card) border-(--el-border)" style="width:16rem;height:8rem"><div style="height:100%"></div></div>
  <div data-fixture="border overflow-auto, rtl" dir="rtl" class="border overflow-auto rounded-(--radius-card) border-(--el-border)" style="width:16rem;height:8rem"><div style="height:100%"></div></div>
  <div data-fixture="table, last row border-b" data-surface="card" class="overflow-y-auto" style="width:16rem;height:6rem"><div class="border-b border-(--el-border)" style="height:2rem"></div><div class="border-b border-(--el-border)" style="height:2rem"></div><div class="border-b border-(--el-border)" style="height:2rem"></div></div>
  <div data-fixture="table, last row border-b-0" data-surface="card" class="overflow-y-auto" style="width:16rem;height:6rem"><div class="border-b border-(--el-border)" style="height:2rem"></div><div class="border-b border-(--el-border)" style="height:2rem"></div><div class="border-b border-b-0 border-(--el-border)" style="height:2rem"></div></div>
  <div data-fixture="table, border-t rows" data-surface="card" class="overflow-y-auto" style="width:16rem;height:6rem"><div class="border-t border-(--el-border)" style="height:2rem"></div><div class="border-t border-(--el-border)" style="height:2rem"></div><div class="border-t border-(--el-border)" style="height:2rem"></div></div>
`;

test.describe('hand-drawn-indie: the rough frame adds no scrollable overflow', () => {
  test('a framed scroll container whose content fits draws no scroll bars', async ({ page }) => {
    await page.goto('/tokens');

    // Mounted under <body>, so the only `data-style` ancestor is <html> — the
    // one the Style control drives.
    await page.evaluate((html) => {
      const host = document.createElement('div');
      host.id = 'motir-7693-fixtures';
      host.style.cssText =
        'position:fixed;top:0;left:0;display:grid;gap:8px;z-index:9999;pointer-events:none';
      host.innerHTML = html;
      document.body.append(host);
    }, FIXTURES);

    const overflowing: string[] = [];
    for (const [id, name] of STYLES) {
      await setStyle(page, id, name);
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('#motir-7693-fixtures > [data-fixture]')].map(
          (el) => ({
            fixture: el.dataset['fixture'] ?? '',
            scroll: `${el.scrollWidth}x${el.scrollHeight}`,
            client: `${el.clientWidth}x${el.clientHeight}`,
          }),
        ),
      );
      expect(rows).toHaveLength(7);
      for (const row of rows) {
        if (row.scroll !== row.client) {
          overflowing.push(`${id} · ${row.fixture}: scroll ${row.scroll} vs client ${row.client}`);
        }
      }
    }

    expect(
      overflowing,
      `a framed scroll container reported scrollable overflow its content does not have:\n${overflowing.join('\n')}\n`,
    ).toEqual([]);

    // Not vacuous: under hand-drawn-indie the frame and the divider overlays are
    // really painted (a fix that removed them would pass the geometry above).
    const painted = await page.evaluate(() => {
      const frame = document.querySelector('[data-fixture="border overflow-auto"]');
      const row = document.querySelector('[data-fixture="table, last row border-b"] > .border-b');
      if (!frame || !row) throw new Error('fixtures missing');
      const f = getComputedStyle(frame, '::after');
      const r = getComputedStyle(row, '::after');
      return {
        frame: `${f.content} ${f.outlineStyle} ${f.filter}`,
        row: `${r.content} ${r.outlineStyle} ${r.filter}`,
      };
    });
    expect(painted.frame).toMatch(/^"" solid url\(.*#hd-rough.*\)$/);
    expect(painted.row).toMatch(/^"" solid url\(.*#hd-rough.*\)$/);
  });
});
