'use client';

import { useTranslations } from 'next-intl';
import { BookOpenText, Info } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import {
  MIGRATE_ROUTING_STEPS,
  type MigrateRoutingStep,
  type OnboardingRoutingVerdict,
} from '@/lib/dto/onboardingRouting';

// THE HAND-OFF (MOTIR-4769, story MOTIR-4753) — what the plan window says when
// the planner has decided this project cannot be planned yet, and where the user
// is going instead.
//
// ⚠️ IT IS SHOWN BEFORE THE MOVE HAPPENS. A user who pressed *Plan with AI* and
// is then silently redirected has had the most jarring thing a product can do to
// them done with no explanation. They read this, and they press the button.
//
// ── THE TWO OUTCOMES ARE TOLD APART BY STRUCTURE, NOT BY A COLOUR ────────────
// `design/ai-chat/reading-and-handoff.mock.html` panels 3 and 4 (MOTIR-4766),
// and the difference is what makes them distinguishable at a glance AND in a
// screen reader:
//
//                  | onboard_new_project        | onboard_existing_project
//   heading        | Let's set your project…    | A couple of things first (it COUNTS)
//   found block    | — nothing was found        | I read acme/widgets and 214 work items
//   missing list   | —                          | the planner's own words, one row each
//   kept steps     | —                          | what you'll be asked · what is skipped
//
// ⚠️ EVERY WORD OF THE MISSING LIST IS THE PLANNER'S (MOTIR-4767 returns it).
// This surface renders it and writes none of it. It is drawn as a list of GAPS —
// a dashed open circle per row — and never as an error list: no red, no warning
// triangle. The thing is incomplete, not wrong.
//
// ⚠️ AND NEITHER READS AS AN ERROR, A REFUSAL OR A DEAD END. Nothing failed: the
// read worked and it produced a finding. It is about what Motir can SEE, never
// about the person who built the project. Both carry a way onward AND a way out
// — *Not now* is deliberately present, because a user who opened the window to
// look around is allowed to close it again, and a hand-off with one button is a
// wall with a door painted on it.
//
// ── THE KEPT-STEP STRIP IS THE APOLOGY THIS ROUTE OWES ──────────────────────
// Sending somebody to re-connect a repository they connected last week is the
// same insult as the interview, one surface along. So the verdict says which
// steps have anything left to do, and this shows that BEFORE the user commits.
// The skipped chips reuse `design/onboarding-migrate/`'s sky tint and read glyph
// (Panel 5, MOTIR-4755) rather than inventing a second way to say the same fact.

export interface PlanningHandOffProps {
  verdict: OnboardingRoutingVerdict;
  /** What Motir read, already named — the FOUND block's own words. */
  sources: string[];
  /** Go. The move, and the launch context it carries, are the caller's. */
  onGo: () => void;
  /** Close the window instead. */
  onDismiss: () => void;
}

const STEP_LABEL_KEY: Record<MigrateRoutingStep, string> = {
  connect: 'stepConnect',
  index: 'stepIndex',
  import: 'stepImport',
  audit_convention: 'stepAuditConvention',
  discovery: 'stepDiscovery',
  generate: 'stepGenerate',
  review: 'stepReview',
};

