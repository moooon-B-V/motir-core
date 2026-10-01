'use client';

import { useFormatter, useNow, useTranslations } from 'next-intl';
import { History, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Popover } from '@/components/ui/Popover';
import { MAX_LISTED_SESSIONS, type ChatSessionSummary } from '@/lib/agentChat/protocol';

// THE SESSION LIST (Story MOTIR-6863 · MOTIR-7017; `design/my-agents/design-notes.md`
// § the Chat tab, panel 6) — a popover under the chat bar's Sessions button.
// Newest first by last activity, at most 50 (Q7), New chat at its head, the open
// session marked. Terminal sessions are listed too and not told apart (Q7).
// Nothing here is stored or sent anywhere but back to the agent (Q10).

export function ChatSessionList({
  open,
  onOpenChange,
  sessions,
  currentId,
  agentName,
  machineName,
  disabled,
  onChoose,
  onNewChat,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null until the agent answers the first `list`. */
  sessions: ChatSessionSummary[] | null;
  currentId: string | null;
  /** The coding agent's display name. */
  agentName: string;
  /** The agent instance's own name. */
  machineName: string;
  disabled: boolean;
  onChoose: (session: ChatSessionSummary) => void;
  onNewChat: () => void;
}) {
  const t = useTranslations('myAgents.panel.chat');
  const format = useFormatter();
  // The instant "2 hours ago" is measured from, re-read each minute.
  const now = useNow({ updateInterval: 60_000 });
  const rows = sessions ?? [];

  return (
    <span className="flex flex-none items-center gap-1.5">
      <Popover open={open} onOpenChange={onOpenChange}>
        <Popover.Trigger asChild>
          {/* The base Button, secondary — labelled on a roomy bar, icon-only on a narrow one (panel 9). */}
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled}
            aria-label={t('sessions.label')}
            leftIcon={<History aria-hidden="true" />}
          >
            <span className="hidden @md:inline">{t('sessions.label')}</span>
          </Button>
        </Popover.Trigger>
        <Popover.Content
          align="end"
          width={330}
          aria-label={t('sessions.title', { name: machineName })}
          className="max-w-[calc(100vw-2rem)] bg-(--el-card) p-1"
        >
          <p className="m-0 px-(--spacing-control-x) py-(--spacing-control-y) text-xs font-semibold text-(--el-text-secondary)">
            {t('sessions.title', { name: machineName })}
          </p>
          <button
            type="button"
            onClick={() => {
              onOpenChange(false);
              onNewChat();
            }}
            className="flex w-full items-center gap-1.5 rounded-t-(--radius-control) border-b border-(--el-border-soft) px-(--spacing-control-x) py-(--spacing-control-y) text-left text-[0.8125rem] font-medium text-(--el-text) hover:bg-(--el-surface-soft)"
          >
            <Plus aria-hidden="true" className="size-3.5" />
            {t('newChat')}
          </button>
          {sessions !== null && rows.length === 0 ? (
            <p className="m-0 px-(--spacing-control-x) pt-(--spacing-control-y) pb-3 text-[0.8125rem] leading-normal text-(--el-text-secondary)">
              {t('sessions.empty', { agent: agentName })}
            </p>
          ) : (
            <ul role="list" className="m-0 max-h-80 list-none overflow-y-auto p-0">
              {rows.map((s) => {
                const current = s.id === currentId;
                const when = Date.parse(s.updatedAt);
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      data-testid="chat-session-row"
                      aria-current={current ? 'true' : undefined}
                      onClick={() => {
                        onOpenChange(false);
                        onChoose(s);
                      }}
                      className={`flex w-full flex-col gap-px rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left hover:bg-(--el-surface-soft) ${
                        current ? 'bg-(--el-option-active-bg)' : ''
                      }`}
                    >
                      <span className="w-full truncate text-[0.8125rem] text-(--el-text)">
                        {s.title}
                      </span>
                      {Number.isFinite(when) ? (
                        <span className="text-xs text-(--el-text-secondary)">
                          {format.relativeTime(new Date(when), now)}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {rows.length >= MAX_LISTED_SESSIONS ? (
            <p className="m-0 mt-1 border-t border-(--el-border-soft) px-(--spacing-control-x) py-(--spacing-control-y) text-xs leading-normal text-(--el-text-secondary)">
              {t('sessions.bound', { agent: agentName })}
            </p>
          ) : null}
        </Popover.Content>
      </Popover>
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled}
        aria-label={t('newChat')}
        leftIcon={<Plus aria-hidden="true" />}
        onClick={onNewChat}
      >
        <span className="hidden @md:inline">{t('newChat')}</span>
      </Button>
    </span>
  );
}
