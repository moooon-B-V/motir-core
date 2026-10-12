'use client';

import { useRef, type KeyboardEvent, type RefObject } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/Button';
import { cn } from '@/lib/utils/cn';
import { startPlanningAction } from '@/app/(onboarding)/onboarding/actions';
import { AuthLanguageControl } from '@/components/i18n/AuthLanguageControl';
import { OnboardingHero, OnboardingSection } from '@/components/onboarding/layout';

// The onboarding ENTRANCE — the fork the user lands on at `/onboarding`
// (Subtask 7.22.4 / MOTIR-1462, designed by MOTIR-1461 in
// `design/onboarding-entrance/`; re-laid by MOTIR-8253 onto the vibe layout,
// `onboarding-entrance--vibe-layout.mock.html` + design-notes.md § "2026-10-11"
// and its Revisions 1 and 2). It is idea-first: the idea box is the HERO's
// control (Start → the 7.3 discovery chat, seeded with the typed idea), and
// "import an existing project" is ONE section band below the hero — visibly
// secondary: a smaller serif head, a secondary button, the page ground rather
// than the hero's (→ the 7.15 migrate wizard / 7.17 tracker import, owned
// downstream). This screen only ROUTES — it draws no repo-connect,
// source-selection, index, or generate UI (all of that is 7.15/7.17).
//
// Two panels (per the design):
//   • DEFAULT (no carried-over idea) — "Vibe the project", an empty idea box,
//     and the import section band under the hero.
//   • CARRIED (arrived with a preserved idea from the motir.co hero, MOTIR-1458)
//     — "Ready when you are", the idea box PRE-FILLED with the preserved idea and
//     a "Carried over from your idea" label; the import section is dropped (an
//     idea in hand means the user is starting fresh).
//
// "See how Motir works" opens the explainer in a NEW TAB (Revision 1): nothing
// saves a half-typed idea, so a new tab keeps it on screen. The language control
// sits at the trailing end of the brand bar (Revision 2); a switch is a
// `router.refresh()`, which keeps this client component — and the uncontrolled
// textarea's typed text — mounted.
//
// "Start" submits the (possibly edited) idea to `startPlanningAction`, which
// persists it via the same preserved-idea cookie seam the discovery chat already
// reads (`lib/onboarding/pendingIdea.ts`) and redirects to
// `/onboarding/discovery`. Nothing here imports `motir-ai` (the open-core
// invariant): the idea reaches the planner only through the 7.3.4 chat route the
// discovery surface drives.

/** The idea control's id — the element the hero's wave lines gather around. */
export const ONBOARDING_IDEA_CONTROL_ID = 'onboarding-idea';

export interface OnboardingEntranceProps {
  /** The idea preserved across the auth redirect (the motir.co hero → MOTIR-1458
   *  cookie), pre-filled into the box. `null` renders the default panel. */
  carriedIdea: string | null;
}

export function OnboardingEntrance({ carriedIdea }: OnboardingEntranceProps) {
  const t = useTranslations('onboarding.entrance');
  const formRef = useRef<HTMLFormElement>(null);
  const carried = carriedIdea != null && carriedIdea.length > 0;

  return (
    // The page ground. The entrance owns the whole viewport (the (onboarding)
    // route group renders outside the app shell) and is page-shaped now: the
    // hero, then the import band, scrolling as one page. No "Save & exit":
    // nothing is saved here (no project/session exists until the user continues).
    <div className="min-h-dvh bg-(--el-page-bg)">
      <main>
        <OnboardingHero
          headline={carried ? t('headingCarried') : t('headingDefault')}
          lede={carried ? t('subheadCarried') : t('subheadDefault')}
          barEnd={<AuthLanguageControl />}
          controlId={ONBOARDING_IDEA_CONTROL_ID}
          afterLede={
            // The detailed explainer, in a new tab (design Revision 1, close-up
            // 3f): `--el-text`, underlined (the lede above is already the accent
            // ink), the ↗ glyph, and an sr-only "(opens in a new tab)".
            <a
              href="/onboarding/how-it-works"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-1.5 rounded-(--radius-control) text-[15px] font-semibold text-(--el-text) underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--el-accent-on-surface) md:text-[16px]"
            >
              <span>{t('howItWorks')}</span>
              <ArrowUpRight className="size-4" aria-hidden="true" />
              <span className="sr-only"> {t('howItWorksNewTab')}</span>
            </a>
          }
        >
          {/* PRIMARY — the idea box. A form posting to the server action, so it
              works without JS (progressive enhancement); the action seeds the
              idea and redirects to the discovery chat. */}
          <form
            action={startPlanningAction}
            ref={formRef}
            data-surface="card"
            className="grid w-full gap-2.5 rounded-(--radius-card) border border-(--el-border) bg-(--el-card) p-(--spacing-card-padding) text-left shadow-(--shadow-elevated) focus-within:ring-2 focus-within:ring-(--focus-ring-color) focus-within:ring-offset-2 focus-within:ring-offset-(--el-surface)"
          >
            <IdeaFields carried={carried} carriedIdea={carriedIdea} formRef={formRef} />
          </form>
        </OnboardingHero>

        {/* SECONDARY — migrate an existing codebase, one section band under the
            hero (the design dropped the "OR" divider: the band is the
            separation). Dropped in the carried-idea panel: arriving with an idea
            means the user is starting fresh. Routes to the migrate wizard
            (7.15 / MOTIR-934), whose optional Import step reaches the issue
            importer (7.17 / MOTIR-942) at /onboarding/import. */}
        {!carried && (
          <OnboardingSection title={t('importTitle')} lede={t('importDesc')}>
            <Link
              href="/onboarding/migrate"
              className={cn(buttonVariants({ variant: 'secondary', size: 'lg' }), 'no-underline')}
            >
              <span>{t('importCta')}</span>
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </OnboardingSection>
        )}
      </main>
    </div>
  );
}

