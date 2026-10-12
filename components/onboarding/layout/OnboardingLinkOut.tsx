import { useId, type ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';

// The link-out band to motir.co (MOTIR-8252) — design-notes.md § "Revision 1
// (2026-10-12)", "What changed" item 4, close-up 3g, and the parts table's
// `OnboardingLinkOut` row ("motir.co's closing-block shape, pointed outward").
// The how-it-works screen places it after its section bands (MOTIR-8253).
//
//   band     `--el-page-bg`, gutter `clamp(16px,3vw,48px)`, pb 56 px (40 narrow)
//   field    an inset `data-showcase="field"` card — `--el-showcase-field`,
//            `--radius-card`, `--shadow-card`, `--el-border`; padding
//            2 × / 2.5 × `--spacing-card-padding` (1 × / 2 × narrow — the mock's
//            narrow 40 px, kept on the token so a style swap re-shapes it)
//   h2       centred serif 700, 48 px (32 narrow), lh 0.98, -0.03em,
//            `--el-showcase-field-text` (6.31:1 light / 6.34:1 dark, measured)
//   body     18 px (16 narrow), max 46ch, `--el-showcase-field-text`
//   button   ONE warm link — `--el-showcase-decision` fill,
//            `--el-showcase-decision-text` ink (4.65:1 / 5.89:1), `--radius-btn`,
//            `--height-btn-lg`, `--spacing-btn-x`; hover `brightness-105`; focus
//            outline `--el-showcase-field-text`; `target="_blank"
//            rel="noopener"`, `ArrowUpRight`, and an sr-only `newTabLabel`
//            appended to its accessible name
//
// `data-showcase="field"` is the hook the design system's surface-material
// styles key on (`theme.css` keeps the field's fill under a material style's
// chrome), so it is not decoration. Presentational: strings and nodes in, no
// `useTranslations` — the screen passes its own keys
// (`onboarding.howItWorks.developers.*`).

export interface OnboardingLinkOutProps {
  /** The field's `h2`. */
  title: ReactNode;
  /** The paragraph under it. */
  body?: ReactNode;
  /** The button's visible label. */
  cta: ReactNode;
  /** Where the button goes — an external page, opened in a new tab. */
  href: string;
  /** The sr-only hint appended to the button's name, e.g. "(opens in a new tab)". */
  newTabLabel: string;
}

export function OnboardingLinkOut({ title, body, cta, href, newTabLabel }: OnboardingLinkOutProps) {
  const headingId = useId();
  return (
    <div
      data-onboarding-link-out=""
      className="bg-(--el-page-bg) px-[clamp(16px,3vw,48px)] pb-10 md:pb-14"
    >
      <section
        data-showcase="field"
        aria-labelledby={headingId}
        className="grid justify-items-center gap-5 rounded-(--radius-card) border border-(--el-border) bg-(--el-showcase-field) px-(--spacing-card-padding) py-[calc(var(--spacing-card-padding)*2)] text-center text-(--el-showcase-field-text) shadow-(--shadow-card) md:px-[calc(var(--spacing-card-padding)*2)] md:py-[calc(var(--spacing-card-padding)*2.5)]"
      >
        <h2
          id={headingId}
          className="m-0 font-serif text-[32px] leading-[0.98] font-bold tracking-[-0.03em] text-balance text-(--el-showcase-field-text) md:text-[48px]"
        >
          {title}
        </h2>
        {body != null ? (
          <p className="m-0 max-w-[46ch] text-[16px] leading-normal text-(--el-showcase-field-text) md:text-[18px]">
            {body}
          </p>
        ) : null}
        <a
          href={href}
          target="_blank"
          rel="noopener"
          className="inline-flex h-(--height-btn-lg) items-center gap-2 rounded-(--radius-btn) bg-(--el-showcase-decision) px-(--spacing-btn-x) text-[15px] font-medium text-(--el-showcase-decision-text) no-underline hover:brightness-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--el-showcase-field-text)"
        >
          <span>{cta}</span>
          <ArrowUpRight className="size-4" aria-hidden="true" />
          <span className="sr-only"> {newTabLabel}</span>
        </a>
      </section>
    </div>
  );
}
