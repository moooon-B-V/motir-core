'use client';

import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { usePeekClose } from './IssueQuickView';

// The quick-view close affordances (Subtask 2.5.19), both clearing `?peek` via
// the shared usePeekClose. Two forms per the design:
//   - `icon`   — the × icon button in the modal header bar.
//   - `button` — the ghost "Close" button in the not-found empty state.
// Kept tiny + client-only so the streamed (Server Component) modal body can drop
// them in without importing router hooks itself.

export function QuickViewCloseButton({ variant = 'icon' }: { variant?: 'icon' | 'button' }) {
  const tc = useTranslations('common');
  const close = usePeekClose();

  if (variant === 'button') {
    return (
      <Button variant="ghost" size="sm" onClick={close}>
        {tc('close')}
      </Button>
    );
  }

  return (
    <button
      type="button"
      onClick={close}
      aria-label={tc('close')}
      className="inline-flex h-(--height-control) w-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-muted) transition-colors hover:bg-(--el-muted) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
    >
      <X className="h-[18px] w-[18px]" aria-hidden />
    </button>
  );
}
