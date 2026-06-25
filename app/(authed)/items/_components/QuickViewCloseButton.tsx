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
//
// `onClose` (MOTIR-1352) lets a NON-URL host (the roadmap-canvas quick-view, which
// drives the peek from LOCAL state, not `?peek`) supply its own close. When given,
// the URL `usePeekClose` hook is never reached (a distinct component branch), so the
// panel renders with no Next-router context. The /items · /ready · /boards surfaces
// pass nothing → the shipped URL-clearing behaviour is unchanged.

export function QuickViewCloseButton({
  variant = 'icon',
  onClose,
}: {
  variant?: 'icon' | 'button';
  onClose?: () => void;
}) {
  if (onClose) return <CloseButton variant={variant} close={onClose} />;
  return <UrlCloseButton variant={variant} />;
}

/** The shipped URL-driven close — clears `?peek` via the shared shallow router. */
function UrlCloseButton({ variant }: { variant: 'icon' | 'button' }) {
  const close = usePeekClose();
  return <CloseButton variant={variant} close={close} />;
}

function CloseButton({ variant, close }: { variant: 'icon' | 'button'; close: () => void }) {
  const tc = useTranslations('common');

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
