// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { StyleVignette } from '@/components/theme/StyleVignette';
import { STYLE_IDS } from '@/lib/theme/styles';
import { PALETTE_IDS } from '@/lib/theme/palettes';
import { TYPE_IDS } from '@/lib/theme/typography';

// Subtask 7.3.37 / MOTIR-1050 — the preview vignette is the reusable specimen
// the onboarding Style gallery (7.3.27) and the Appearance pane (7.3.58) mount.
// This suite pins its contract: it composes the realistic mini-surface (the
// "make the FEEL legible" requirement, not a swatch), it scopes the three axes
// onto its own wrapper when asked, it stays axis-inherited (LIVE) when not, and
// it renders every registered style without throwing (gallery totality).

afterEach(cleanup);

function vignette(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('.style-vignette');
  if (!el) throw new Error('vignette root not found');
  return el;
}

describe('StyleVignette — composition', () => {
  it('composes the mini-surface: nav + work-item card + input + button row + modal', () => {
    const { container } = render(<StyleVignette />);
    const root = vignette(container);
    // The five composed surfaces — each carries the data-surface material hook
    // (or, for the work-item card, the Card primitive's hook), so a material
    // style frosts/grids them exactly as in the shipped app.
    expect(root.querySelector('[data-surface="sidebar"]')).not.toBeNull(); // nav
    expect(root.querySelector('[data-surface="card"]')).not.toBeNull(); // work-item card
    expect(root.querySelector('[data-surface="input"]')).not.toBeNull(); // search input
    expect(root.querySelector('[data-surface="modal"]')).not.toBeNull(); // floating modal
    // Button row — exact Button silhouettes via buttonVariants (radius token).
    expect(root.querySelector('.rounded-\\(--radius-btn\\)')).not.toBeNull();
    // A material canvas layer is always present (transparent for flat styles).
    expect(root.querySelector('.sv-canvas')).not.toBeNull();
  });

  it('is announced as a single labelled image, not a pile of controls', () => {
    const { container } = render(<StyleVignette label="My preview" />);
    const root = vignette(container);
    expect(root.getAttribute('role')).toBe('img');
    expect(root.getAttribute('aria-label')).toBe('My preview');
  });
});

describe('StyleVignette — axis scoping', () => {
  it('LIVE mode (no axis props) emits NO data-* axis attribute — it inherits the active theme', () => {
    const { container } = render(<StyleVignette />);
    const root = vignette(container);
    expect(root.hasAttribute('data-style')).toBe(false);
    expect(root.hasAttribute('data-palette')).toBe(false);
    expect(root.hasAttribute('data-type')).toBe(false);
  });

  it('SCOPED mode pins each given axis onto its own wrapper, leaving the rest inherited', () => {
    const { container } = render(<StyleVignette styleId="neo-brutalism" />);
    const root = vignette(container);
    expect(root.getAttribute('data-style')).toBe('neo-brutalism');
    // Only the pinned axis is emitted; palette + type stay inherited.
    expect(root.hasAttribute('data-palette')).toBe(false);
    expect(root.hasAttribute('data-type')).toBe(false);
  });

  it('scopes all three axes independently when all are given', () => {
    const { container } = render(
      <StyleVignette styleId="glassmorphism" palette="cobalt" type="grotesk" />,
    );
    const root = vignette(container);
    expect(root.getAttribute('data-style')).toBe('glassmorphism');
    expect(root.getAttribute('data-palette')).toBe('cobalt');
    expect(root.getAttribute('data-type')).toBe('grotesk');
  });
});

describe('StyleVignette — gallery totality', () => {
  it('renders every registered style coherently (the gallery use case)', () => {
    for (const id of STYLE_IDS) {
      const { container, unmount } = render(<StyleVignette styleId={id} />);
      expect(vignette(container).getAttribute('data-style')).toBe(id);
      unmount();
    }
  });

  it('renders under every registered palette and type pairing (the palette + type steps)', () => {
    for (const palette of PALETTE_IDS) {
      const { container, unmount } = render(<StyleVignette palette={palette} />);
      expect(vignette(container).getAttribute('data-palette')).toBe(palette);
      unmount();
    }
    for (const type of TYPE_IDS) {
      const { container, unmount } = render(<StyleVignette type={type} />);
      expect(vignette(container).getAttribute('data-type')).toBe(type);
      unmount();
    }
  });
});
