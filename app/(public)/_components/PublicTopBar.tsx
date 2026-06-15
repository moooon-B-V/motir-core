import Link from 'next/link';
import { Globe } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Pill } from '@/components/ui/Pill';
import { buttonVariants } from '@/components/ui/Button';

// The public top bar (Story 6.12 · Subtask 6.12.4 · design Panel 2 `.pub-topbar`).
// Logo tile + project name + the "Public" globe Pill + key/workspace, and a
// logged-out Sign in / Start free CTA on the right (NOT a signed-in identity —
// the page is anonymous to view). Server component; colour via --el-* tokens.

export async function PublicTopBar({
  name,
  identifier,
  workspaceName,
}: {
  name: string;
  identifier: string;
  workspaceName: string;
}) {
  const t = await getTranslations('publicProjects');
  const initial = name.trim().charAt(0).toUpperCase() || 'P';
  return (
    <div className="flex items-center justify-between gap-4 border-b border-(--el-border) bg-(--el-surface-soft) px-(--spacing-card-padding) py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden
          className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-(--radius-control) bg-(--el-accent) text-sm font-extrabold text-(--el-accent-text)"
        >
          {initial}
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[14.5px] font-bold text-(--el-text)">{name}</span>
            <Pill
              tone="neutral"
              className="gap-1 border-transparent bg-(--el-public-banner-bg) text-(--el-public-banner-text)"
            >
              <Globe className="h-3 w-3 text-(--el-info)" aria-hidden />
              {t('publicChip')}
            </Pill>
          </div>
          <span className="font-mono text-xs text-(--el-text-faint)">
            {identifier} · {workspaceName}
          </span>
        </div>
      </div>
      <div className="flex flex-none items-center gap-2">
        <Link href="/sign-in" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
          {t('signIn')}
        </Link>
        <Link href="/sign-up" className={buttonVariants({ variant: 'primary', size: 'sm' })}>
          {t('startFree')}
        </Link>
      </div>
    </div>
  );
}
