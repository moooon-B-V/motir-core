import { useId, type ReactNode } from 'react';

// One onboarding section band (MOTIR-8252) — Pattern C of
// `design/onboarding-entrance/onboarding-entrance--vibe-layout.mock.html`
// (MOTIR-8250, design-notes.md's "Section band", "Section title (H2)" and
// "Section body" rows, plus Revision 1's `art` slot). A FULL-WIDTH band:
//
//   ground   `--el-page-bg` — deliberately not the hero's `--el-surface`, because
//            the secondary Button's hover fill IS `--el-surface`
//   rule     top `--el-border`; a band stacked directly on another band takes
//            `--el-border-soft` instead (the `[[data-section-band]+&]` variant,
//            so the screen never has to say which band is first)
//   padding  gutter `clamp(16px,3vw,48px)` · py `clamp(48px,7vw,88px)`
//   head     without `art`: grid `[1.4fr 1fr]`, title left, lede + children
//            right, gap-x 56 · gap-y 16 · `items-start`; one column under 768
//   art      with `art` (Revision 1, how-it-works): two equal columns, the
//            title + lede + children left and the drawing right, `items-center`,
//            gap-x 56; one column under 768 with the drawing under the body
//   h2       `--font-serif` 700 · `clamp(34px,4.4vw,56px)` · lh 0.98 · -0.03em ·
//            `--el-text`
//   body     18 px (17 narrow) · max 44ch · `--el-text-secondary`
//   children e.g. a secondary `lg` button link, 20 px below the body
//
// Presentational: strings and nodes in, no `useTranslations`.

export interface OnboardingSectionProps {
  /** The band's `h2`. */
  title: ReactNode;
  /** The band's body paragraph. */
  lede?: ReactNode;
  /** The band's action(s), under the body — e.g. "We can vibe it too →". */
  children?: ReactNode;
  /** The band's drawing (a `SectionArt`), set beside the text at desktop. */
  art?: ReactNode;
  /** An id for the band (an anchor target). */
  id?: string;
}

const TITLE =
  'm-0 font-serif text-[clamp(34px,4.4vw,56px)] leading-[0.98] font-bold tracking-[-0.03em] text-balance text-(--el-text)';
const BODY =
  'm-0 max-w-[44ch] text-[17px] leading-normal text-(--el-text-secondary) md:text-[18px]';

export function OnboardingSection({ title, lede, children, art, id }: OnboardingSectionProps) {
  const headingId = useId();
  const hasArt = art != null && art !== false;
  const hasChildren = children != null && children !== false;

  const body =
    lede != null || hasChildren ? (
      <div className="grid justify-items-start gap-5">
        {lede != null ? <p className={BODY}>{lede}</p> : null}
        {children}
      </div>
    ) : null;

  return (
    <section
      id={id}
      data-section-band=""
      aria-labelledby={headingId}
      className="border-t border-(--el-border) bg-(--el-page-bg) px-[clamp(16px,3vw,48px)] py-[clamp(48px,7vw,88px)] [[data-section-band]+&]:border-(--el-border-soft)"
    >
      {hasArt ? (
        <div className="grid items-center gap-x-14 gap-y-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="grid content-start gap-4">
            <h2 id={headingId} className={TITLE}>
              {title}
            </h2>
            {body}
          </div>
          {art}
        </div>
      ) : (
        <div className="grid items-start gap-x-14 gap-y-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <h2 id={headingId} className={TITLE}>
            {title}
          </h2>
          {body}
        </div>
      )}
    </section>
  );
}
