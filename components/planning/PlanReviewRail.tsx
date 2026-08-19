'use client';

import Link from 'next/link';
import { AlertTriangle, Bot, Check, RotateCw, Sparkles, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import type { PlanHistoryEventDto, PlanReviewDto } from '@/lib/dto/planReview';
import type { PlanStatusDto, StaleReason } from '@/lib/dto/plans';

// The REVIEW RAIL of the plan detail (Subtask 7.4.5 / MOTIR-847) — the chat-side
// pane of the composed canvas+chat shell. It carries the Plans-substrate chrome
// the ai-planning design §3 Panel B adds: the plan status, a history timeline,
// the per-plan staleness summary, and the Approve(materialize) / Decline gate. A
// DECIDED plan (approved/declined) is read-only — its outcome + history stay
// shown. Presentational: the parent island owns the polling + the approve/decline
// actions + the stale-warning confirm; this renders state and fires handlers.

const STATUS_TINT: Record<PlanStatusDto, string> = {
  generating: 'bg-(--el-tint-sky) text-(--el-text-strong)',
  planned: 'bg-(--el-tint-lavender) text-(--el-text-strong)',
  approved: 'bg-(--el-tint-mint) text-(--el-text-strong)',
  declined: 'bg-(--el-muted) text-(--el-text-secondary)',
};

function formatAt(iso: string | null): string {
  if (!iso) return '—';
  // Fixed UTC formatting so the server + client renders match (finding #89).
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(iso));
}

function staleReasonLabel(r: StaleReason, t: ReturnType<typeof useTranslations>): string {
  switch (r.code) {
    case 'parent_removed':
      return t('staleParentRemoved');
    case 'siblings_added':
      return t('staleSiblingsAdded');
    case 'blocker_removed':
      return t('staleBlockerRemoved');
    case 'base_revision_drift':
      return t(`staleDrift_${r.change}`);
  }
}

/**
 * The one PLAIN LINE the approved outcome gains about the project's code (Story
 * MOTIR-1775 · MOTIR-1782) — `ready` when every row of the repository set has
 * settled, `unfinished` while any is still unresolved, null when the project has
 * no set at all.
 *
 * ⚠️ A LINE, never a count and never a repository name. The rail is the surface a
 * non-technical user reads to confirm their plan is safe; putting "2 of 3
 * repositories created" here would smuggle the whole technical vocabulary onto
 * the default path through the back door.
 */
/**
 * What the approved outcome says about the project's CODE.
 *
 *   * `ready`        — every row of the set settled AND the user can reach the
 *     repositories Motir made them.
 *   * `needs_access` — the repositories exist but nobody has been invited to
 *     them yet (MOTIR-1900). Distinct from `unfinished` because the user's next
 *     step is different: nothing is left to SET UP, only to get INTO.
 *   * `unfinished`   — a row is still proposed, creating or failed.
 */
export type PlanCodeOutcome = 'ready' | 'needs_access' | 'unfinished';

export interface PlanReviewRailProps {
  review: PlanReviewDto;
  onApprove: () => void;
  onDecline: () => void;
  busy: boolean;
  errorCode: string | null;
  codeOutcome?: PlanCodeOutcome | null;
}

