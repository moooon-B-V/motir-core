import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CircleAlert, CircleCheckBig } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

// ReadinessBadge — the ready / blocked banner for a work item (Subtask 2.4.5,
// the presentational face of `workflowsService` / 2.2.6's readiness verdict),
// per `design/work-items/relationships.mock.html`. PURE: it takes the
// already-computed verdict (`ready` + the open blockers) and renders it; it does
// NOT re-derive readiness (the service owns the per-project terminal
// classification — finding #21). The SAME primitive Epic 3 boards + Epic 6
// reports reuse.
//
// A full-width tinted banner sits at the top of the relationships panel:
//  - ready   → mint (`--el-tint-mint`) + a success check + "Ready to start".
//  - blocked → peach (`--el-tint-peach`) + a warning alert + "Blocked", naming
//    the open (non-terminal) blockers as links so the reason is legible.
// State is conveyed by TEXT ("Ready to start" / "Blocked"), never colour alone
// (the icon + tint are redundant cues) — clears the shell-a11y axe sweep. Tints
// carry the hue in the BACKGROUND with `--el-text-strong` text (finding #35 AA).

export interface ReadinessBadgeProps {
  /** The service verdict: true iff every blocker is terminal (or none exist). */
  ready: boolean;
  /** The OPEN (non-terminal) blockers, named + linked when blocked. */
  blockers?: Array<{ identifier: string; href: string }>;
  className?: string;
}

export function ReadinessBadge({ ready, blockers = [], className }: ReadinessBadgeProps) {
  const t = useTranslations('ui');
  if (ready) {
    return (
      <div
        className={cn(
          'bg-(--el-tint-mint) flex items-start gap-2.5 rounded-(--radius-card) px-3.5 py-3',
          className,
        )}
      >
        <CircleCheckBig
          className="text-(--el-success) mt-0.5 h-[18px] w-[18px] shrink-0"
          aria-hidden
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-(--el-text-strong) font-sans text-sm font-semibold">
            {t('readiness.ready')}
          </span>
          <span className="text-(--el-text-strong) font-sans text-[13px]">
            {t('readiness.allResolved')}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'bg-(--el-tint-peach) flex items-start gap-2.5 rounded-(--radius-card) px-3.5 py-3',
        className,
      )}
    >
      <CircleAlert className="text-(--el-warning) mt-0.5 h-[18px] w-[18px] shrink-0" aria-hidden />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-(--el-text-strong) font-sans text-sm font-semibold">
          {t('readiness.blocked')}
        </span>
        {blockers.length > 0 ? (
          <span className="text-(--el-text-strong) font-sans text-[13px]">
            {t('readiness.waiting', { count: blockers.length })} —{' '}
            {blockers.map((b, i) => (
              <span key={b.identifier}>
                {i > 0 ? ', ' : null}
                <Link
                  href={b.href}
                  className="text-(--el-text-strong) font-mono text-xs underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
                >
                  {b.identifier}
                </Link>
              </span>
            ))}
          </span>
        ) : null}
      </div>
    </div>
  );
}
