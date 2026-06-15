import Link from 'next/link';
import { Route, Code2 } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Pill } from '@/components/ui/Pill';
import { buttonVariants } from '@/components/ui/Button';
import type { PublicProjectOverviewDto } from '@/lib/dto/publicProjects';
import { PublicSubmitRequest } from './PublicSubmitRequest';

// The Overview hero (Story 6.12 · Subtask 6.12.4 · design Panel 1 `.hero`). A
// bordered card with a soft corner-wash (two radial --el-hero-wash-* tints over
// --el-page-bg — decorative only; ALL text sits on --el-page-bg, AA-safe,
// finding #35). Logo tile + serif name + meta Pills + tagline + CTA row + the
// at-a-glance stat strip. Server component; colour via --el-* tokens.

function compact(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  return String(n);
}

export async function PublicOverviewHero({
  overview,
  roadmapHref,
}: {
  overview: PublicProjectOverviewDto;
  roadmapHref: string;
}) {
  const t = await getTranslations('publicProjects');
  const initial = overview.name.trim().charAt(0).toUpperCase() || 'P';
  // The hero tagline is the generic public-project line (i18n); the project's
  // authored, project-specific framing (e.g. Motir's "Vibe your whole project…")
  // lives at the top of the README body, rendered below the hero via MarkdownView.
  const tagline = t('autoIntroTagline');
  const stats: Array<{ n: number; l: string }> = [
    { n: overview.stats.publicRequests, l: t('statPublicRequests') },
    { n: overview.stats.upvotes, l: t('statUpvotes') },
    { n: overview.stats.planned, l: t('statPlanned') },
    { n: overview.stats.shipped, l: t('statShipped') },
  ];
  return (
    <div
      className="relative overflow-hidden rounded-(--radius-card) border border-(--el-border) p-8 shadow-(--shadow-card)"
      style={{
        background:
          'radial-gradient(120% 140% at 0% 0%, var(--el-hero-wash-a) 0%, transparent 55%), radial-gradient(120% 140% at 100% 0%, var(--el-hero-wash-b) 0%, transparent 50%), var(--el-page-bg)',
      }}
    >
      <div className="mb-4 flex items-center gap-3.5">
        <span
          aria-hidden
          className="inline-flex h-[52px] w-[52px] flex-none items-center justify-center rounded-(--radius-card) bg-(--el-accent) text-2xl font-extrabold text-(--el-accent-text) shadow-(--shadow-subtle)"
        >
          {initial}
        </span>
        <div>
          <h1 className="font-serif text-3xl font-semibold leading-tight tracking-tight text-(--el-text)">
            {overview.name}
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Pill
              tone="neutral"
              className="border-transparent bg-(--el-tint-lavender) text-(--el-text-strong)"
            >
              {t('metaVibeProject')}
            </Pill>
            <Pill
              tone="neutral"
              className="border-transparent bg-(--el-tint-mint) text-(--el-text-strong)"
            >
              {t('metaOpenSource')}
            </Pill>
            <Pill tone="neutral">{t('metaLicense')}</Pill>
            <Pill tone="neutral">{t('metaMcpNative')}</Pill>
          </div>
        </div>
      </div>

      <p className="mt-3.5 max-w-[40rem] text-base leading-relaxed text-(--el-text-secondary)">
        {tagline}
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-2.5">
        <Link href={roadmapHref} className={buttonVariants({ variant: 'primary', size: 'md' })}>
          <Route className="h-4 w-4" aria-hidden />
          {t('viewRoadmap')}
        </Link>
        <PublicSubmitRequest identifier={overview.identifier} size="md" />
        {overview.links.repo ? (
          <a
            href={overview.links.repo}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ variant: 'ghost', size: 'md' })}
          >
            <Code2 className="h-4 w-4" aria-hidden />
            {t('github')}
          </a>
        ) : null}
      </div>

      <dl className="mt-6 flex flex-wrap gap-x-7 gap-y-3 border-t border-(--el-border-soft) pt-5">
        {stats.map((s) => (
          <div key={s.l}>
            <dd className="font-serif text-[22px] font-bold text-(--el-text)">{compact(s.n)}</dd>
            <dt className="mt-0.5 text-xs text-(--el-text-muted)">{s.l}</dt>
          </div>
        ))}
      </dl>
    </div>
  );
}
