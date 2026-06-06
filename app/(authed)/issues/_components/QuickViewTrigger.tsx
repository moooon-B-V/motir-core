'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Eye } from 'lucide-react';
import { useTranslations } from 'next-intl';

// The per-row QUICK-VIEW trigger (Subtask 2.5.19) — the eye button that lives in
// the trailing row-actions cell of BOTH the Tree and the List (shared via the
// `actions` column in issueColumns). Per design/work-items/quick-view.mock.html
// (panel 1): the row is already a stretched whole-row link to /issues/[key], so
// this trigger MUST NOT nest inside that link — it sits in its own cell and is
// raised ABOVE the stretched-link overlay with `relative z-10`, a sibling of the
// link, never a child. Activating it pushes `?peek=<identifier>` (preserving the
// current view/sort/filter/page params), so the peek is URL-driven — shareable,
// reload-safe, and closed by clearing the param. The button is hidden at rest
// and revealed on row hover/focus (the row carries `group`); always shown on
// coarse pointers so touch users get it.

export function QuickViewTrigger({ identifier, title }: { identifier: string; title: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations('issueViews');

  const open = useCallback(() => {
    const params = new URLSearchParams(searchParams?.toString());
    params.set('peek', identifier);
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  }, [router, pathname, searchParams, identifier]);

  return (
    <button
      type="button"
      onClick={open}
      aria-label={t('quickViewAria', { key: identifier, title })}
      title={t('quickView')}
      data-testid={`quick-view-${identifier}`}
      className="relative z-10 inline-flex h-(--height-control) w-(--height-control) items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-faint) opacity-0 transition-[opacity,color,background-color] group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-(--el-muted) hover:text-(--el-text) focus-visible:text-(--el-text-muted) focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none [@media(hover:none)]:opacity-100"
    >
      <Eye className="h-[17px] w-[17px]" aria-hidden />
    </button>
  );
}
