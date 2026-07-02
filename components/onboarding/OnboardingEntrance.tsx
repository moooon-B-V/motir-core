'use client';

import { useRef, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowRight, GitBranch, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { startPlanningAction } from '@/app/(onboarding)/onboarding/actions';

// The onboarding ENTRANCE — the fork the user lands on at `/onboarding`
// (Subtask 7.22.4 / MOTIR-1462, designed by MOTIR-1461 in
// `design/onboarding-entrance/`). It is idea-first: ONE full-width idea box is
// the primary path (Start planning → the 7.3 discovery chat, seeded with the
// typed idea), and "import an existing project" is a first-class but SECONDARY
// row below it (→ the 7.15 migrate wizard / 7.17 tracker import, owned
// downstream). This screen only ROUTES — it draws no repo-connect,
// source-selection, index, or generate UI (all of that is 7.15/7.17).
//
// Two panels (per the design):
//   • DEFAULT (no carried-over idea) — "How would you like to start?", an empty
//     idea box, and the OR + import row.
//   • CARRIED (arrived with a preserved idea from the motir.co hero, MOTIR-1458)
//     — "Ready when you are", the idea box PRE-FILLED with the preserved idea and
//     a "Carried over from your idea" label; the import row is dropped (an idea
//     in hand means the user is starting fresh).
//
// "Start planning" submits the (possibly edited) idea to `startPlanningAction`,
// which persists it via the same preserved-idea cookie seam the discovery chat
// already reads (`lib/onboarding/pendingIdea.ts`) and redirects to
// `/onboarding/discovery`. Nothing here imports `motir-ai` (the open-core
// invariant): the idea reaches the planner only through the 7.3.4 chat route the
// discovery surface drives.
//
// The eyebrow reads "Build with AI" (not "Plan with AI") — Motir plans AND
// builds, so the outcome word is "build" (Yue; the rename propagates to the
// sign-in door / in-app entry / marketing badge on their own cards).

export interface OnboardingEntranceProps {
  /** The idea preserved across the auth redirect (the motir.co hero → MOTIR-1458
   *  cookie), pre-filled into the box. `null` renders the default panel. */
  carriedIdea: string | null;
}

export function OnboardingEntrance({ carriedIdea }: OnboardingEntranceProps) {
  const t = useTranslations('onboarding.entrance');
  const formRef = useRef<HTMLFormElement>(null);
  const carried = carriedIdea != null && carriedIdea.length > 0;

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
    <div className="flex min-h-dvh flex-col bg-(--el-page)">
      {/* Brand bar — the entrance owns the whole viewport (the (onboarding) route
          group renders outside the app shell). No "Save & exit": nothing is saved
          here (no project/session exists until the user continues). */}
      <header className="border-(--el-border) flex items-center gap-2 border-b px-6 py-3.5">
        <span className="flex items-center gap-2 text-sm font-semibold text-(--el-text)">
          <span
            className="grid size-7 place-items-center rounded-(--radius-control) bg-(--el-tint-lavender) text-(--el-text-strong)"
            aria-hidden
          >
            <Sparkles className="size-4" strokeWidth={2} />
          </span>
          Motir
        </span>
      </header>

      <main className="mx-auto w-full max-w-[41.25rem] px-7 pb-14 pt-13">
        {/* Header — eyebrow + serif headline + subhead. The full plan → build
            lifecycle is stated in the subhead prose (Motir plans, then agents
            build it); the detailed "how it works" explainer is its own surface,
            not yet built, so no on-screen link is drawn until it ships. */}
        <div className="mb-6 text-center">
          <span className="mb-3.5 inline-flex items-center gap-1.5 rounded-(--radius-badge) bg-(--el-tint-lavender) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-semibold text-(--el-text-strong)">
            <Sparkles className="size-3.5" strokeWidth={2} aria-hidden />
            {t('eyebrow')}
          </span>
          <h1 className="font-serif text-4xl font-bold leading-tight tracking-tight text-(--el-text)">
            {carried ? t('headingCarried') : t('headingDefault')}
          </h1>
          <p className="mx-auto mt-2 max-w-[52ch] text-(--el-text-secondary)">
            {carried ? t('subheadCarried') : t('subheadDefault')}
          </p>
          {/* The detailed "how it works" explainer — its own surface, deferred by
              the design (a future card owns it), so this links to a placeholder
              hand-off for now (like the import row). Shown in both panels. */}
          <Link
            href="/onboarding/how-it-works"
            className="mt-3.5 inline-flex items-center gap-1.5 text-[0.8rem] font-medium text-(--el-accent-on-surface) hover:underline"
          >
            {t('howItWorks')}
            <ArrowRight className="size-3.5" />
          </Link>
        </div>

        {/* PRIMARY — the idea box. A form posting to the server action, so it
            works without JS (progressive enhancement); the action seeds the idea
            and redirects to the discovery chat. */}
        <form action={startPlanningAction} ref={formRef}>
          <div className="rounded-(--radius-card) border border-(--el-accent) bg-(--el-card) p-(--spacing-card-padding) shadow-(--shadow-elevated)">
            <div
              className={
                'mb-2 flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider ' +
                (carried ? 'text-(--el-accent-on-surface)' : 'text-(--el-text-faint)')
              }
            >
              {carried ? (
                <>
                  <span
                    className="inline-block size-1.5 rounded-full bg-(--el-accent)"
                    aria-hidden
                  />
                  {t('carriedLabel')}
                </>
              ) : (
                t('ideaLabel')
              )}
            </div>
            <textarea
              name="idea"
              rows={7}
              defaultValue={carriedIdea ?? ''}
              onKeyDown={onKeyDown}
              // The idea box is the entrance's primary control; focusing it on
              // load is the intended affordance (design Panel 3).
              autoFocus
              aria-label={t('ideaLabel')}
              placeholder={t('placeholder')}
              className="min-h-[10.75rem] w-full resize-none border-0 bg-transparent text-(--el-text) outline-none placeholder:text-(--el-text-faint)"
            />
            <div className="border-(--el-border-soft) mt-3 flex justify-end border-t pt-3">
              <Button type="submit" variant="primary" rightIcon={<ArrowRight className="size-4" />}>
                {carried ? t('continueCta') : t('startCta')}
              </Button>
            </div>
          </div>
        </form>
        <p className="mx-0.5 mt-2.5 text-xs text-(--el-text-muted)">
          {carried ? t('hintCarried') : t('hintDefault')}
        </p>

        {/* SECONDARY — import an existing project. Dropped in the carried-idea
            panel: arriving with an idea means the user is starting fresh. It is a
            real link to the import hand-off (owned downstream by 7.15/7.17). */}
        {!carried && (
          <>
            <div className="mx-0.5 my-5 flex items-center gap-3 font-mono text-[11px] font-semibold tracking-wide text-(--el-text-faint) before:h-px before:flex-1 before:bg-(--el-border) before:content-[''] after:h-px after:flex-1 after:bg-(--el-border) after:content-['']">
              {t('or')}
            </div>
            <Link
              href="/onboarding/import"
              className="flex w-full items-center gap-3.5 rounded-(--radius-card) border border-(--el-border) bg-(--el-card) p-(--spacing-card-padding) text-left shadow-(--shadow-subtle) transition-colors hover:border-(--el-border-strong)"
            >
              <span
                className="grid size-9.5 flex-none place-items-center rounded-(--radius-control) bg-(--el-tint-sky) text-(--el-text-strong)"
                aria-hidden
              >
                <GitBranch className="size-5" strokeWidth={2} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-(--el-text)">
                  {t('importTitle')}
                </span>
                <span className="mt-1 block text-[0.8rem] leading-snug text-(--el-text-secondary)">
                  {t('importDesc')}
                </span>
              </span>
              <span className="flex flex-none items-center gap-1.5 text-[0.8rem] font-semibold text-(--el-accent-on-surface)">
                {t('importCta')}
                <ArrowRight className="size-4" />
              </span>
            </Link>
          </>
        )}
      </main>
    </div>
  );
}