export function PlanReviewRail({
  review,
  onApprove,
  onDecline,
  busy,
  errorCode,
  codeOutcome,
}: PlanReviewRailProps) {
  const t = useTranslations('planReview');
  const decided = review.status === 'approved' || review.status === 'declined';
  const planned = review.status === 'planned';
  const staleItems = review.items.filter((i) => i.stale);

  return (
    <aside
      aria-label={t('reviewRailAria')}
      className="flex h-full min-h-0 min-w-0 flex-col gap-4 overflow-y-auto border-l border-(--el-border) bg-(--el-surface) p-5"
    >
      <header className="flex min-w-0 flex-col gap-2">
        {/* The status is an OVERLINE on its own line ABOVE the title (MOTIR-3074),
            not a `shrink-0` pill beside it. Plan titles are GENERATED — long by
            default, and routinely carrying an unbreakable token (a SCREAMING_CASE
            constant, a repo name, a cuid) — so on a shared flex row the title wrapped
            to five lines while `items-center` held the one-line pill against the
            middle of the block, and the tag read as an annotation on line 3 of the
            sentence rather than as the plan's state. On its own line the title owns
            the full rail width, a five-line title reads exactly like a one-line one,
            and the state stays the FIRST thing read on the rail — which is what this
            pill is for ("did my plan go through?"). `self-start` keeps it at its own
            width: a flex COLUMN child would otherwise stretch to the full rail. */}
        <span
          data-testid="plan-status-pill"
          className={`inline-flex max-w-full items-center self-start rounded-(--radius-badge) px-2 py-0.5 text-xs font-semibold ${STATUS_TINT[review.status]}`}
        >
          {t(`status_${review.status}`)}
        </span>
        {/* The overflow guard, owed WHEREVER the pill sits. A flex/grid item's automatic
            minimum size is its longest unbreakable word, and the rail is a fixed `22rem`
            track, so a title carrying a cuid or a SCREAMING_CASE constant pushed the
            `<aside>` past it. Measured in chromium at the shipped 352px rail width, on the
            reported title: shipped shape overflowed the rail by 7px; `wrap-anywhere` alone
            cleared it, `break-words` alone did NOT (still 7px) — only `overflow-wrap:
            anywhere` feeds its break opportunities into the MIN-CONTENT size the track is
            measured from, which is the whole reason this class of bug keeps recurring here.
            `min-w-0` floors the item independently. The overline placement makes neither
            redundant: a token wider than the FULL column still overflows without them
            (324px on a 60-character token, 0px with them). */}
        <h2 className="min-w-0 font-serif text-lg font-semibold wrap-anywhere text-(--el-text)">
          {review.title ?? t('untitledPlan')}
        </h2>
        {review.summary ? (
          <p className="text-sm text-(--el-text-secondary)">{review.summary}</p>
        ) : null}
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-(--el-text-secondary)">
          <span>{t('itemCount', { n: review.itemCount })}</span>
          <ReviewAttribution review={review} t={t} />
        </p>
      </header>

      {/* HISTORY timeline */}
      <section className="flex flex-col gap-2">
        <h3 className="text-[11px] font-bold tracking-[0.05em] text-(--el-text-secondary) uppercase">
          {t('history')}
        </h3>
        <ol className="flex flex-col gap-2">
          {review.history.map((ev) => (
            <HistoryRow key={ev.kind} ev={ev} t={t} />
          ))}
          {!decided ? (
            <li className="flex items-center gap-2 text-sm text-(--el-text-secondary)">
              <span
                className="size-1.5 shrink-0 rounded-full bg-(--el-border-strong)"
                aria-hidden
              />
              {t('awaitingReview')}
            </li>
          ) : null}
        </ol>
      </section>

      {/* STALENESS summary */}
      {review.stale ? (
        <section
          data-testid="stale-summary"
          className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border) bg-(--el-tint-yellow)/40 p-3"
        >
          <p className="flex items-center gap-1.5 text-sm font-semibold text-(--el-text-strong)">
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
            {t('staleSummary', { n: review.staleCount })}
          </p>
          <ul className="flex flex-col gap-1">
            {staleItems.map((item) => (
              <li key={item.planItemId} className="text-xs text-(--el-text-secondary)">
                <span className="font-medium text-(--el-text)">{item.title}</span>
                {' — '}
                {item.staleReasons.map((r) => staleReasonLabel(r, t)).join(', ')}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* The decision GATE (or the decided outcome). */}
      <div className="mt-auto flex flex-col gap-2">
        {errorCode ? (
          <p role="alert" className="text-xs font-medium text-(--el-danger-text)">
            {t('actionError')}
          </p>
        ) : null}
        {decided ? (
          <DecidedOutcome review={review} t={t} codeOutcome={codeOutcome ?? null} />
        ) : (
          <>
            <Button
              variant="primary"
              onClick={onApprove}
              disabled={!planned || busy}
              loading={busy}
              leftIcon={<Check className="size-4" aria-hidden="true" />}
            >
              {t('approveCta', { n: review.itemCount })}
            </Button>
            <Button
              variant="ghost"
              onClick={onDecline}
              disabled={!planned || busy}
              leftIcon={<X className="size-4" aria-hidden="true" />}
            >
              {t('declineCta')}
            </Button>
            <p className="text-center text-xs text-(--el-text-secondary)">
              {planned
                ? review.stale
                  ? t('approveHintStale', { n: review.staleCount })
                  : t('approveHint')
                : t('reviewLocked')}
            </p>
          </>
        )}
      </div>
    </aside>
  );
}

/**
 * WHO ASKED for this plan and WHO WROTE it (MOTIR-2991,
 * `design/ai-planning/design-notes.md` Part III §6).
 *
 * Two differences from the LIST row, both deliberate:
 *
 *  1. The ROLES ARE NAMED IN WORDS — `Requested by X · written by Y`. The row is
 *     scanned, and an avatar in front of a name already reads as *this person's*;
 *     this header is read ONCE, by the person about to press Approve, and there
 *     the words are what stop two names being taken for one party.
 *  2. It KEEPS the requester on a DECIDED plan, which the row drops. The row's
 *     reason does not apply here: the decider is not in this line at all — it is
 *     in the history timeline below — so no two bare names compete.
 *
 * It also carries the MODEL, which the row omits: it is the difference between
 * two agent-written plans, and nobody scans a list on it.
 *
 * The glyphs are DECORATIVE (`aria-hidden`, `--el-text-faint`) — the words carry
 * the meaning, so neither party is conveyed by icon or colour alone.
 */
function ReviewAttribution({
  review,
  t,
}: {
  review: PlanReviewDto;
  t: ReturnType<typeof useTranslations>;
}) {
  // WHO WROTE it, read off `authorSource` ALONE (MOTIR-2996) — `mcp` + a harness
  // is an agent, `native` is Motir. The header used to infer the Motir case from
  // `sourceJobId != null`, which answered WHICH JOB and stood in for WHO only
  // while a motir-ai job was the sole non-MCP writer of a `Plan`.
  const agent =
    review.authorSource === 'mcp' && review.authorHarness
      ? { Icon: Bot, label: t('writtenByHarness', { harness: review.authorHarness }) }
      : review.authorSource === 'native'
        ? { Icon: Sparkles, label: t('writtenByMotir') }
        : null;
  const cadence = review.origin === 'cadence';
  const requester = review.createdByName;
  if (!agent && !requester && !cadence) return null;

  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
      {requester ? (
        <>
          <span
            className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-(--el-text) text-[9px] font-semibold text-(--el-text-inverted)"
            aria-hidden
          >
            {requester.charAt(0).toUpperCase()}
          </span>
          <span className="min-w-0 truncate" title={requester}>
            {t('requestedBy', { name: requester })}
          </span>
        </>
      ) : cadence ? (
        <>
          <RotateCw className="h-3 w-3 shrink-0 text-(--el-text-faint)" aria-hidden />
          {t('autoPlannedNobodyAsked')}
        </>
      ) : null}
      {(requester || cadence) && agent ? (
        <span className="text-(--el-text-faint)" aria-hidden>
          ·
        </span>
      ) : null}
      {agent ? (
        <>
          <agent.Icon className="h-3 w-3 shrink-0 text-(--el-text-faint)" aria-hidden />
          <span className="min-w-0 truncate" title={review.authorHarness ?? undefined}>
            {agent.label}
          </span>
          {review.authorModel ? (
            <>
              <span className="text-(--el-text-faint)" aria-hidden>
                ·
              </span>
              <span className="min-w-0 truncate text-(--el-text-muted)">{review.authorModel}</span>
            </>
          ) : null}
        </>
      ) : null}
    </span>
  );
}

function HistoryRow({ ev, t }: { ev: PlanHistoryEventDto; t: ReturnType<typeof useTranslations> }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-(--el-accent)" aria-hidden="true" />
      <div className="flex min-w-0 flex-col">
        <span className="text-(--el-text)">
          {t(`event_${ev.kind}`)}
          {ev.byName ? <span className="text-(--el-text-muted)"> · {ev.byName}</span> : null}
        </span>
        <span className="text-xs text-(--el-text-secondary)">{formatAt(ev.at)}</span>
      </div>
    </li>
  );
}

function DecidedOutcome({
  review,
  t,
  codeOutcome,
}: {
  review: PlanReviewDto;
  t: ReturnType<typeof useTranslations>;
  codeOutcome: PlanCodeOutcome | null;
}) {
  const tRepo = useTranslations('repositorySet');
  const approved = review.status === 'approved';
  return (
    <div className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) p-3">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-(--el-text)">
        {approved ? (
          <Sparkles className="size-4 shrink-0 text-(--el-success)" aria-hidden="true" />
        ) : (
          <X className="size-4 shrink-0 text-(--el-text-muted)" aria-hidden="true" />
        )}
        {approved ? t('approvedOutcome', { n: review.itemCount }) : t('declinedOutcome')}
      </p>
      {approved && codeOutcome ? (
        <p
          data-testid="plan-code-outcome"
          className="flex items-center gap-1.5 text-sm text-(--el-text-secondary)"
        >
          {codeOutcome === 'ready' ? (
            <Check className="size-4 shrink-0 text-(--el-success)" aria-hidden="true" />
          ) : (
            <AlertTriangle className="size-4 shrink-0 text-(--el-warning)" aria-hidden="true" />
          )}
          {codeOutcome === 'ready'
            ? tRepo('outcomeReady')
            : codeOutcome === 'needs_access'
              ? tRepo('outcomeNeedsAccess')
              : tRepo('finishSetupLink')}
        </p>
      ) : null}
      {approved ? (
        <Link
          href="/items"
          className="text-xs font-medium text-(--el-link) hover:text-(--el-link-pressed)"
        >
          {t('viewInBacklog')}
        </Link>
      ) : null}
    </div>
  );
}
