'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import {
  CircleCheck,
  CircleEllipsis,
  CirclePause,
  CircleSlash,
  CornerLeftUp,
  Undo2,
} from 'lucide-react';
import { relativeLabel } from '@/components/github/RepairFixPart';
import type { ItemGatedRunDto } from '@/lib/dto/home';
import { formatRunInstant } from '@/lib/runs/runClock';
import { runsHref } from '@/lib/runs/runsAddress';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';
import { workbenchTabHref } from '@/lib/workbench/tab';
import { FixCommand } from '@/app/(authed)/workbench/_components/WorkbenchFixLine';
import {
  GateList,
  StatePill,
  kindLabel,
  skipReasonText,
} from '@/app/(authed)/workbench/_components/WorkbenchResumeLine';
import type { WorkbenchResumeGateView } from '@/app/(authed)/workbench/_components/workbenchRows';

// THE STOPPED-AT-A-GATE MARKER on a card's run section (Story MOTIR-7701 · MOTIR-7713),
// built to `design/runs/design-notes.md` § _Stopped at a gate_ and
// `run-section--gated.mock.html` Panels G1–G6. It sits in the slot the Run died line
// takes (`run-died-line`): a run that closed `gated` maps to `succeeded`, so without
// this the section said nothing at all — it looked finished — and a waiting run is
// neither finished nor dead.
//
// ⚠️ THE GATE ROWS ARE THE TO RESUME TAB'S, NOT A SECOND DRAWING. The kind chip, the
// decider, the state pill and the door into the approval overlay are `GateList`, and
// the skip reasons are the tab's words (§ 35.6 is the shared copy) — so the two
// surfaces that describe one gated run cannot describe it differently.
//
// ⚠️ THE COMMAND IS NAMED WHILE WAITING AND COPYABLE ONLY ONCE READY. The continue
// claim refuses `gate_awaiting` (MOTIR-7708); a copy block for a command that would be
// refused is the trap § _Run died_'s own rule forbids.

type Translate = ReturnType<typeof useTranslations<'runs'>>;

const bold = (chunks: ReactNode) => <b className="font-semibold text-(--el-text)">{chunks}</b>;
const mono = (chunks: ReactNode) => (
  <b className="font-mono font-semibold whitespace-nowrap text-(--el-text)">{chunks}</b>
);

const SENT_BACK = new Set(['changes_requested', 'declined', 'overturned']);

/** Which panel the marker draws (G1–G6). */
export type GatedMarkerState = 'waiting' | 'ready' | 'resuming' | 'couldNot' | 'sentBack';

export function gatedMarkerStateOf(gated: ItemGatedRunDto): GatedMarkerState {
  if (gated.state === 'resuming') return 'resuming';
  if (gated.state === 'ready_to_resume') {
    return gated.attempt?.outcome === 'skipped' && gated.attempt.skipReason !== 'already_resumed'
      ? 'couldNot'
      : 'ready';
  }
  return gated.run.gates.some((g) => SENT_BACK.has(g.state)) ? 'sentBack' : 'waiting';
}

/** The RUN pill for the section's pill row (G1/G2): never *Run died*. Null while
 *  resuming — the section's current run is the continue, and its own pill says Running. */
export function GatedRunPill({ gated }: { gated: ItemGatedRunDto }) {
  const t = useTranslations('runs');
  const state = gatedMarkerStateOf(gated);
  if (state === 'resuming') return null;
  return state === 'ready' || state === 'couldNot' ? (
    <StatePill
      tone="ready"
      icon={<CircleCheck className="h-3 w-3" aria-hidden />}
      testId="run-gated-pill"
    >
      {t('gated.pillReady')}
    </StatePill>
  ) : (
    <StatePill
      tone="waiting"
      icon={<CirclePause className="h-3 w-3" aria-hidden />}
      testId="run-gated-pill"
    >
      {t('gated.pill')}
    </StatePill>
  );
}

/** A run-history row's pill for a run that closed `gated` (G1's history row). */
export function StoppedAtGatePill() {
  const t = useTranslations('runs');
  return (
    <StatePill tone="waiting" icon={<CirclePause className="h-3 w-3" aria-hidden />}>
      {t('gated.pill')}
    </StatePill>
  );
}

/** `the design result on ACME-13`, or `3 approvals` for several. */
function gatePhrase(
  t: Translate,
  tw: ReturnType<typeof useTranslations<'workbench'>>,
  gates: WorkbenchResumeGateView[],
): string {
  const [first] = gates;
  if (gates.length !== 1 || !first) return t('gated.waitingMany', { count: gates.length });
  return t('gated.gate', { kind: kindLabel(tw, first.kind, true), key: first.subjectKey });
}

