'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { CircleHelp } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Popover } from '@/components/ui/Popover';

// The "What is this?" predicate explainer (Subtask 7.0.6, design/ready panel 1b).
// A first-run popover that explains the readiness predicate to a user who's never
// seen the dispatch surface. Composes the shipped Popover (card container) + a
// ghost Button trigger; copy comes from the `ready` namespace, with the
// `<strong>` emphasis and the `prodect run` / Copy code chips rendered via
// next-intl rich text so they stay translatable as one phrase.
export function ReadyHelpPopover() {
  const t = useTranslations('ready');
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<CircleHelp className="h-[15px] w-[15px] text-(--el-text-muted)" />}
          className="text-(--el-text-secondary)"
          aria-haspopup="dialog"
        >
          {t('whatIsThis')}
        </Button>
      </Popover.Trigger>
      <Popover.Content
        align="end"
        width={320}
        role="dialog"
        aria-label={t('popover.title')}
        className="p-4"
      >
        <h2 className="font-sans text-sm font-semibold text-(--el-text)">{t('popover.title')}</h2>
        <p className="mt-1.5 font-sans text-sm leading-relaxed text-(--el-text-secondary)">
          {t.rich('popover.body1', {
            strong: (chunks) => (
              <strong className="font-semibold text-(--el-text)">{chunks}</strong>
            ),
          })}
        </p>
        <p className="mt-2 font-sans text-sm leading-relaxed text-(--el-text-secondary)">
          {t.rich('popover.body2', {
            code: (chunks) => (
              <code className="rounded-(--radius-control) bg-(--el-code-bg) px-(--spacing-kbd-x) py-(--spacing-kbd-y) font-mono text-xs text-(--el-code-text)">
                {chunks}
              </code>
            ),
          })}
        </p>
      </Popover.Content>
    </Popover>
  );
}
