import { cn } from '@/lib/utils/cn';

// The project's MARK in the shell (MOTIR-2679) — the uploaded logo, or NOTHING.
// Replaces `ProjectAvatar`, whose preset icon + colour registry is retired
// (`docs/decisions/entity-marks.md`).
//
// ⚠️ THERE IS NO FALLBACK, and that is the decision this component exists to
// hold. A project with no logo renders NOTHING here — no monogram, no key
// letters, no generated tint, no empty box. Every comparable tool draws a
// generated square instead; §3 of that ADR is the written reason we do not, and
// this early return is where it lives in code. If a later change wants a
// placeholder, it needs to change the ADR first.
//
// Box, radius and fit are the spec `design/shell/design-notes.md` § *The MARK*
// pins once for every surface (the bar, the switcher list, the settings rail,
// the settings row), so the four cannot drift into four slightly different
// marks.
//
// Accessibility: DECORATIVE (`alt=""`). Every site renders the project's NAME
// beside it, so an accessible name here would announce the project twice.

export interface ProjectMarkProps {
  /** The resolved absolute URL, or null when the project has no logo. */
  image: string | null;
  /** Box edge in px — 22 in the bar, 24 in the switcher list, 30/32 in the rail. */
  size: number;
  /**
   * LIST rows only. When true, a project with no logo still occupies the box's
   * width so every row's NAME keeps one left edge — nothing is drawn in it (no
   * border, no fill, no glyph), so the no-mark rule holds exactly; what is
   * preserved is ALIGNMENT, which is a property of the list rather than a mark.
   * The BAR passes this false: a single tier has no column to align to, so there
   * the gap simply closes. Drawn and measured in MOTIR-2675.
   */
  reserveSlot?: boolean;
  className?: string;
}

export function ProjectMark({ image, size, reserveSlot = false, className }: ProjectMarkProps) {
  if (!image) {
    return reserveSlot ? (
      <span aria-hidden className="flex-none" style={{ width: size, height: size }} />
    ) : null;
  }

  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={cn(
        'inline-flex flex-none items-center justify-center overflow-hidden',
        'rounded-(--radius-control)',
        className,
      )}
    >
      {/* A user-uploaded asset on an external host with no known dimensions —
          next/image adds nothing (the same call every avatar site makes). */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image} alt="" className="h-full w-full object-cover" />
    </span>
  );
}