export function PlanningHandOff({ verdict, sources, onGo, onDismiss }: PlanningHandOffProps) {
  const t = useTranslations('planningWorkspace.handoff');
  const existing = verdict.outcome === 'onboard_existing_project';
  const missing = verdict.missing ?? [];
  const kept = verdict.keptSteps ?? [];
  // What the wizard will NOT run — the strip's second half, and the reason the
  // first half is worth showing at all.
  const skipped = existing ? MIGRATE_ROUTING_STEPS.filter((s) => !kept.includes(s)) : [];

  return (
    <div
      className="flex h-full w-full items-center justify-center p-(--spacing-card-padding)"
      aria-live="polite"
    >
      <div
        className={cn(
          'w-full max-w-[33.75rem] rounded-(--radius-card) border border-(--el-border)',
          'bg-(--el-card) p-(--spacing-card-padding) shadow-(--shadow-subtle)',
        )}
        data-testid="planning-handoff"
        data-outcome={verdict.outcome}
      >
        <p className="text-xs font-semibold tracking-wide text-(--el-text-eyebrow) uppercase">
          {t('eyebrow')}
        </p>
        <h2 className="mt-1.5 text-xl font-semibold text-(--el-text)">
          {existing ? t('titleExisting') : t('titleNew')}
        </h2>

        {/* THE PLANNER'S OWN TURN. It says what was found and what happens next,
            and it is the only copy on this surface that is not Motir's. */}
        <p className="mt-2 text-sm leading-relaxed text-(--el-text-secondary)">{verdict.message}</p>

        {/* THE FOUND BLOCK — a STATEMENT of what was read, in the same voice as
            the migrate asset's provenance line. Only the existing-project route
            can have one: there is nothing to have found on the other. */}
        {existing && sources.length > 0 ? (
          <p className="mt-3.5 flex items-start gap-2.5 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y) text-xs leading-relaxed text-(--el-text-secondary)">
            <Info className="mt-px size-3.5 flex-none" aria-hidden />
            <span>{t('found', { sources: sources.join(', ') })}</span>
          </p>
        ) : null}

        {missing.length > 0 ? (
          <>
            <p className="mt-4 font-mono text-[0.65rem] font-semibold tracking-wide text-(--el-text-secondary) uppercase">
              {t('missingCap')}
            </p>
            <ul className="mt-2 flex flex-col gap-2.5">
              {missing.map((gap) => (
                <li
                  key={gap}
                  className="flex items-start gap-2.5 text-sm leading-relaxed text-(--el-text)"
                >
                  {/* A GAP, not an error. Dashed and open, because each row is a
                      thing that is not there yet. */}
                  <span
                    className="mt-0.5 size-4 flex-none rounded-(--radius-badge) border border-dashed border-(--el-border-strong)"
                    aria-hidden
                  />
                  <span>{gap}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {existing ? (
          <div className="mt-4 border-t border-(--el-border-soft) pt-3.5">
            <p className="font-mono text-[0.65rem] font-semibold tracking-wide text-(--el-text-secondary) uppercase">
              {t('keptCap')}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {kept.map((step) => (
                <span
                  key={step}
                  className="rounded-(--radius-badge) bg-(--el-accent) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-semibold text-(--el-accent-text)"
                >
                  {t(STEP_LABEL_KEY[step])}
                </span>
              ))}
            </div>
            {skipped.length > 0 ? (
              <>
                <p className="mt-3 font-mono text-[0.65rem] font-semibold tracking-wide text-(--el-text-secondary) uppercase">
                  {t('skippedCap')}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {skipped.map((step) => (
                    <span
                      key={step}
                      className="inline-flex items-center gap-1.5 rounded-(--radius-badge) border border-(--el-border) bg-(--el-tint-sky) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-semibold text-(--el-text-strong)"
                    >
                      <BookOpenText className="size-3" aria-hidden />
                      {t(STEP_LABEL_KEY[step])}
                    </span>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        <div className="mt-5 flex items-center gap-2.5">
          <button
            type="button"
            onClick={onGo}
            className="inline-flex h-(--height-btn-md) items-center rounded-(--radius-btn) bg-(--el-accent) px-(--spacing-btn-x) text-sm font-semibold text-(--el-accent-text)"
          >
            {existing ? t('goExisting') : t('goNew')}
          </button>
          {/* THE SECOND EXIT, and it is not decoration: a hand-off with one
              button is a wall with a door painted on it. */}
          <button
            type="button"
            onClick={onDismiss}
            className="inline-flex h-(--height-btn-md) items-center rounded-(--radius-btn) px-(--spacing-btn-x) text-sm font-semibold text-(--el-text)"
          >
            {t('notNow')}
          </button>
        </div>

        {/* The promise the RETURN keeps (MOTIR-4770). Worth saying only because
            that card makes it true. */}
        <p className="mt-3.5 text-xs leading-relaxed text-(--el-text-secondary)">{t('promise')}</p>
      </div>
    </div>
  );
}
