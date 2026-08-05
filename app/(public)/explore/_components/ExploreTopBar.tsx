import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ArrowRight } from 'lucide-react';
import { buttonVariants } from '@/components/ui/Button';

// The marketing-site top bar for the project square (Story 6.13 · Subtask 6.13.6
// · design Panel 1 `.site-top`). This is NOT the app `Sidebar` / shell chrome —
// the square is a standalone, fully-public web page reached from the marketing
// site, so it carries its own brand + nav + sign-in/CTA. Server component;
// colour via --el-* tokens, shape via element-semantic tokens.
//
// `Product` / `Pricing` are future marketing pages, so they render as
// non-interactive LABELS rather than dead links a crawler would 404 on.
//
// ⚠️ `Docs` used to be one of those labels and is now a LINK (Story 11.4 ·
// Subtask 11.4.7 — MOTIR-2188 · design `design/api-docs/` Panel 7): it is the
// first of the three future pages to actually RESOLVE, so it takes the treatment
// this bar already had for a real page — the one `Explore` uses. That is why the
// docs entrance is not a new nav pattern: the item was already here, waiting for
// something to point at.
//
// `current` marks which of the two resolving items is the page being read, so
// this bar can head BOTH the project square and the docs surface without either
// claiming to be the other.

export async function ExploreTopBar({
  current = 'explore',
}: { current?: 'explore' | 'docs' } = {}) {
  const t = await getTranslations('projectSquare');
  const navItems = [
    { key: 'navProduct', label: t('navProduct') },
    { key: 'navPricing', label: t('navPricing') },
  ];
  return (
    <header className="flex items-center justify-between gap-4 border-b border-(--el-border) bg-(--el-surface-soft) px-(--spacing-card-padding) py-3">
      <Link href="/" className="flex flex-none items-center gap-2">
        <span
          aria-hidden
          className="inline-flex h-7 w-7 items-center justify-center rounded-(--radius-control) bg-(--el-accent) text-sm font-extrabold text-(--el-accent-text)"
        >
          M
        </span>
        <span className="text-[15px] font-bold text-(--el-text)">{t('brand')}</span>
      </Link>
      <nav aria-label={t('navProduct')} className="hidden items-center gap-5 md:flex">
        {navItems.map((item) => (
          <span key={item.key} className="text-[13.5px] text-(--el-text-muted)">
            {item.label}
          </span>
        ))}
        <Link
          href="/api-docs"
          {...(current === 'docs' ? { 'aria-current': 'page' as const } : {})}
          className={
            current === 'docs'
              ? 'text-[13.5px] font-semibold text-(--el-accent-on-surface)'
              : 'text-[13.5px] text-(--el-text-secondary)'
          }
        >
          {t('navDocs')}
        </Link>
        <Link
          href="/explore"
          {...(current === 'explore' ? { 'aria-current': 'page' as const } : {})}
          className={
            current === 'explore'
              ? 'text-[13.5px] font-semibold text-(--el-accent-on-surface)'
              : 'text-[13.5px] text-(--el-text-secondary)'
          }
        >
          {t('navExplore')}
        </Link>
      </nav>
      <div className="flex flex-none items-center gap-2">
        <Link href="/sign-in" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
          {t('signIn')}
        </Link>
        <Link href="/sign-up" className={buttonVariants({ variant: 'primary', size: 'sm' })}>
          {t('startFree')}
          <ArrowRight className="ml-1 h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
    </header>
  );
}
