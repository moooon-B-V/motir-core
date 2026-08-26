'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock,
  Loader2,
  OctagonAlert,
  RotateCw,
  Sparkles,
  XCircle,
} from 'lucide-react';

import { Pill } from '@/components/ui/Pill';
import { cn } from '@/lib/utils/cn';
import type { PlanStatusDto } from '@/lib/dto/plans';

import type { PlanRowView } from './types';

// One Plans-list row (Subtask 7.21.1 / MOTIR-1338), built to the 843 design
// (`design/ai-planning/plans-surface.mock.html`, Panel A). Pure presentational —
// it binds the server-built `PlanRowView` (no service access, no relative-time
// derivation). The whole row is a single `<Link>` into the plan detail
// (MOTIR-847) — the access path. Status + staleness are conveyed by TEXT in the
// pills, not colour alone (the a11y rule); every colour routes through `--el-*`.

const STATUS_ICON: Record<PlanStatusDto, typeof Clock> = {
  generating: Loader2,
  planned: Clock,
  // ⚠️ An OCTAGON, and it was chosen against the four glyphs already on this
  // surface rather than in the abstract (`design/ai-planning/design-notes.md`
  // Part XI §2, drawn against a headless render of this very component). A stop
  // sign reads *cannot proceed*; `CircleSlash` and `Ban` read *forbidden* and
  // are indistinguishable from each other at 16px; `ShieldAlert` reads
  // *security*. It also stays separable from the ADVISORY `AlertTriangle`
  // below — triangle vs octagon — which matters because a row can carry both.
  stale: OctagonAlert,
  approved: CheckCircle2,
  declined: XCircle,
};

// The status hue lives in the icon-square TINT (charcoal/strong ink on top stays
// AA — finding #35); the declined square is a quiet muted fill, not a tint,
// matching the design's inactive-outcome treatment.
const STATUS_TINT: Record<PlanStatusDto, string> = {
  generating: 'bg-(--el-tint-sky)',
  planned: 'bg-(--el-tint-lavender)',
  // Rose is the one tint no status spends — sky, lavender and mint are taken and
  // `declined` uses `--el-muted` — so the fifth square is distinguishable from
  // all four without inventing a colour (Part XI §2).
  stale: 'bg-(--el-tint-rose)',
  approved: 'bg-(--el-tint-mint)',
  declined: 'bg-(--el-muted)',
};

/**
 * The plan's ATTRIBUTION — who asked for it and who wrote it (MOTIR-2991,
 * `design/ai-planning/design-notes.md` Part III).
 *
 * One entry in the row's existing meta line, never a pill: a second chip beside
 * the status pill reads as part of the status. Both halves are optional and the
 * entry renders NOTHING when neither is known — the *unattributed* state is an
 * absence, not a placeholder, because a placeholder in a scanned list is a value
 * the reader has to learn to ignore.
 *
 * ⚠️ A DECIDED row NAMES BOTH PEOPLE — and this REVERSES Part III §3, which this
 * comment used to state as *"a decided row shows the DECIDER, not the
 * requester"*. That rule named a real hazard: two bare person names in one
 * scanned line, with nothing saying which holds which role. Its PREMISE is what
 * failed — the two do not have to share an entry, and half of the collision it
 * guarded against did not exist, because the decider was drawn in panel A since
 * 843 and NEVER SHIPPED. So the row named nobody at all.
 *
 * Part VII puts them in DIFFERENT entries, and the entry is what says the role:
 * the DECIDER rides the WHEN entry behind its verb (`approved yesterday by
 * Mara`, {@link WhenEntry}), the REQUESTER rides this attribution entry behind
 * its avatar, unchanged. Part III's three-entry cap survives — the requester
 * goes back INSIDE entry 3 and adds no fourth entry.
 *
 * The glyphs are DECORATIVE (`aria-hidden`, `--el-text-faint`): the words carry
 * the meaning, so neither party is ever conveyed by icon or colour alone.
 */
function PlanAttribution({ view }: { view: PlanRowView }) {
  const t = useTranslations('aiPlanning');

  // WHO WROTE it, read off `authorSource` ALONE (MOTIR-2996): `mcp` + a harness
  // is an agent, `native` is Motir. The row used to infer the Motir case from
  // `sourceJobId != null` because the generator recorded no author; it records
  // `native · Motir` now, so the fact has one source instead of two.
  const agent =
    view.authorSource === 'mcp' && view.authorHarness
      ? { Icon: Bot, label: t('viaHarness', { harness: view.authorHarness }), truncates: true }
      : view.authorSource === 'native'
        ? { Icon: Sparkles, label: t('viaMotir'), truncates: false }
        : null;

  // WHO ASKED — rendered in EVERY state now (MOTIR-3238), and replaced by the
  // cadence marker when nobody asked at all. The `decided ? null :` suppression
  // that stood here is the Part III §3 rule Part VII reverses; see the doc above.
  const requester =
    view.origin === 'cadence'
      ? { kind: 'cadence' as const }
      : view.createdByName
        ? { kind: 'person' as const, name: view.createdByName }
        : null;

  if (!requester && !agent) return null;

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {requester?.kind === 'person' ? (
        <>
          <span
            className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-(--el-text) text-[9px] font-semibold text-(--el-text-inverted)"
            aria-hidden
          >
            {requester.name.charAt(0).toUpperCase()}
          </span>
          <b className="max-w-[10rem] truncate font-semibold" title={requester.name}>
            {requester.name}
          </b>
        </>
      ) : null}
      {requester?.kind === 'cadence' ? (
        <>
          <RotateCw className="h-3 w-3 shrink-0 text-(--el-text-faint)" aria-hidden />
          {t('autoPlanned')}
        </>
      ) : null}
      {requester && agent ? (
        <span className="text-(--el-text-faint)" aria-hidden>
          ·
        </span>
      ) : null}
      {agent ? (
        <>
          <agent.Icon className="h-3 w-3 shrink-0 text-(--el-text-faint)" aria-hidden />
          <span
            className={cn('min-w-0', agent.truncates && 'max-w-[12rem] truncate')}
            title={agent.truncates ? (view.authorHarness ?? undefined) : undefined}
          >
            {agent.label}
          </span>
        </>
      ) : null}
    </span>
  );
}