export function GatedRunMarker({
  gated,
  itemKey,
  viewerId = null,
}: {
  gated: ItemGatedRunDto;
  /** The card the section is on — the command's key unless the run is its parent's. */
  itemKey: string;
  viewerId?: string | null;
}) {
  const t = useTranslations('runs');
  const tw = useTranslations('workbench');
  const routes = useReaderRoutes();
  const locale = useLocale();
  const [clock] = useState(() => Date.now());
  const when = (iso: string) =>
    function GatedWhen() {
      return (
        <time className="whitespace-nowrap" dateTime={iso} title={formatRunInstant(iso)}>
          {relativeLabel(iso, locale, clock)}
        </time>
      );
    };

  const nameOf = (id: string | null) => (id ? (gated.names[id] ?? null) : null);
  const gates: WorkbenchResumeGateView[] = gated.run.gates.map((g) => ({
    ...g,
    deciderName: nameOf(g.deciderId),
    decidedByName: nameOf(g.decidedById) ?? g.decidedByLabel,
  }));
  const state = gatedMarkerStateOf(gated);
  const waiting = gates.filter((g) => g.state === 'awaiting');
  const approved = gates.find((g) => g.state === 'approved') ?? null;
  const refused = gates.find((g) => SENT_BACK.has(g.state)) ?? null;
  const target = gated.parent?.key ?? itemKey;
  const command = `motir continue ${target}`;
  const approver = approved
    ? approved.decidedById !== null && approved.decidedById === viewerId
      ? tw('toResume.you')
      : (approved.decidedByName ?? t('gated.someone'))
    : t('gated.someone');
  const approvedGate = approved ? gatePhrase(t, tw, [approved]) : '';
  const link = (href: string) =>
    function GatedLink(chunks: ReactNode) {
      return (
        <Link className="font-medium text-(--el-link) hover:underline" href={href}>
          {chunks}
        </Link>
      );
    };

  let Glyph = CirclePause;
  let line: ReactNode;
  let copyable = false;
  if (gated.parent) {
    // G6 — a CHILD card: the gate is not on it, and the parent is what resumes.
    Glyph = CornerLeftUp;
    line = t.rich('gated.child', {
      parent: gated.parent.key,
      gate: gatePhrase(t, tw, waiting.length > 0 ? waiting : gates),
      b: bold,
      link: link(routes.view(`/items/${gated.parent.key}`)),
    });
  } else if (state === 'waiting') {
    const gate = gatePhrase(t, tw, waiting.length > 0 ? waiting : gates);
    line =
      gated.run.ranWhere === 'hosted'
        ? gated.run.branch
          ? t.rich('gated.waitingHosted', { gate, branch: gated.run.branch, b: bold, d: mono })
          : t.rich('gated.waitingHostedNoBranch', { gate, b: bold })
        : t.rich('gated.waitingLocal', { gate, command, b: bold, d: mono });
  } else if (state === 'ready') {
    Glyph = CircleCheck;
    copyable = true;
    line = t.rich('gated.ready', {
      approved: gates.filter((g) => g.state === 'approved').length,
      total: gates.length,
      b: bold,
    });
  } else if (state === 'resuming') {
    Glyph = CircleEllipsis;
    const runLink = link(routes.view(runsHref({ run: gated.resumedRunId ?? gated.runId })));
    line = approved
      ? t.rich('gated.resuming', { name: approver, gate: approvedGate, b: bold, link: runLink })
      : t.rich('gated.resumingBare', { link: runLink });
  } else if (state === 'couldNot') {
    Glyph = CircleSlash;
    copyable = true;
    const reason = skipReasonText(tw, gated.attempt, target);
    line = t.rich('gated.couldNot', {
      name: approver,
      gate: approvedGate,
      command,
      b: bold,
      d: mono,
      reason: () => reason,
      link: link(routes.view(workbenchTabHref('to-resume'))),
    });
  } else {
    Glyph = Undo2;
    // `sentBack` is only reached with a refused gate (`gatedMarkerStateOf`).
    const back = refused!;
    const outcome = back.state as 'changes_requested' | 'declined' | 'overturned';
    line = t.rich('gated.sentBack', {
      gate: gatePhrase(t, tw, [back]),
      outcome: t(`gated.outcome.${outcome}`),
      name: back.decidedByName ?? t('gated.someone'),
      b: bold,
    });
  }

  return (
    <div className="flex flex-col gap-2" data-testid="run-gated" data-gated-state={state}>
      <p
        className="flex items-start gap-2 font-sans text-sm text-(--el-text-secondary)"
        role="status"
        data-testid="run-gated-line"
      >
        <Glyph className="mt-0.5 size-4 shrink-0 text-(--el-icon-muted)" aria-hidden="true" />
        <span>{line}</span>
      </p>
      {copyable && !gated.parent ? (
        <div className="pl-6 text-xs">
          <FixCommand
            command={command}
            itemKey={target}
            ariaLabel={tw('toResume.copyAria', { key: target })}
          />
        </div>
      ) : null}
      {state !== 'resuming' ? (
        <GateList
          headKey={target}
          gates={gates}
          viewerId={viewerId}
          when={when}
          label={t('gated.gatesLabel')}
        />
      ) : null}
    </div>
  );
}
