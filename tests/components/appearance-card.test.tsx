// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ThemeProvider } from '@/lib/contexts/theme-context';
import { AppearanceCard } from '@/app/(authed)/settings/account/_components/AppearanceCard';

// Appearance pane layout (Subtask 8.8.15 / MOTIR-1198). A pure layout change:
// the EXISTING shipped controls (the axis-controls Card) sit on the LEFT and the
// EXISTING StyleVignette example on the RIGHT, side by side at the desktop
// breakpoint and stacked (example below) below it. This suite pins that the
// outer wrapper is the two-column grid container and that BOTH shipped pieces
// still render inside it — without changing either piece's own design.

// ThemeProvider reads the prefers-color-scheme media query via
// useSyncExternalStore; happy-dom omits matchMedia, so provide a light-scheme
// stub (the same minimal-API shim pattern other component tests use).
beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  })) as typeof window.matchMedia;
});

afterEach(cleanup);

// Anonymous (signedIn=false, no initialPreference) keeps the localStorage-only
// path — no `/api/appearance-preference` PATCH fires, so no fetch stub is needed.
function renderCard() {
  return render(
    <ThemeProvider>
      <AppearanceCard />
    </ThemeProvider>,
  );
}

describe('AppearanceCard — two-column layout (8.8.15)', () => {
  it('wraps the controls and the example in a single two-column grid container', () => {
    const { container } = renderCard();
    const grid = container.querySelector<HTMLElement>('div.grid');
    expect(grid).not.toBeNull();
    // Two columns at the desktop breakpoint; single stacked column below it.
    expect(grid!.className).toContain('lg:grid-cols-');
    // Exactly the two existing blocks — controls + example — as its children.
    const children = Array.from(grid!.children);
    expect(children).toHaveLength(2);
  });

  it('renders the existing controls on the LEFT and the StyleVignette example on the RIGHT', () => {
    const { container } = renderCard();
    const grid = container.querySelector<HTMLElement>('div.grid')!;
    const children = Array.from(grid.children) as HTMLElement[];
    expect(children).toHaveLength(2);
    const left = children[0]!;
    const right = children[1]!;

    // LEFT — the shipped controls Card (untinted → emits data-surface="card"),
    // holding the axis controls, NOT the example.
    expect(left.getAttribute('data-surface')).toBe('card');
    expect(left.querySelector('.style-vignette')).toBeNull();

    // RIGHT — the shipped StyleVignette example (LIVE mode, no scoped axis).
    expect(right.querySelector('.style-vignette')).not.toBeNull();

    // Both pieces present exactly once — neither piece's own design changed.
    expect(container.querySelectorAll('.style-vignette')).toHaveLength(1);
  });
});
