'use client';

import { Check, Lock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';

export type WizardStep = 'connect' | 'map' | 'preview' | 'run';

const ORDER: WizardStep[] = ['connect', 'map', 'preview', 'run'];
const LABEL_KEY: Record<WizardStep, string> = {
  connect: 'connect',
  map: 'map',
  preview: 'preview',
  run: 'import',
};

type DotState = 'done' | 'current' | 'todo' | 'locked';

/**
 * The wizard step rail — Connect · Map · Preview · Import — with done / current /
 * locked states (design Panel 0). The Import step is drawn LOCKED until the
 * dry-run preview has been reviewed (`previewed`), making the confirm-before-write
 * gate visible. Colour roles per the design: done → `--el-success`, current →
 * `--el-accent`, locked → dashed `--el-border-strong` + `--el-text-faint`.
 */
export function StepRail({
  current,
  previewed,
  className,
}: {
  current: WizardStep;
  previewed: boolean;
  className?: string;
}) {
  const t = useTranslations('import');
  const currentIndex = ORDER.indexOf(current);

  function stateFor(step: WizardStep, index: number): DotState {
    if (index < currentIndex) return 'done';
    if (index === currentIndex) return 'current';
    if (step === 'run' && !previewed) return 'locked';
    return 'todo';
  }

  return (
    <ol className={cn('flex items-center', className)} aria-label={t('chrome.title')}>
      {ORDER.map((step, index) => {
        const state = stateFor(step, index);
        const isLast = index === ORDER.length - 1;
        return (
          <li key={step} className="flex flex-1 items-center last:flex-none">
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full text-xs',
                  state === 'done' && 'bg-(--el-success) text-(--el-text-inverted)',
                  state === 'current' &&
                    'bg-(--el-accent) text-(--el-accent-text) ring-4 ring-[color-mix(in_srgb,var(--el-accent)_18%,transparent)]',
                  state === 'todo' && 'border border-(--el-border-strong) text-(--el-text-faint)',
                  state === 'locked' &&
                    'border border-dashed border-(--el-border-strong) text-(--el-text-faint)',
                )}
              >
                {state === 'done' ? (
                  <Check className="size-3.5" />
                ) : state === 'locked' ? (
                  <Lock className="size-3" />
                ) : (
                  index + 1
                )}
              </span>
              <span className="flex flex-col leading-tight">
                <span
                  className={cn(
                    'text-sm',
                    state === 'done' && 'text-(--el-text-strong)',
                    state === 'current' && 'font-medium text-(--el-text)',
                    (state === 'todo' || state === 'locked') && 'text-(--el-text-faint)',
                  )}
                  aria-current={state === 'current' ? 'step' : undefined}
                >
                  {t(`steps.${LABEL_KEY[step]}`)}
                </span>
                {step === 'run' && state === 'locked' ? (
                  <span className="text-xs text-(--el-text-faint)">
                    {t('steps.lockedUntilPreview')}
                  </span>
                ) : null}
              </span>
            </div>
            {!isLast ? (
              <span
                aria-hidden
                className={cn(
                  'mx-3 h-px flex-1',
                  index < currentIndex ? 'bg-(--el-success)' : 'bg-(--el-border)',
                )}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
