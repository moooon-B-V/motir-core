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
// `Explore` is the only nav item that resolves to a real page today (the square
// itself); `Product` / `Docs` / `Pricing` are future marketing pages, so they
// render as non-interactive labels rather than dead links a crawler would 404 on.

export async function ExploreTopBar() {
  const t = await getTranslations('projectSquare');
  const navItems = [
    { key: 'navProduct', label: t('navProduct') },
    { key: 'navDocs', label: t('navDocs') },
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
          href="/explore"
          aria-current="page"
          className="text-[13.5px] font-semibold text-(--el-accent-on-surface)"
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