/**
 * WHEN the plan reached its current state — and, on a decided plan, WHO decided
 * it (MOTIR-3238, `design/ai-planning/design-notes.md` Part VII §3).
 *
 * The decider rides THIS entry rather than the attribution one, behind the verb
 * that already labels the timestamp: `approved yesterday by Mara`. That is where
 * panel A has drawn it since 843, and it is what makes the two people on a
 * decided row unambiguous without new chrome — one name is preceded by
 * *approved … by*, the other by a face.
 *
 * ⚠️ THE DECIDER IS OPTIONAL, AND ITS ABSENCE IS A WHOLE SENTENCE. A plan the
 * abandoned-plan sweep terminated is `declined` with a NULL `decidedById`,
 * because nobody decided it (MOTIR-3189) — so the row falls back to the plain
 * `approved {when}` / `declined {when}` string rather than rendering a
 * name-shaped hole. That is Part III §3's *absence, never a placeholder* rule,
 * one axis over: no em-dash, no `Unknown`, no greyed placeholder.
 *
 * The two keys are named literally rather than derived from `whenKey` so both
 * are greppable in the catalogues and the zh-parity gate can see them.
 */
function WhenEntry({ view }: { view: PlanRowView }) {
  const t = useTranslations('aiPlanning');
  if (view.decidedByName) {
    if (view.whenKey === 'approvedAt') {
      return <span>{t('approvedByName', { when: view.whenLabel, name: view.decidedByName })}</span>;
    }
    if (view.whenKey === 'declinedAt') {
      return <span>{t('declinedByName', { when: view.whenLabel, name: view.decidedByName })}</span>;
    }
  }
  return <span>{t(view.whenKey, { when: view.whenLabel })}</span>;
}

/** The status pill, mapped to the shipped `Pill` tones the design specifies:
 *  generating→info(sky), planned→lavender, stale→danger(rose),
 *  approved→success(mint), declined→archived(quiet muted).
 *
 *  ⚠️ EVERY STATUS IS NAMED, AND `declined` NOW HAS ITS OWN ARM (MOTIR-3578).
 *  The final `return` used to be an UNGUARDED fallthrough carrying a
 *  `// declined` comment — so a fifth status rendered as Declined's chip: the
 *  quiet, nearly fill-less *ended* treatment, which is the one reading `stale`
 *  must never have, since the plan is live and awaiting action. It compiled
 *  clean and was invisible in a diff, which is why Part XI §7 lists it first
 *  among the sites the compiler cannot find. */
function StatusPill({ status, label }: { status: PlanStatusDto; label: string }) {
  if (status === 'generating') return <Pill severity="info">{label}</Pill>;
  if (status === 'planned') return <Pill status="planned">{label}</Pill>;
  if (status === 'stale') return <Pill severity="danger">{label}</Pill>;
  if (status === 'declined') return <Pill tone="archived">{label}</Pill>;
  return <Pill severity="success">{label}</Pill>; // approved
}

export function PlanRow({ view }: { view: PlanRowView }) {
  const t = useTranslations('aiPlanning');
  const Icon = STATUS_ICON[view.status];
  const title = view.title || t('untitledPlan');
  // A `planned` plan is the one awaiting the user's review — the design gives it
  // an accent border so it stands out from decided/generating rows.
  //
  // ⚠️ DELIBERATELY NOT WIDENED TO `stale` (Part XI §2, and §7 lists it as the
  // one of the four silent sites that must NOT change by symmetry). The accent
  // means *awaiting your approval*; a `stale` plan cannot be approved, so the
  // same border would invite a click that fails. The rose square and the danger
  // pill carry *this one needs you* without promising the button works.
  const awaitingReview = view.status === 'planned';

  return (
    <Link
      href={`/plans/${view.id}`}
      className={cn(
        'flex items-center gap-3 rounded-(--radius-card) border bg-(--el-surface)',
        'px-(--spacing-control-x) py-(--spacing-control-y) shadow-(--shadow-subtle)',
        'transition-colors hover:border-(--el-border-strong)',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)',
        awaitingReview ? 'border-(--el-accent)' : 'border-(--el-border)',
      )}
    >
      <span
        className={cn(
          'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-(--radius-control)',
          STATUS_TINT[view.status],
        )}
        aria-hidden
      >
        <Icon
          className={cn(
            'h-4 w-4 text-(--el-text-strong)',
            view.status === 'generating' && 'animate-spin',
          )}
        />
      </span>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-(--el-text)">{title}</div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-(--el-text-secondary)">
          <span>{t('itemCount', { count: view.itemCount })}</span>
          <WhenEntry view={view} />
          <PlanAttribution view={view} />
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {view.staleCount > 0 ? (
          <Pill severity="warning">
            <AlertTriangle className="h-3 w-3" aria-hidden />
            {t('mayBeOutOfDate', { count: view.staleCount })}
          </Pill>
        ) : null}
        <StatusPill status={view.status} label={t(`status.${view.status}`)} />
      </div>
    </Link>
  );
}
