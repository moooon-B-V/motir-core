'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Moon, MoreHorizontal, Power, Trash2 } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import type { AgentInstanceState } from '@/lib/dto/agentInstances';
import { allowedAgentMoves, type AgentMove } from '@/lib/agentInstances/presentation';

// THE ROW MENU (MOTIR-6868 revision 3, panel 3): exactly the moves §4 allows from
// the row's state — Wake from hibernated or failed, Hibernate from running,
// Delete… from running, hibernated or failed. A move the state does not allow is
// DISABLED, not hidden, so the menu keeps one shape.

const ITEM =
  'flex h-(--height-control) w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) text-left text-sm hover:bg-(--el-surface) focus-visible:bg-(--el-surface) focus-visible:outline-none disabled:cursor-not-allowed disabled:hover:bg-transparent';

export function AgentRowMenu({
  name,
  state,
  onMove,
}: {
  name: string;
  state: AgentInstanceState;
  onMove: (move: AgentMove) => void;
}) {
  const t = useTranslations('myAgents');
  const [open, setOpen] = useState(false);
  const allowed = allowedAgentMoves(state);

  function item(move: AgentMove, icon: React.ReactNode, label: string, danger = false) {
    const enabled = allowed.has(move);
    return (
      <button
        type="button"
        role="menuitem"
        disabled={!enabled}
        aria-disabled={!enabled}
        className={`${ITEM} ${
          !enabled
            ? 'text-(--el-text-faint)'
            : danger
              ? 'text-(--el-danger-on-surface)'
              : 'text-(--el-text)'
        }`}
        onClick={() => {
          setOpen(false);
          onMove(move);
        }}
      >
        {icon}
        <span className="flex-1 truncate">{label}</span>
      </button>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={t('rowActions', { name })}
        className="inline-flex h-(--height-control) w-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        <MoreHorizontal className="size-4" aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Content width={208} align="end" className="p-0">
        <div className="p-1" role="menu" aria-label={t('rowActions', { name })}>
          {item('wake', <Power className="size-4 shrink-0" aria-hidden="true" />, t('menu.wake'))}
          {item(
            'hibernate',
            <Moon className="size-4 shrink-0" aria-hidden="true" />,
            t('menu.hibernate'),
          )}
          {item(
            'delete',
            <Trash2 className="size-4 shrink-0" aria-hidden="true" />,
            t('menu.delete'),
            true,
          )}
        </div>
      </Popover.Content>
    </Popover>
  );
}
