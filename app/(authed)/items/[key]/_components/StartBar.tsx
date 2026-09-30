'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Cloud, SquareTerminal } from 'lucide-react';
import { useAgentRefusal } from '@/app/(authed)/my-agents/_components/agentRefusal';
import { INSTANCE_MAX_PER_USER } from '@/lib/agentInstances/config';
import { runsHref } from '@/lib/runs/runsAddress';
import { isLiveRun } from '@/lib/runs/timeline';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';
import { HostedDoorNotices, Notice, RefusalNotice } from './HostedDoorNotices';
import { useHostedRun } from './HostedRunProvider';
import { RunDoorControl } from './RunHostedButton';
import { agentPanelHref } from '@/app/(authed)/runs/_components/AgentRunParts';
import { SendToAgentDoor, SignInCommand } from './SendToAgentDoor';
import type { AgentSendRefusal } from './useAgentSend';

// THE START BAR — the two ways to start a work item, at the top of the Run
// section's body (Story MOTIR-6864 · MOTIR-7028; `design/runs/design-notes.md`
// § Revision 2, panels 0 and 4).
//
// Two named choices, side by side, each saying in one line WHO does the work:
// **Run** (Motir, with the model you pick) and **Send to my agent** (one of your
// own agents). "Hosted" is not a word on this surface — both run in Motir's
// cloud, so it told them apart by nothing a person cares about.
//
// ⚠️ ONE LIVE RUN AT A TIME. While a run of ANY lane is live on the work item the
// bar is not drawn at all — the header holds Cancel run — so neither option can
// start a second one. And while one option's press is in flight, the other is
// disabled.

export function StartBar() {
  const t = useTranslations('runs.start');
  const door = useHostedRun();
  if (!door) return null;
  if (door.currentRun && isLiveRun(door.currentRun.status)) return null;
  // A died card is continued, not re-run (design § Continue hosted, C7).
  if (door.runDoorHidden) return null;
  const both = door.agentDoor !== null;

  return (
    <div className="flex flex-col gap-2" data-testid="start-bar">
      <p className="font-sans text-xs font-semibold text-(--el-text-secondary)">{t('caption')}</p>
      <div
        role="group"
        aria-label={t('caption')}
        className={`grid grid-cols-1 gap-3 ${both ? 'md:grid-cols-2' : ''}`}
      >
        <StartOption icon={<Cloud />} title={t('run.title')} lead={t('run.lead')}>
          <RunDoorControl />
        </StartOption>
        {both ? (
          <StartOption
            icon={<SquareTerminal />}
            title={t('send.title')}
            lead={t('send.lead')}
            testId="start-send"
          >
            <SendToAgentDoor />
          </StartOption>
        ) : null}
      </div>
      <HostedDoorNotices />
      {door.agentDoor?.refusal ? (
        <AgentSendNotice
          refusal={door.agentDoor.refusal}
          projectName={door.agentDoor.projectName}
          openBlockers={door.openBlockers}
        />
      ) : null}
    </div>
  );
}

/** One option — a quiet panel: its title, who works it, and its control. */
function StartOption({
  icon,
  title,
  lead,
  testId,
  children,
}: {
  icon: ReactNode;
  title: string;
  lead: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div
      className="flex min-w-0 flex-col gap-2 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) p-(--spacing-card-padding) font-sans"
      data-testid={testId}
    >
      <p className="flex items-center gap-1.5 text-sm font-semibold text-(--el-text) [&>svg]:size-3.5">
        {icon}
        {title}
      </p>
      <p className="text-xs text-(--el-text-secondary)">{lead}</p>
      <div className="mt-auto flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/**
 * What a send ANSWERED, when it was refused (design panels 2, 5 and 6). Every
 * title begins *Not sent —*; every body ends *Nothing was started and nothing was
 * charged.* — because every refusal is answered before a run is opened. The
 * wake's own refusals keep the wake's own words (`myAgents.refusal.*`), so this
 * door and My agents' Wake can never disagree.
 */
export function AgentSendNotice({
  refusal,
  projectName,
  openBlockers,
}: {
  refusal: AgentSendRefusal;
  projectName: string;
  openBlockers: number;
}) {
  const t = useTranslations('runs.agent.refused');
  const routes = useReaderRoutes();
  const wakeWords = useAgentRefusal(INSTANCE_MAX_PER_USER);
  const { agent } = refusal;
  const names = { name: agent.name, agent: agent.profileName };
  const nothing = t('nothing');

  if (refusal.kind === 'notWritable') return <RefusalNotice refusal={refusal.hosted} />;

  let title: ReactNode;
  let body: ReactNode = null;
  let after: ReactNode = null;
  switch (refusal.kind) {
    case 'wake':
      title = t('wakeTitle', names);
      body = wakeWords({ code: refusal.code, reason: refusal.reason }).message;
      break;
    case 'runActive': {
      const key = refusal.workItemKey;
      const run = (chunks: ReactNode) => (
        <Link
          className="text-(--el-link) underline"
          href={routes.view(runsHref({ run: refusal.runId }))}
        >
          {chunks}
        </Link>
      );
      if (key) {
        const tags = {
          ...names,
          key,
          run,
          k: (chunks: ReactNode) => (
            <Link className="font-mono text-(--el-link) underline" href={routes.item(key)}>
              {chunks}
            </Link>
          ),
        };
        title = t.rich('runActive.title', tags);
        body = t.rich('runActive.body', tags);
      } else {
        title = t('runActive.titleNoKey', names);
        body = t.rich('runActive.bodyNoKey', { ...names, run });
      }
      break;
    }
    case 'notSignedIn':
      title = t('notSignedIn.title', names);
      body = t.rich('notSignedIn.body', {
        ...names,
        cmd: () => <SignInCommand profileId={agent.profileId} />,
      });
      after = (
        <Link className="text-(--el-link) underline" href={agentPanelHref(agent.id)}>
          {t('notSignedIn.open', names)}
        </Link>
      );
      break;
    case 'wrongProject':
      title = t('wrongProject.title', names);
      body = t('wrongProject.body', { project: projectName });
      break;
    case 'notReady':
      title = t('notReady.title');
      body =
        openBlockers > 0 ? t('notReady.body', { count: openBlockers }) : t('notReady.bodyState');
      break;
    case 'deleting':
    case 'outOfCredits':
      title = t(`${refusal.kind}.title`, names);
      break;
    default:
      title = t(`${refusal.kind}.title`, names);
      body = t(`${refusal.kind}.body`);
  }

  return (
    <Notice testId={`agent-refused-${refusal.kind}`}>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-semibold">{title}</p>
        <p>
          {body}
          {body ? ' ' : null}
          {nothing}
        </p>
        {after}
      </div>
    </Notice>
  );
}
