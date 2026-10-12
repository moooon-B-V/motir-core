import type { ReactNode } from 'react';

// The work band (MOTIR-8254) — `OnboardingSection`'s band with no head, per
// `design/onboarding-migrate/design-notes.md` § 2026-10-12 ("The work band").
// The wizard screens put their working row (the rail and the step) in it, under
// the hero, instead of in an outer centred card: the step's own card is the one
// card on the page.
//
//   ground   `--el-page-bg`, top rule `--el-border` (`--el-border-soft` when it
//            follows another band, as `OnboardingSection`)
//   padding  gutter `clamp(16px,3vw,48px)` · py 32 px (48 px from md)

export interface OnboardingWorkBandProps {
  children?: ReactNode;
  /** An accessible name for the band, when it needs one. */
  'aria-label'?: string;
}

export function OnboardingWorkBand({ children, ...rest }: OnboardingWorkBandProps) {
  return (
    <section
      data-section-band=""
      data-onboarding-work-band=""
      aria-label={rest['aria-label']}
      className="border-t border-(--el-border) bg-(--el-page-bg) px-[clamp(16px,3vw,48px)] py-8 md:py-12 [[data-section-band]+&]:border-(--el-border-soft)"
    >
      {children}
    </section>
  );
}
