import type { ReactNode } from 'react';
import { OnboardingBrandBar } from './OnboardingBrandBar';

// The wizard screens' bar (MOTIR-8254) — the migrate wizard's and the
// importer's, per `design/onboarding-migrate/design-notes.md` § 2026-10-12
// ("The bar") and `design/import/design-notes.md` § 2026-10-12. It composes
// `OnboardingBrandBar` (Pattern A): the lockup, NOT a link (these bars carry
// their own exits, and a third one on the logo would compete with Save &
// exit), then `· {flowName}`, then the trailing controls, then the decorative
// user initial at the far edge. No fill and no rule — it sits on the hero.
//
//   separator · flow name   `--el-text-secondary` (finding F1: muted ink is
//                           4.17:1 on the hero's `--el-surface` and fails)
//   initial                 `--el-tint-sky` fill, `--el-text-strong` letter,
//                           `rounded-full` 28 px, aria-hidden
//
// Narrow: the controls wrap under the lockup row (`OnboardingBrandBar` wraps);
// the flow name truncates first. Presentational: strings and nodes in.

export interface OnboardingWizardBarProps {
  /** The flow's name, after the lockup. */
  flowName: string;
  /** The decorative user initial at the far edge. */
  userInitial: string;
  /** The bar's controls, in order (planAi, Save & exit, language…). */
  children?: ReactNode;
}

/** The hover override for a `secondary` / `ghost` button sitting in this bar:
 *  the package's hover fill is `--el-surface`, the hero's own ground, so it
 *  would be invisible here (finding F2). */
export const BAR_SECONDARY_HOVER = 'hover:bg-(--el-page-bg) hover:border-(--el-border-strong)';
export const BAR_GHOST_HOVER = 'hover:bg-(--el-page-bg)';

export function OnboardingWizardBar({ flowName, userInitial, children }: OnboardingWizardBarProps) {
  return (
    <OnboardingBrandBar
      linked={false}
      lead={
        <>
          <span aria-hidden="true" className="text-sm text-(--el-text-secondary)">
            ·
          </span>
          <span className="min-w-0 truncate text-sm text-(--el-text-secondary)">{flowName}</span>
        </>
      }
    >
      <span className="ml-auto flex flex-wrap items-center gap-2">
        {children}
        <span
          aria-hidden="true"
          className="grid size-7 flex-none place-items-center rounded-full bg-(--el-tint-sky) text-xs font-semibold text-(--el-text-strong)"
        >
          {userInitial}
        </span>
      </span>
    </OnboardingBrandBar>
  );
}
