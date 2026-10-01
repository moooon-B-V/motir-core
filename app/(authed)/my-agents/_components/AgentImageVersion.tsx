'use client';

import { useTranslations } from 'next-intl';
import { CircleArrowUp, RefreshCw } from 'lucide-react';
import type { AgentInstanceListItemDto } from '@/lib/dto/agentInstances';

// THE AGENT'S VERSION AND ITS UPDATE MARKER (Story MOTIR-6862 · MOTIR-6953;
// `design/my-agents/my-agents--update.mock.html` panels 1, 2, 5 and 9). The
// version in mono beside one of three markers, decided by the catalog's answer
// (`agent-image-update.md` Q1): Update available → <version> (sky), <version> on
// next wake (lavender, a hibernated agent that took it), or could not check — a
// quiet grey chip, never a claim that the agent is current. On the newest, the
// version alone.

const CHIP =
  'inline-flex items-center gap-1 rounded-(--radius-badge) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs whitespace-nowrap';

export function AgentImageVersion({
  agent,
}: {
  agent: Pick<
    AgentInstanceListItemDto,
    'imageVersion' | 'update' | 'pendingImageVersion' | 'state'
  >;
}) {
  const t = useTranslations('myAgents.update');
  const pending = agent.state === 'hibernated' ? agent.pendingImageVersion : null;
  let marker = null;
  if (pending) {
    marker = (
      <span
        data-testid="agent-update-pending"
        className={`${CHIP} bg-(--el-tint-lavender) font-semibold text-(--el-text-strong)`}
      >
        <RefreshCw className="size-3.5" aria-hidden="true" />
        {t('nextWake', { to: pending })}
      </span>
    );
  } else if (agent.update === 'unknown') {
    marker = (
      <span
        data-testid="agent-update-unknown"
        className={`${CHIP} bg-(--el-surface-soft) text-(--el-text-secondary)`}
      >
        {t('unknown')}
      </span>
    );
  } else if (agent.update && agent.state !== 'updating') {
    marker = (
      <span
        data-testid="agent-update-available"
        className={`${CHIP} bg-(--el-tint-sky) font-semibold text-(--el-text-strong)`}
      >
        <CircleArrowUp className="size-3.5" aria-hidden="true" />
        {t('available', { to: agent.update.version })}
      </span>
    );
  }
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
      <span data-testid="agent-version" className="font-mono text-xs text-(--el-text-secondary)">
        {agent.imageVersion ?? t('earlierBuild')}
      </span>
      {marker}
    </span>
  );
}
