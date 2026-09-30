'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { SquareTerminal } from 'lucide-react';
import { AGENT_RUN_MACHINE_STOPPED } from '@/lib/agentInstances/runEnd';
import type {
  DispatchRunDetailDto,
  DispatchRunDto,
  DispatchRunHostedEndDto,
  DispatchRunStatus,
} from '@/lib/dto/dispatchRuns';
import { machineTimeParts, type HostedEndKind } from '@/lib/runs/hostedRun';
import { hostedPullRequests, hostedReasonLine } from './HostedRunParts';

// A RUN IN AN AGENT's parts, as the item page's Run section and the run modal
// both draw them (Story MOTIR-6864 · MOTIR-7028; `design/runs/design-notes.md`
// § Run in my agent panels 7–12, § Revision 2).
//
// ⚠️ WHO WORKED IT, NEVER WHERE. The chip names the agent and its coding agent;
// the run has no model to show (`agent-instance-run.md` §5: `model = null`), and
// "hosted" is not a word here.
//
// ⚠️ THE COST IS ONE FIGURE — MACHINE TIME, the run's own duration. No tokens and
// no credits: no gateway key is minted and no usage row written (§5); the credits
// land on the agent's own interval, which My agents shows.

/** Where the run's agent opens — its panel on My agents. */
export const agentPanelHref = (id: string): string => `/my-agents?agent=${encodeURIComponent(id)}`;

/** The run's agent in words — its name and its coding agent — or null when gone. */
export function agentOf(run: Pick<DispatchRunDto, 'agentInstance'>): {
  id: string;
  name: string;
  profileLabel: string;
} | null {
  const a = run.agentInstance;
  return a ? { id: a.id, name: a.name, profileLabel: a.profileLabel } : null;
}

/** The chip that says who works it: *yue-claude · Claude Code*. */
export function AgentLaneChip({ run }: { run: Pick<DispatchRunDto, 'agentInstance'> }) {
  const t = useTranslations('runs.agent');
  const agent = agentOf(run);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-(--radius-badge) bg-(--el-chip-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs font-medium text-(--el-text-strong)"
      data-testid="agent-lane"
    >
      <SquareTerminal className="size-3.5" aria-hidden="true" />
      {agent ? t('lane', { name: agent.name, agent: agent.profileLabel }) : t('laneGone')}
    </span>
  );
}

/**
 * The END line's kind for a run in an agent (design panel 9). A failure the CLI
 * closed itself carries no recorded outcome and reads *exited without a pull
 * request*; one the end path closed after the run started reads *the machine
 * stopped*; every other failure it closed met the run before it started.
 */
export type AgentEndKind = HostedEndKind | 'notStarted';

export function agentEndKind(
  status: DispatchRunStatus,
  end: DispatchRunHostedEndDto | undefined,
): AgentEndKind | null {
  if (status === 'running') return null;
  if (status === 'succeeded') return 'succeeded';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'timed_out') return end?.outcome === 'stall' ? 'stalled' : 'timedOut';
  if (!end?.outcome) return 'failed';
  return end.detail !== null && AGENT_RUN_MACHINE_STOPPED.has(end.detail)
    ? 'crashed'
    : 'notStarted';
}

/** The end line's words — the shipped `runs.hosted.end.*`, plus *couldn't start*. */
function useEndLine(): (kind: AgentEndKind) => string {
  const tHosted = useTranslations('runs.hosted');
  const t = useTranslations('runs.agent');
  return (kind) => (kind === 'notStarted' ? t('end.notStarted') : tHosted(`end.${kind}`));
}

/**
 * THE END under the pill (design panels 8, 9): a success leads with the pull
 * request it opened; every other end says what happened, quotes the RECORDED
 * reason verbatim, and says the work item stays where it was.
 */
