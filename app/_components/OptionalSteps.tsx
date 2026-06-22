'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ListChecks, Palette, Shield } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';

// The "Optional steps along the way" disclosure on the public front door.
//
// COLLAPSED by default so the landing fits the viewport with no scrollbar; the
// summary bar is the only thing visible until the visitor opens it. On expand we
// smooth-scroll the revealed panel into view (the content now extends past the
// fold). Client-only because both the toggle and the scroll are interactive.
export function OptionalSteps() {
  const t = useTranslations('onboarding');
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  // After the panel renders open, bring it into view (skip the initial collapsed mount).
  useEffect(() => {
    if (open) panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [open]);

  const items = [
    {
      Icon: Shield,
      tint: 'bg-(--el-tint-mint)',
      title: t('landing.optional.worthTitle'),
      desc: t('landing.optional.worthDesc'),
      tag: t('landing.optional.optionalTag'),
    },
    {
      Icon: ListChecks,
      tint: 'bg-(--el-tint-mint)',
      title: t('landing.optional.demandTitle'),
      desc: t('landing.optional.demandDesc'),
      tag: t('landing.optional.optionalTag'),
    },
    {
      Icon: Palette,
      tint: 'bg-(--el-tint-peach)',
      title: t('landing.optional.designTitle'),
      desc: t('landing.optional.designDesc'),
      tag: t('landing.optional.optionalTag'),
    },
  ];

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left text-sm text-(--el-text) hover:bg-(--el-surface) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
      >
        <ChevronDown
          className={`h-4 w-4 transition-transform ${open ? 'rotate-0' : '-rotate-90'}`}
          aria-hidden
        />
        <span className="font-semibold">{t('landing.optional.summary')}</span>
        <span className="text-(--el-text-muted)">{t('landing.optional.summaryHint')}</span>
        <span className="ml-auto hidden font-mono text-xs text-(--el-text-faint) sm:inline">
          {t('landing.optional.names')}
        </span>
      </button>

      {open ? (
        <div ref={panelRef} id={panelId} className="mt-3 grid scroll-mt-4 gap-3 sm:grid-cols-3">
          {items.map(({ Icon, tint, title, desc, tag }) => (
            <Card key={title} className="h-full border-dashed bg-(--el-surface)">
              <span
                className={`flex h-8 w-8 items-center justify-center rounded-(--radius-control) ${tint} text-(--el-text-strong)`}
              >
                <Icon className="h-4 w-4" aria-hidden />
              </span>
              <h2 className="mt-3 flex items-center gap-2 text-sm font-semibold text-(--el-text)">
                {title}
                <span className="rounded-(--radius-badge) bg-(--el-muted) px-(--spacing-chip-x) py-(--spacing-chip-y) text-[10px] font-medium uppercase tracking-wide text-(--el-text-muted)">
                  {tag}
                </span>
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-(--el-text-secondary)">{desc}</p>
            </Card>
          ))}
        </div>
      ) : null}
    </div>
  );
}
