import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Building2, ChevronUp, Activity, ArrowRight } from 'lucide-react';
import type { ProjectSquareCardDto } from '@/lib/dto/projectSquare';

// One public project as a square gallery card (Story 6.13 · Subtask 6.13.6 ·
// design Panel 1 `.pcard`). The WHOLE card is a single `<a href="/p/<key>">` into
// the project's 6.12.4 public read-only view — the only interactive element, so
// no nested-interactive a11y violation; crawlable without JS. Each card is an
// `<article>` with an `<h3>` (the SEO outline). Colour via --el-* tokens; shape
// via element-semantic shape tokens. NO "Public" pill (every project here is
// public by definition — design model revision 2026-06-14).
//
// Two stats are shown — total upvotes + a recency signal — NOT three: 6.12.6
// ships no viewer count, so `ProjectSquareCardDto` structurally carries only
// `upvotes` + `lastActivityAt` (the documented viewer-count gap). The DTO also
// carries no per-card tags, so the mock's tag chips are not rendered here.

/** A compact, localised "n d/h/m ago" for the card's recency stat. */
function relativeAge(iso: string, locale: string): string {
  const then = new Date(iso).getTime();
  const diffMs = then - Date.now();
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' });
  const mins = Math.round(diffMs / 60000);
  const absMin = Math.abs(mins);
  if (absMin < 60) return rtf.format(Math.min(mins, -1), 'minute');
  const hours = Math.round(mins / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return rtf.format(days, 'day');
  const months = Math.round(days / 30);
  if (Math.abs(months) < 12) return rtf.format(months, 'month');
  return rtf.format(Math.round(months / 12), 'year');
}

export async function ProjectSquareCard({ card }: { card: ProjectSquareCardDto }) {
  const t = await getTranslations('projectSquare');
  const locale = await getLocale();
  const age = card.stats.lastActivityAt ? relativeAge(card.stats.lastActivityAt, locale) : null;

  return (
    <article className="min-w-0">
      <Link
        href={`/p/${encodeURIComponent(card.identifier)}`}
        aria-label={t('cardViewAria', { name: card.name })}
        className="group flex h-full min-w-0 flex-col rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) p-(--spacing-card-padding) shadow-(--shadow-card) transition-shadow hover:border-(--el-border-strong) hover:shadow-(--shadow-elevated)"
      >
        <div className="flex items-center gap-1.5 text-xs font-medium text-(--el-text-muted)">
          <Building2 className="h-3.5 w-3.5 flex-none" aria-hidden />
          <span className="truncate" title={card.org.name}>
            {card.org.name}
          </span>
        </div>

        <h3 className="mt-1.5 truncate text-[15px] font-bold text-(--el-text)">{card.name}</h3>

        {card.description ? (
          <p className="mt-1.5 line-clamp-3 text-[13px] leading-relaxed text-(--el-text-secondary)">
            {card.description}
          </p>
        ) : null}

        <div className="mt-auto flex items-center gap-4 pt-4 text-[13px] font-semibold text-(--el-text-secondary)">
          <span
            className="inline-flex items-center gap-1"
            aria-label={t('statUpvotesAria', { count: card.stats.upvotes })}
          >
            <ChevronUp className="h-4 w-4 text-(--el-accent)" aria-hidden />
            {card.stats.upvotes}
          </span>
          <span
            className="inline-flex items-center gap-1 text-(--el-text-muted)"
            aria-label={age ? t('statActivityAria', { time: age }) : t('statActivityNone')}
          >
            <Activity className="h-4 w-4 text-(--el-success)" aria-hidden />
            {age ?? '—'}
          </span>
          <ArrowRight
            className="ml-auto h-4 w-4 text-(--el-text-faint) transition-colors group-hover:text-(--el-link)"
            aria-hidden
          />
        </div>
      </Link>
    </article>
  );
}
