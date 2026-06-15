import { Globe, BookOpen, Code2, Route, ExternalLink } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { SectionLabel } from '@/components/ui/SectionLabel';
import type { PublicProjectOverviewDto } from '@/lib/dto/publicProjects';
import { PublicSubmitRequestButton } from './PublicSubmitRequestButton';

// The Overview sidebar (Story 6.12 · Subtask 6.12.4 · design Panel 1 `.ov-side`):
// a Links card (only the present links — derived from existing project fields),
// an At-a-glance stat grid, and a CTA card. Server component; colour via --el-*
// tokens, shape via element-semantic tokens.

function LinkRow({ href, icon, label }: { href: string; icon: ReactNode; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2.5 border-t border-(--el-border-soft) py-2 text-[13.5px] text-(--el-text) first:border-t-0 hover:text-(--el-link)"
    >
      <span className="inline-flex h-4 w-4 flex-none text-(--el-text-secondary)" aria-hidden>
        {icon}
      </span>
      {label}
      <ExternalLink className="ml-auto h-3 w-3 text-(--el-text-faint)" aria-hidden />
    </a>
  );
}

export async function PublicOverviewSidebar({ overview }: { overview: PublicProjectOverviewDto }) {
  const t = await getTranslations('publicProjects');
  const { links, stats } = overview;
  const hasLinks = links.website || links.docs || links.repo || links.changelog;
  const glance: Array<{ n: number; l: string }> = [
    { n: stats.publicRequests, l: t('statRequests') },
    { n: stats.inProgress, l: t('statInProgress') },
    { n: stats.planned, l: t('statPlanned') },
    { n: stats.shipped, l: t('statShipped') },
  ];
  return (
    <aside className="flex flex-col gap-3.5">
      {hasLinks ? (
        <div className="rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) p-4 shadow-(--shadow-subtle)">
          <SectionLabel className="mb-3">{t('linksTitle')}</SectionLabel>
          {links.website ? (
            <LinkRow
              href={links.website}
              icon={<Globe className="h-4 w-4" />}
              label={t('linkWebsite')}
            />
          ) : null}
          {links.docs ? (
            <LinkRow
              href={links.docs}
              icon={<BookOpen className="h-4 w-4" />}
              label={t('linkDocs')}
            />
          ) : null}
          {links.repo ? (
            <LinkRow
              href={links.repo}
              icon={<Code2 className="h-4 w-4" />}
              label={t('linkSource')}
            />
          ) : null}
          {links.changelog ? (
            <LinkRow
              href={links.changelog}
              icon={<Route className="h-4 w-4" />}
              label={t('linkChangelog')}
            />
          ) : null}
        </div>
      ) : null}

      <div className="rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) p-4 shadow-(--shadow-subtle)">
        <SectionLabel className="mb-3">{t('atAGlance')}</SectionLabel>
        <dl className="grid grid-cols-2 gap-x-2.5 gap-y-3.5">
          {glance.map((g) => (
            <div key={g.l}>
              <dd className="font-serif text-[19px] font-bold text-(--el-text)">{g.n}</dd>
              <dt className="mt-px text-[11.5px] text-(--el-text-muted)">{g.l}</dt>
            </div>
          ))}
        </dl>
      </div>

      <div
        className="rounded-(--radius-card) border border-(--el-border) p-[18px]"
        style={{
          background:
            'radial-gradient(140% 120% at 100% 0%, var(--el-hero-wash-a) 0%, transparent 60%), var(--el-surface-soft)',
        }}
      >
        <h2 className="mb-1 font-serif text-[15px] text-(--el-text)">{t('ctaTitle')}</h2>
        <p className="mb-3 text-[12.5px] leading-relaxed text-(--el-text-muted)">{t('ctaBody')}</p>
        <PublicSubmitRequestButton size="sm" />
      </div>
    </aside>
  );
}
