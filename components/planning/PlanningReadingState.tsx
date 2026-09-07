'use client';

import { useTranslations } from 'next-intl';
import { BookOpenText, ListTree } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { OnboardingSubstrate } from '@/lib/dto/onboardingSubstrate';

// THE READING STATE (MOTIR-4768, story MOTIR-4753) — what the plan window says
// while a session is deciding whether this project can be planned at all.
//
// ── WHY IT EXISTS ───────────────────────────────────────────────────────────
// MOTIR-4765 removed the gate, so a project whose first plan has never been
// approved now OPENS the workspace instead of being ejected to `/onboarding`.
// The first thing that happens inside it is that Motir reads what the project
// already has — and until this component, the user was shown nothing about that.
//
// ⚠️ IT NAMES THE THINGS, AND THAT IS THE WHOLE DESIGN. A spinner says
// *something is happening*; this says *I am reading acme/widgets and 214 work
// items*, which is the product demonstrating in one sentence the thing the whole
// story argues for, before any plan exists to judge. It is also what makes the
// hand-off survivable (MOTIR-4769): a user who is about to be moved somewhere
// else has just watched the product look at what they brought.
//
// ⚠️ NOT A PROGRESS BAR, and the constraint is this card's own. Nothing on this
// path knows a duration: the verdict is one model call whose length nobody can
// predict. A bar has a track, a fill and therefore a claim about how far along it
// is, and it would have to keep that claim while the call sits in the middle of
// it. Three quiet dots and *usually takes a few seconds* promise only what is
// true. THERE IS NO `role="progressbar"` HERE AND THERE MUST NOT BE ONE.
//
// ── THE SOURCE OF EVERY WORD ────────────────────────────────────────────────
// `design/ai-chat/reading-and-handoff.mock.html` panels 1 and 2 (MOTIR-4766),
// composed rather than re-invented: the `Card`, the eyebrow, the heading, the
// lede, the `.src` rows with their tinted icon tile and `Reading` chip, and the
// activity line. Every value on screen comes from `readOnboardingSubstrate`
// (MOTIR-4756) and from nothing else.
//
// ⚠️ ONE DEVIATION FROM THE MOCK, AND IT IS DELIBERATE. The mock's repository
// sub-line reads *"Code graph ready · 1,204 files"*. The substrate read has no
// file count and this component invents none — a number nobody measured is worse
// than a number nobody shows. The sub-line carries the half that IS known: has
// this repository got a code graph yet.
//
// ── WHEN IT GOES AWAY ───────────────────────────────────────────────────────
// It renders while `substrate` is present, and the surface that takes it down is
// MOTIR-4769: the routing verdict either moves the user to onboarding or lets the
// session plan, and either way this state has done its job. That sibling owns the
// dismissal; this card owns what is on screen until then.

export interface PlanningReadingStateProps {
  /** What the project already has — the values named on screen. */
  substrate: OnboardingSubstrate;
}

/**
 * IS THERE ANYTHING TO NAME? Exported because the THIN variant is a different
 * sentence rather than the same list with nothing in it, and because the caller
 * (and its tests) should be able to ask the question the component branches on.
 *
 * ⚠️ IT IS NOT A COUNT COMPARISON DRESSED UP. Both halves are presence checks —
 * *are there repositories?* and *are there items?* — which is exactly what the
 * copy says out loud. No threshold decides anything here; whether the substrate
 * is ENOUGH is the planner's judgement, one repository over (MOTIR-4767).
 */
export function substrateHasSomethingToName(substrate: OnboardingSubstrate): boolean {
  return substrate.repositories.length > 0 || substrate.itemCount > 0;
}

