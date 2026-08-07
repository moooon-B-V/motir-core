import { WAVE_BAND_PATH, WAVE_BAND_VIEW_BOX } from './waveBand';

// The Motir brand lockup — the ONE component every brand surface composes
// (MOTIR-1150 · design/brand/design-notes.md §3 + §7). The glyph is
// `fill="currentColor"`, so the only thing a surface chooses is size, variant,
// tone and whether it is a link.
//
// The presentation lives in `app/globals.css`'s `.brand-*` block, copied from
// the design asset's own CSS (design-notes.md §3 "The reference implementation,
// as CSS"). Two things it carries that are easy to lose in a rewrite:
//
//   1. THE TYPE-AXIS PIN. `.brand-word` reads `var(--font-sans-source)` — the
//      raw FACE variable — and NEVER `var(--font-sans)`, the ROLE token that
//      three `[data-type]` blocks re-point. A wordmark wired to the role looks
//      correct in review and re-letters itself the moment a user changes their
//      Appearance pairing. That was a live defect in the shipped ExploreTopBar.
//   2. Every dimension derives from `--brand-size`, so a surface sets one number
//      and the gap, the wordmark size and the stacked rhythm follow.
//
// ⚠️ ACCESSIBLE NAMES ARE THE CALLER'S JOB, and the rule is about the CONTAINER
// (design-notes.md §8): if the visible wordmark is beside the glyph, the glyph
// is decorative and the link takes its name from the text — so do NOT also put
// an `aria-label` on it. Only the `mark` variant, which renders no text, needs
// the wrapping link to carry the name. That is why the glyph is always
// `aria-hidden` here and this component never emits a label of its own.

export type BrandMarkVariant = 'lockup' | 'mark' | 'stacked';

/**
 * `default` — the accent glyph + `--el-text` wordmark, every chrome surface.
 * `quiet` — a secondary, lighter wordmark for a slot where the brand is the
 *   HOST rather than the subject (`PublicTopBar`, §7d).
 * `inverted` — both reverse to `--el-accent-text`, for a filled accent field.
 */
export type BrandMarkTone = 'default' | 'quiet' | 'inverted';

export interface BrandMarkProps {
  /** `lockup` (default) · `mark` (glyph only) · `stacked` (glyph over word). */
  variant?: BrandMarkVariant;
  /** The glyph box in px. Everything else is derived from it. */
  size?: number;
  tone?: BrandMarkTone;
  /**
   * A small word set before the glyph — the "on" of "on Motir" (§7d). Ignored
   * by the `mark` variant, which renders no text at all.
   */
  prefix?: string;
  /** The wordmark. Locale catalogs carry it verbatim, so callers pass `t(...)`. */
  label?: string;
  className?: string;
}

const TONE_CLASS: Record<BrandMarkTone, string> = {
  default: '',
  quiet: 'brand-quiet',
  inverted: 'brand-inv',
};

export function BrandMark({
  variant = 'lockup',
  size = 32,
  tone = 'default',
  prefix,
  label = 'Motir',
  className,
}: BrandMarkProps) {
  const glyph = (
    <svg
      viewBox={WAVE_BAND_VIEW_BOX}
      width={size}
      height={size}
      className="brand-glyph"
      aria-hidden="true"
      focusable="false"
    >
      <path d={WAVE_BAND_PATH} fill="currentColor" />
    </svg>
  );

  // Mark-only carries no container and no `--brand-size`: there is nothing to
  // derive. The wrapping link owns the accessible name (§8).
  if (variant === 'mark') {
    return className ? <span className={className}>{glyph}</span> : glyph;
  }

  const classes = [
    'brand-lockup',
    variant === 'stacked' ? 'brand-stacked' : '',
    TONE_CLASS[tone],
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      className={classes}
      // The one number every other dimension is computed from (§3).
      style={{ '--brand-size': `${size}px` } as React.CSSProperties}
    >
      {prefix ? <span className="brand-pre">{prefix}</span> : null}
      {glyph}
      <span className="brand-word">{label}</span>
    </span>
  );
}