/**
 * The form's body — label, textarea and footer. Its own component because
 * `useFormStatus()` reads the status of the form it is rendered INSIDE: while
 * the action runs, Start shows the package Button's own `loading` (the Spinner,
 * `disabled`, `aria-busy`, label unchanged) and the textarea is disabled beside
 * it (design close-up 3d).
 */
function IdeaFields({
  carried,
  carriedIdea,
  formRef,
}: {
  carried: boolean;
  carriedIdea: string | null;
  formRef: RefObject<HTMLFormElement | null>;
}) {
  const t = useTranslations('onboarding.entrance');
  const { pending } = useFormStatus();

  // ⌘/Ctrl + Enter submits from the textarea (the box holds focus on load), so a
  // long idea can be sent without reaching for the mouse. A bare Enter keeps
  // inserting newlines — this is a multi-line description, not a chat line.
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      formRef.current?.requestSubmit();
    }
  }

  return (
    <>
      <label
        htmlFor="onboarding-idea-input"
        className={cn(
          'flex items-center gap-1.5 font-mono text-[11px] font-semibold tracking-[0.1em] uppercase',
          carried ? 'text-(--el-accent-on-surface)' : 'text-(--el-text-secondary)',
        )}
      >
        {carried ? (
          <>
            <span className="inline-block size-1.5 rounded-full bg-(--el-accent)" aria-hidden />
            <span>{t('carriedLabel')}</span>
          </>
        ) : (
          t('ideaLabel')
        )}
      </label>
      <textarea
        id="onboarding-idea-input"
        name="idea"
        rows={4}
        defaultValue={carriedIdea ?? ''}
        onKeyDown={onKeyDown}
        // The idea box is the entrance's primary control; focusing it on load is
        // the intended affordance (design Panel 3).
        autoFocus
        disabled={pending}
        aria-label={t('ideaLabel')}
        placeholder={t('placeholder')}
        // A long idea GROWS (`field-sizing: content`) from 10rem narrow / 7.5rem
        // desktop up to 18rem, then scrolls inside the card, so the footer and
        // Start never drop below the fold. The PLACEHOLDER is text a reader reads
        // before they type, so it takes `--el-text-secondary`; `--el-text-faint`
        // put it at 2.61:1 (MOTIR-2475).
        className="max-h-[18rem] min-h-[10rem] w-full resize-none overflow-y-auto border-0 bg-transparent p-0 text-[17px] leading-normal text-(--el-text) outline-none [field-sizing:content] placeholder:text-(--el-text-secondary) disabled:opacity-70 md:min-h-[7.5rem] md:text-[18px]"
      />
      {/* The footer: the hint moved INTO the card (motir.co's place for it),
          hint left, Start right; it wraps at narrow widths, hint above. */}
      <div className="flex flex-wrap items-center gap-3 border-t border-(--el-border-soft) pt-3">
        <span className="mr-auto text-[13px] text-(--el-text-secondary)">
          {carried ? t('hintCarried') : t('hintDefault')}
        </span>
        <Button
          type="submit"
          variant="primary"
          loading={pending}
          className="ml-auto"
          rightIcon={<ArrowRight className="size-4" />}
        >
          {carried ? t('continueCta') : t('startCta')}
        </Button>
      </div>
    </>
  );
}
