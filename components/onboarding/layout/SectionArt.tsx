import type { CSSProperties, ReactNode } from 'react';

// The drawing kit for an `OnboardingSection`'s `art` slot (MOTIR-8252) —
// design-notes.md § "Revision 1 (2026-10-12)", "What changed" item 1 and its
// parts table (`SectionArt`: "the tinted field + paper + skeleton bar kit").
// motir.co's ModuleArt idiom — a tinted field holding a small example screen —
// with the design's one deliberate departure: the drawings are WORDLESS.
// Example copy in a picture would be strings with no catalogue keys, so the
// screens are drawn in skeleton bars and the heading and body beside the field
// carry the meaning.
//
// The three drawings themselves (`SayArt` · `WatchArt` · `DecideArt`) are the
// how-it-works screen's, MOTIR-8253; this file is only the vocabulary they are
// composed from:
//
//   SectionArt  the field — `aria-hidden`, a tint slot (`--el-tint-*`, a
//               different slot per drawing so they read apart in every palette),
//               `--radius-card` · `--spacing-card-padding` · `--shadow-card` ·
//               `--el-border`; 248 px tall, 208 narrow; contents centred
//   ArtPaper    a small screen on the field — `--el-card` on `--el-border`,
//               `--radius-card`, `--shadow-subtle`; the drawing sets its padding
//   ArtBar      a skeleton text line — `--el-border-strong`, `--radius-badge`,
//               8 px tall, `width` as a percentage of its row
//
// Because the field is `aria-hidden`, nothing inside it is announced or
// measured; nothing inside it should be focusable either.

export type SectionArtTint = 'sky' | 'lavender' | 'peach' | 'mint' | 'rose' | 'yellow';

// Literal class strings, so Tailwind sees every one of them.
const TINT_CLASS: Record<SectionArtTint, string> = {
  sky: 'bg-(--el-tint-sky)',
  lavender: 'bg-(--el-tint-lavender)',
  peach: 'bg-(--el-tint-peach)',
  mint: 'bg-(--el-tint-mint)',
  rose: 'bg-(--el-tint-rose)',
  yellow: 'bg-(--el-tint-yellow)',
};

function cx(...parts: Array<string | undefined | false>): string {
  return parts.filter(Boolean).join(' ');
}

export interface SectionArtProps {
  /** The field's tint slot. */
  tint: SectionArtTint;
  /** Names the drawing (`data-section-art`), e.g. `say` · `watch` · `decide`. */
  name?: string;
  children?: ReactNode;
  className?: string;
}

export function SectionArt({ tint, name, children, className }: SectionArtProps) {
  return (
    <div
      aria-hidden="true"
      data-section-art={name ?? ''}
      className={cx(
        'relative grid h-[208px] content-center gap-3 overflow-hidden rounded-(--radius-card) border border-(--el-border) p-(--spacing-card-padding) shadow-(--shadow-card) md:h-[248px]',
        TINT_CLASS[tint],
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface ArtPaperProps {
  children?: ReactNode;
  /** The drawing's own padding and inner layout (e.g. `grid gap-2 px-3 py-2.5`). */
  className?: string;
}

export function ArtPaper({ children, className }: ArtPaperProps) {
  return (
    <div
      data-art-paper=""
      className={cx(
        'rounded-(--radius-card) border border-(--el-border) bg-(--el-card) shadow-(--shadow-subtle)',
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface ArtBarProps {
  /** The line's width, as a percentage of its row (0–100). */
  width: number;
  className?: string;
}

export function ArtBar({ width, className }: ArtBarProps) {
  const pct = Math.max(0, Math.min(100, width));
  const style: CSSProperties = { width: `${pct}%` };
  return (
    <span
      data-art-bar=""
      className={cx('block h-2 rounded-(--radius-badge) bg-(--el-border-strong)', className)}
      style={style}
    />
  );
}
