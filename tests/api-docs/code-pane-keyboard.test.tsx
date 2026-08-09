// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// MOTIR-2494 — the code panes on the public API reference are scroll containers
// a keyboard could not reach.
//
// The defect had no rendered symptom: nothing looked broken, a mouse user
// dragged the pane, and the only population it failed could not report it from
// inside the product. So the regression guard is a RENDER, asserting the two
// halves the fix has to get right at once — the pane that overflows becomes a
// NAMED focus stop, and the pane that does not stays out of the tab order.
// Clearing axe's `scrollable-region-focusable` needs only the first; doing it by
// tabindex-ing all 20+ panes would pass the rule and hand a keyboard reader a
// wall of unnamed, unscrollable stops, which is why the second assertion is here
// and not implied.
//
// Companion: `tests/e2e/shell-a11y-wide.spec.ts` sweeps the whole assembled
// /docs/api with axe and zero rule exclusions. That is the measurement; this is
// the unit that says WHY the measurement passes.

/** happy-dom has no layout, so both metrics are 0 and nothing ever overflows.
 *  Pin them per test — the component's whole branch turns on the comparison. */
function pinMetrics(scroll: number, client: number): void {
  for (const [property, value] of [
    ['scrollWidth', scroll],
    ['clientWidth', client],
    ['scrollHeight', scroll],
    ['clientHeight', client],
  ] as const) {
    Object.defineProperty(globalThis.HTMLElement.prototype, property, {
      configurable: true,
      get: () => value,
    });
  }
}

function restoreMetrics(): void {
  for (const property of ['scrollWidth', 'clientWidth', 'scrollHeight', 'clientHeight']) {
    delete (globalThis.HTMLElement.prototype as unknown as Record<string, unknown>)[property];
  }
}

/** The real `ResizeObserver` needs layout. This one fires its callback on
 *  `observe`, which is exactly what the real one does (observing an element
 *  delivers an initial notification) and is the path the component measures on. */
class StubResizeObserver {
  constructor(private readonly callback: () => void) {}
  observe(): void {
    this.callback();
  }
  unobserve(): void {}
  disconnect(): void {}
}

describe('MOTIR-2494 · a docs code pane is a keyboard-reachable scroll region', () => {
  beforeEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
  });

  afterEach(() => {
    cleanup();
    restoreMetrics();
  });

  it('makes an OVERFLOWING pane a focus stop named by its visible caption', async () => {
    pinMetrics(900, 400);
    const { CodeBlock } = await import('@/app/(public)/docs/_components/CodeBlock');
    render(<CodeBlock caption="curl" code="curl https://app.motir.co/api/v1/me --header x" />);

    // Named, so the stop announces as something. The name is the caption the
    // reader can already see — not a second string to keep true.
    const region = screen.getByRole('group', { name: 'curl' });
    expect(region.tagName).toBe('PRE');
    expect(region.getAttribute('tabindex')).toBe('0');
  });

  it('leaves a pane that does NOT overflow out of the tab order entirely', async () => {
    pinMetrics(400, 400);
    const { CodeBlock } = await import('@/app/(public)/docs/_components/CodeBlock');
    const { container } = render(<CodeBlock caption="application/json" code="{}" />);

    expect(screen.queryByRole('group')).toBeNull();
    expect(container.querySelector('pre[tabindex]')).toBeNull();
    // …and no role at all, so it is not announced as an empty container either.
    expect(container.querySelector('pre')?.hasAttribute('role')).toBe(false);
  });

  it('is a GROUP, not a landmark — 20+ named regions would flood landmark nav', async () => {
    pinMetrics(900, 400);
    const { CodeBlock } = await import('@/app/(public)/docs/_components/CodeBlock');
    render(<CodeBlock caption="application/json" code={'{\n  "a": 1\n}'} />);

    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.getByRole('group', { name: 'application/json' })).toBeTruthy();
  });

  it('degrades to a plain container where nothing can measure it', async () => {
    // No `ResizeObserver` (an old engine, a non-browser render): the pane is not
    // focusable — which is correct, because nothing scrolls there either.
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    pinMetrics(900, 400);
    const { CodeBlock } = await import('@/app/(public)/docs/_components/CodeBlock');
    const { container } = render(<CodeBlock caption="curl" code="curl x" />);

    expect(container.querySelector('pre[tabindex]')).toBeNull();
  });
});
