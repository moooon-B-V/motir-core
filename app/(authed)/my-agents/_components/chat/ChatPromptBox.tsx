'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { LoaderCircle, Send, Square } from 'lucide-react';
import { Button } from '@/components/ui/Button';

// THE PROMPT BOX (Story MOTIR-6863 · MOTIR-7017; `design/my-agents/design-notes.md`
// § the Chat tab, panel 5). Five states:
//
//   idle      empty; Send is off
//   typing    Send is primary
//   sending   the prompt is already in the transcript; "Sending…", off
//   running   still editable (the next prompt can be written); the button is Stop
//   disabled  not connected: the box is disabled and keeps its text
//
// Enter sends; Shift+Enter is a new line. A prompt is text only (Q4).

export type PromptBoxState = 'ready' | 'sending' | 'running' | 'disabled';

export function ChatPromptBox({
  agentName,
  value,
  onChange,
  state,
  onSend,
  onStop,
}: {
  agentName: string;
  value: string;
  onChange: (value: string) => void;
  state: PromptBoxState;
  onSend: () => void;
  onStop: () => void;
}) {
  const t = useTranslations('myAgents.panel.chat');
  const hintId = useId();
  const off = state === 'disabled';
  const canSend = state === 'ready' && value.trim().length > 0;

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (canSend) onSend();
  };

  let button: React.ReactNode;
  if (state === 'running') {
    button = (
      <Button
        variant="secondary"
        size="sm"
        leftIcon={<Square aria-hidden="true" />}
        onClick={onStop}
        className="flex-none"
      >
        {t('stop')}
      </Button>
    );
  } else if (state === 'sending') {
    button = (
      <Button
        variant="secondary"
        size="sm"
        disabled
        leftIcon={<LoaderCircle aria-hidden="true" className="animate-spin" />}
        className="flex-none"
      >
        {t('sending')}
      </Button>
    );
  } else {
    button = (
      <Button
        variant={canSend ? 'primary' : 'secondary'}
        size="sm"
        disabled={!canSend}
        leftIcon={<Send aria-hidden="true" />}
        onClick={onSend}
        className="flex-none"
      >
        {t('send')}
      </Button>
    );
  }

  return (
    <div
      data-testid="chat-composer"
      className="flex flex-col gap-1.5 border-t border-(--el-border-soft) bg-(--el-card) px-(--spacing-card-padding) py-3"
    >
      <div className="flex items-end gap-2">
        <textarea
          aria-label={t('prompt.label')}
          aria-describedby={hintId}
          placeholder={t('prompt.placeholder', { agent: agentName })}
          value={value}
          disabled={off}
          rows={1}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          className="max-h-48 min-h-(--height-input) min-w-0 flex-1 resize-none rounded-(--radius-input) border border-(--el-input-border) bg-(--el-card) px-(--spacing-input-x) py-(--spacing-input-y) text-sm leading-normal text-(--el-text) [field-sizing:content] placeholder:text-(--el-text-secondary) focus:border-(--el-accent) focus:ring-2 focus:ring-(--focus-ring-color) focus:outline-none disabled:border-(--el-input-disabled-border) disabled:bg-(--el-input-disabled-bg) disabled:text-(--el-input-disabled-text)"
        />
        {button}
      </div>
      <p id={hintId} className="m-0 text-xs text-(--el-text-secondary)">
        {off ? t('prompt.offHint') : t('prompt.hint')}
      </p>
    </div>
  );
}
