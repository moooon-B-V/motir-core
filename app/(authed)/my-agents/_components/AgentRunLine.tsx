'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { RunTonePill } from '@/components/runs/RunTonePill';
import type { AgentInstanceActiveRunDto, AgentInstanceLastRunDto } from '@/lib/dto/agentInstances';
import { RUN_STATUS_TONE } from '@/lib/runs/timeline';
import { runsHref } from '@/lib/runs/runsAddress';

// THE RUN LINE (Story MOTIR-6864 · MOTIR-7029; `design/my-agents/design-notes.md`
// § _The agent's live run_, panels 1, 3 and 4). One line under the header's meta
// line, read from the RUN RECORD by agent — never from the terminal:
//
//   live   `--el-tint-sky`: the running pill **Running a work item** · the key
//          (mono, linked to the work item) · its title · **Open run**
//   ended  `--el-muted`: the end pill · **Last run** · the key · on a failure the
//          recorded reason in mono instead of the title · **Open run**
//
// It stays on the last run until the agent's next run replaces it. Narrow, the
// line wraps and **Open run** takes a line of its own (panel 4).

const LINE =
  'm-0 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-[0.8125rem] text-(--el-text-strong)';
const LINK = 'text-(--el-link) underline';

export function itemHref(key: string): string {
  return `/items/${encodeURIComponent(key)}`;
}

function KeyLink({ workItemKey }: { workItemKey: string | null }) {
  if (!workItemKey) return null;
  return (
    <Link href={itemHref(workItemKey)} className={`${LINK} font-mono font-semibold`}>
      {workItemKey}
    </Link>
  );
}

function OpenRun({ runId }: { runId: string }) {
  const t = useTranslations('myAgents.panel.run');
  return (
    <Link
      href={runsHref({ run: runId })}
      className={`${LINK} basis-full whitespace-nowrap @5xl:ml-auto @5xl:basis-auto`}
    >
      {t('open')}
    </Link>
  );
}

export function AgentRunLine({
  activeRun,
  lastRun,
}: {
  activeRun: AgentInstanceActiveRunDto | null;
  lastRun: AgentInstanceLastRunDto | null;
}) {
  const t = useTranslations('myAgents.panel.run');
  const tStatus = useTranslations('runs.runStatus');
  if (activeRun) {
    return (
      <p data-testid="agent-run-line" data-state="live" className={`${LINE} bg-(--el-tint-sky)`}>
        <RunTonePill tone="running">{t('live')}</RunTonePill>
        <KeyLink workItemKey={activeRun.workItemKey} />
        {activeRun.title ? <span className="min-w-0">{activeRun.title}</span> : null}
        <OpenRun runId={activeRun.id} />
      </p>
    );
  }
  if (!lastRun) return null;
  const reason = lastRun.status !== 'succeeded' ? lastRun.reason : null;
  return (
    <p data-testid="agent-run-line" data-state="ended" className={`${LINE} bg-(--el-muted)`}>
      <RunTonePill tone={RUN_STATUS_TONE[lastRun.status]}>{tStatus(lastRun.status)}</RunTonePill>
      <span>{t('last')}</span>
      <KeyLink workItemKey={lastRun.workItemKey} />
      {reason ? (
        <span className="min-w-0 font-mono text-xs">{reason}</span>
      ) : lastRun.title ? (
        <span className="min-w-0">{lastRun.title}</span>
      ) : null}
      <OpenRun runId={lastRun.id} />
    </p>
  );
}