export function AgentEndBlock({ detail }: { detail: DispatchRunDetailDto }) {
  const tHosted = useTranslations('runs.hosted');
  const endLine = useEndLine();
  const kind = agentEndKind(detail.status, detail.hostedEnd);
  if (!kind) return null;
  const prs = hostedPullRequests(detail);
  const reason = hostedReasonLine(detail, tHosted);
  return (
    <div className="flex flex-col gap-1.5" data-testid="agent-end" data-end={kind}>
      {prs.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {prs.map((pr) => (
            <li
              key={pr.url}
              className="rounded-(--radius-control) bg-(--el-tint-mint) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-sm text-(--el-text-strong)"
            >
              {tHosted('prHeadline')}{' '}
              <a
                className="font-mono font-semibold text-(--el-link) underline"
                href={pr.url}
                target="_blank"
                rel="noreferrer"
              >
                {`${pr.repo} #${pr.number}`}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="font-sans text-sm text-(--el-text)">{endLine(kind)}</p>
      {reason ? (
        <p className="font-mono text-xs text-(--el-text-secondary)" data-testid="agent-reason">
          {reason}
        </p>
      ) : null}
      {kind !== 'succeeded' ? (
        <p className="font-sans text-sm text-(--el-text-secondary)">{tHosted('end.stays')}</p>
      ) : null}
    </div>
  );
}

/** The end as ONE strip under the modal's header (design panel 12). */
export function AgentEndStrip({ run }: { run: DispatchRunDetailDto }) {
  const tHosted = useTranslations('runs.hosted');
  const endLine = useEndLine();
  const kind = agentEndKind(run.status, run.hostedEnd);
  if (!kind) return null;
  const reason = hostedReasonLine(run, tHosted);
  const prs = hostedPullRequests(run);
  return (
    <p
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-(--el-border-soft) px-(--spacing-card-padding) py-1.5 font-sans text-xs text-(--el-text)"
      data-testid="agent-end-strip"
      data-end={kind}
    >
      {prs.map((pr) => (
        <span key={pr.url}>
          {tHosted('prHeadline')}{' '}
          <a
            className="font-mono text-(--el-link) underline"
            href={pr.url}
            target="_blank"
            rel="noreferrer"
          >
            {`${pr.repo} #${pr.number}`}
          </a>
          {' ·'}
        </span>
      ))}
      <span>{endLine(kind)}</span>
      {reason ? <span className="font-mono text-(--el-text-secondary)">{reason}</span> : null}
    </p>
  );
}

/** The run's running time in seconds — ticking while live, CLIENT-ONLY (a clock
 *  read during render would make the server and the first client paint disagree). */
function useRunSeconds(run: Pick<DispatchRunDto, 'startedAt' | 'endedAt'>, live: boolean) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!live) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 1_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [live]);
  const start = new Date(run.startedAt).getTime();
  if (!live) {
    return run.endedAt ? (new Date(run.endedAt).getTime() - start) / 1000 : null;
  }
  return now === null ? null : (now - start) / 1000;
}

/**
 * THE COST — machine time only (design panels 7, 8 and 12). `block` is the run
 * section's figure with its head; `strip` is the run modal's line under its header.
 */
export function AgentRunCost({
  run,
  live,
  variant,
}: {
  run: Pick<DispatchRunDto, 'startedAt' | 'endedAt' | 'agentInstance'>;
  live: boolean;
  variant: 'block' | 'strip';
}) {
  const tCost = useTranslations('runs.hosted.cost');
  const t = useTranslations('runs.agent.cost');
  const tAgent = useTranslations('runs.agent');
  const seconds = useRunSeconds(run, live);
  const agent = agentOf(run);
  const names = {
    name: agent?.name ?? tAgent('laneGone'),
    agent: agent?.profileLabel ?? '',
  };
  const duration =
    seconds === null
      ? '—'
      : machineTimeParts(seconds)
          .map((p) => tCost(`unit.${p.unit}`, { n: p.n }))
          .join(' ');

  if (variant === 'strip') {
    return (
      <section
        aria-label={tCost('head')}
        data-testid="agent-run-cost"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-(--el-border-soft) px-(--spacing-card-padding) py-2 font-sans text-xs text-(--el-text-secondary)"
      >
        <span className="flex items-center gap-2 font-semibold text-(--el-text)">
          {live ? tCost('stripLive') : tCost('head')}
          {live ? (
            <span className="font-normal text-(--el-text-secondary)">{tCost('stripUpdating')}</span>
          ) : null}
        </span>
        <span>
          {tCost('machine')} <span className="text-(--el-text)">{duration}</span>
          {' · '}
          {t('stripMachine', names)}
        </span>
        <span>{t('stripNoTokens', names)}</span>
      </section>
    );
  }
  return (
    <section
      aria-label={tCost('head')}
      data-testid="agent-run-cost"
      className="flex flex-col gap-2"
    >
      <div className="flex items-center gap-2">
        <h3 className="font-sans text-sm font-semibold text-(--el-text)">{tCost('head')}</h3>
        {live ? (
          <>
            <span
              className="size-2 shrink-0 rounded-full bg-(--el-status-in-progress)"
              aria-hidden="true"
            />
            <span className="font-sans text-xs text-(--el-text-secondary)">
              {tCost('liveHint')}
            </span>
          </>
        ) : null}
      </div>
      <dl className="grid max-w-[24rem] grid-cols-1">
        <div className="flex flex-col gap-0.5 rounded-(--radius-control) border border-(--el-border-soft) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-sm">
          <dt className="text-xs text-(--el-text-secondary)">{tCost('machine')}</dt>
          <dd className="flex flex-col gap-0.5">
            <span className="text-(--el-text)" data-testid="agent-machine-time">
              {duration}
            </span>
            <span className="text-xs text-(--el-text-secondary)">{t('machineDetail', names)}</span>
          </dd>
        </div>
      </dl>
    </section>
  );
}

/** *Your agent is working on it* — the chip, the sentence, and the link to the agent. */
export function AgentWhere({
  run,
  live,
  children,
}: {
  run: Pick<DispatchRunDto, 'agentInstance'>;
  live: boolean;
  children?: ReactNode;
}) {
  const t = useTranslations('runs.agent.where');
  const agent = agentOf(run);
  return (
    <p className="flex flex-wrap items-center gap-1.5 font-sans text-sm text-(--el-text)">
      <AgentLaneChip run={run} />
      <span>{live ? t('live') : t('ended')}</span>
      {agent ? (
        <Link
          className="text-(--el-link) underline"
          href={agentPanelHref(agent.id)}
          data-testid="agent-link"
        >
          {live ? t('watch') : t('open', { name: agent.name })}
        </Link>
      ) : null}
      {children}
    </p>
  );
}
