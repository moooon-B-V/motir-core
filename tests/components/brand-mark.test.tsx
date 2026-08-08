// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { BrandMark } from '@/components/brand/BrandMark';
import { WAVE_BAND_PATH } from '@/components/brand/waveBand';

// MOTIR-1150 — the ONE component every brand surface composes
// (design/brand/design-notes.md §3, §7, §8).
//
// Two of the three things asserted here are invisible in review and would ship
// wrong without a test: the glyph's `aria-hidden` (which is what makes §8's
// "never both an aria-label and a visible wordmark" achievable at all) and the
// `--brand-size` custom property every derived dimension reads. The third — the
// TYPE PIN — is asserted one level down, in the CSS, because that is where it
// lives; see the `.brand-word` case at the bottom.

afterEach(cleanup);

function glyph(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector('svg');
  expect(svg).not.toBeNull();
  return svg as unknown as SVGSVGElement;
}

describe('BrandMark variants (§3)', () => {
  it('renders the lockup by default: glyph then wordmark, in one inline-flex row', () => {
    const { container } = render(<BrandMark />);
    const lockup = container.querySelector('.brand-lockup')!;
    expect(lockup).not.toBeNull();
    expect(lockup.classList.contains('brand-stacked')).toBe(false);
    expect(screen.getByText('Motir').classList.contains('brand-word')).toBe(true);
    expect(glyph(container).querySelector('path')!.getAttribute('d')).toBe(WAVE_BAND_PATH);
  });

  it('renders the mark alone with NO container and no wordmark', () => {
    // Mark-only carries no `--brand-size` because there is nothing to derive
    // from it, and no text because the wrapping link owns the name (§8).
    const { container } = render(<BrandMark variant="mark" size={24} />);
    expect(container.querySelector('.brand-lockup')).toBeNull();
    expect(screen.queryByText('Motir')).toBeNull();
    expect(glyph(container).getAttribute('width')).toBe('24');
  });

  it('stacks the glyph over the wordmark for a square-ish field', () => {
    const { container } = render(<BrandMark variant="stacked" size={44} />);
    expect(container.querySelector('.brand-lockup.brand-stacked')).not.toBeNull();
  });
});

describe('the size contract — one number, everything derives (§3)', () => {
  it('sets --brand-size and matches the glyph to it', () => {
    const { container } = render(<BrandMark size={26} />);
    const lockup = container.querySelector('.brand-lockup') as HTMLElement;
    expect(lockup.style.getPropertyValue('--brand-size')).toBe('26px');
    expect(glyph(container).getAttribute('width')).toBe('26');
    expect(glyph(container).getAttribute('height')).toBe('26');
  });

  it('keeps the glyph square — the mark is a hair taller than wide and must not stretch', () => {
    // §2 "extent": 21.98 x 22 on the 24-grid, aspect preserved from the source.
    // A non-square box would scale the axes independently, which is §9's first
    // "don't".
    const { container } = render(<BrandMark size={18} />);
    const svg = glyph(container);
    expect(svg.getAttribute('width')).toBe(svg.getAttribute('height'));
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
  });
});

describe('accessible names are the CALLER’s job (§8)', () => {
  it('always hides the glyph from assistive tech, in every variant', () => {
    for (const variant of ['lockup', 'mark', 'stacked'] as const) {
      const { container } = render(<BrandMark variant={variant} />);
      expect(glyph(container).getAttribute('aria-hidden'), variant).toBe('true');
      cleanup();
    }
  });

  it('never emits an aria-label of its own', () => {
    // §8's "never both": a label here PLUS the visible wordmark would make a
    // screen reader announce the brand twice, or announce the label and silently
    // drop the visible text. The component cannot know which slot it is in, so
    // it never guesses — `TopNav` labels its link because it renders `mark`.
    const { container } = render(<BrandMark />);
    expect(container.querySelector('[aria-label]')).toBeNull();
  });

  it('keeps the wordmark as live text, not an image or a background', () => {
    // §8: selectable, translatable, searchable, and it survives a user's
    // font-size preference. next/og and email are the only two exceptions and
    // both are raster surfaces that do not use this component.
    render(<BrandMark />);
    expect(screen.getByText('Motir').tagName).toBe('SPAN');
  });
});

describe('tones and the prefix (§7d)', () => {
  it('takes a locale-supplied wordmark rather than hardcoding one', () => {
    render(<BrandMark label="Motir" prefix="on" />);
    expect(screen.getByText('on').classList.contains('brand-pre')).toBe(true);
  });

  it('renders the prefix BEFORE the glyph, so it reads "on Motir"', () => {
    const { container } = render(<BrandMark prefix="on" />);
    const children = Array.from(container.querySelector('.brand-lockup')!.children);
    expect(children.map((c) => c.className || c.tagName.toLowerCase())).toEqual([
      'brand-pre',
      'brand-glyph',
      'brand-word',
    ]);
  });

  it('drops the prefix on the mark variant, which renders no text at all', () => {
    render(<BrandMark variant="mark" prefix="on" />);
    expect(screen.queryByText('on')).toBeNull();
  });

  it('marks the quiet tone so the wordmark recedes where the brand is the host', () => {
    const { container } = render(<BrandMark tone="quiet" />);
    expect(container.querySelector('.brand-lockup.brand-quiet')).not.toBeNull();
  });

  it('marks the inverted tone for a filled accent field', () => {
    // §9: never put the accent glyph on an accent field — on a filled surface
    // both halves reverse to --el-accent-text.
    const { container } = render(<BrandMark tone="inverted" />);
    expect(container.querySelector('.brand-lockup.brand-inv')).not.toBeNull();
  });
});