export function PlanningReadingState({ substrate }: PlanningReadingStateProps) {
  const t = useTranslations('planningWorkspace.reading');
  const rich = substrateHasSomethingToName(substrate);

  return (
    <div
      className="flex h-full w-full items-center justify-center p-(--spacing-card-padding)"
      // A LIVE REGION, not a progress bar: what changes here is a STATEMENT, and
      // `polite` is what announces one without interrupting.
      aria-live="polite"
    >
      <div
        className={cn(
          'w-full max-w-[32.5rem] rounded-(--radius-card) border border-(--el-border)',
          'bg-(--el-card) p-(--spacing-card-padding) shadow-(--shadow-subtle)',
        )}
        data-testid="planning-reading-state"
      >
        <p className="text-xs font-semibold tracking-wide text-(--el-text-eyebrow) uppercase">
          {t('eyebrow')}
        </p>
        <h2 className="mt-1.5 text-xl font-semibold text-(--el-text)">
          {rich ? t('title') : t('titleThin')}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-(--el-text-secondary)">
          {rich ? t('lede') : t('ledeThin')}
        </p>

        {/* ⚠️ THE THIN CASE RENDERS NO LIST AT ALL — not an empty one. Three rows
            saying `none` is a report card, handed to a user in the seconds before
            they are moved somewhere, which turns the move into a verdict on them.
            The sentence above states the same fact and carries a clause the list
            cannot: *that's normal, and it's the next thing we'll fix*. */}
        {rich ? (
          <ul className="mt-4 flex flex-col gap-2">
            {substrate.repositories.map((repo) => (
              <SourceRow
                key={repo.ref}
                icon={<BookOpenText className="size-3.5" aria-hidden />}
                name={repo.ref}
                sub={repo.indexed ? t('repoIndexed') : t('repoConnecting')}
                chip={t('chip')}
              />
            ))}
            {substrate.itemCount > 0 ? (
              <SourceRow
                icon={<ListTree className="size-3.5" aria-hidden />}
                // ⚠️ `200+`, NEVER AN EXACT `200`. `itemCountTruncated` says the
                // read STOPPED at the cap, so the count is a FLOOR — and it is
                // the number the planner's judgement is about to rest on.
                // Rendering it as exact would be the surface making a claim the
                // read explicitly refused to make.
                name={
                  substrate.itemCountTruncated
                    ? t('itemsCapped', { count: substrate.itemCount })
                    : t('items', { count: substrate.itemCount })
                }
                sub={
                  substrate.itemCountTruncated
                    ? t('itemsCappedSub', { count: substrate.itemCount })
                    : t('itemsSub')
                }
                chip={t('chip')}
              />
            ) : null}
          </ul>
        ) : null}

        <p className="mt-4 flex items-center gap-2 text-xs text-(--el-text-secondary)">
          <span className="inline-flex flex-none gap-1" aria-hidden>
            <i className="size-1.5 rounded-(--radius-badge) bg-(--el-accent)" />
            <i className="size-1.5 rounded-(--radius-badge) bg-(--el-accent) opacity-60" />
            <i className="size-1.5 rounded-(--radius-badge) bg-(--el-accent) opacity-30" />
          </span>
          {rich ? t('activity') : t('activityThin')}
        </p>
      </div>
    </div>
  );
}

/** One named thing Motir is reading — the mock's `.src` row. */
function SourceRow({
  icon,
  name,
  sub,
  chip,
}: {
  icon: React.ReactNode;
  name: string;
  sub: string;
  chip: string;
}) {
  return (
    <li className="flex items-center gap-2.5 rounded-(--radius-control) border border-(--el-border) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y)">
      <span className="grid size-6.5 flex-none place-items-center rounded-(--radius-control) bg-(--el-tint-sky) text-(--el-text-strong)">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-(--el-text-strong)">{name}</span>
        {/* `--el-text-secondary`, not `--el-text-muted`: this row sits on
            `--el-surface-soft`, where muted measures 4.34:1 and fails AA. */}
        <span className="mt-px block text-xs text-(--el-text-secondary)">{sub}</span>
      </span>
      <span className="ml-auto flex-none rounded-(--radius-badge) bg-(--el-tint-sky) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-semibold text-(--el-text-strong)">
        {chip}
      </span>
    </li>
  );
}
