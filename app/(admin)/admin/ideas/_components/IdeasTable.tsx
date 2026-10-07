import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ChevronRight } from 'lucide-react';
import type { StaffIdeaDto } from '@/lib/dto/ideas';
import { IdeaKindPill, IdeaStatusPill, IdeaTagChip } from './IdeaBits';

/**
 * The IDEAS table — design § Ideas Panels 1, 2d and 11. A real `<table>` from
 * the `md` breakpoint up; below it, one stacked row per idea (title + status;
 * slug; kind · category · added), because seven columns do not survive a
 * phone. Only one of the two is ever displayed, so the hidden one is out of the
 * accessibility tree and a row's link is named once.
 *
 * Each row opens the detail through a link whose accessible name is the idea's
 * title, stretched over the row so the whole row is the target. A retired row
 * carries its retirement under the title, so Status → Retired answers "why"
 * without opening every row.
 */

const MAX_TAGS = 3;

export async function IdeasTable({ ideas }: { ideas: StaffIdeaDto[] }) {
  const t = await getTranslations('platformAdmin.ideas');
  const format = await getFormatter();
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });

  const retiredLine = (idea: StaffIdeaDto) =>
    idea.status === 'retired' && idea.retiredAt ? (
      <span className="text-xs text-(--el-text-secondary)">
        {t('retiredLine', { date: date(idea.retiredAt), reason: idea.retiredReason ?? '' })}
      </span>
    ) : null;

  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table data-testid="ideas-table" className="w-full border-collapse font-sans text-sm">
          <thead>
            <tr className="border-b border-(--el-border) text-left">
              <Th>{t('col.idea')}</Th>
              <Th>{t('col.kind')}</Th>
              <Th>{t('col.category')}</Th>
              <Th>{t('col.tags')}</Th>
              <Th>{t('col.status')}</Th>
              <Th>{t('col.added')}</Th>
              <th aria-hidden className="w-6" />
            </tr>
          </thead>
          <tbody>
            {ideas.map((idea) => (
              <tr
                key={idea.id}
                data-testid={`idea-row-${idea.slug}`}
                className="relative border-b border-(--el-border-soft) last:border-b-0 hover:bg-(--el-surface-soft)"
              >
                <Td className="max-w-[26rem]">
                  <div className="flex flex-col gap-1">
                    <Link
                      href={`/admin/ideas/${idea.slug}`}
                      className="text-(--el-text) after:absolute after:inset-0 after:content-['']"
                    >
                      {idea.title}
                    </Link>
                    <code className="font-mono text-xs text-(--el-text-identifier)">
                      {idea.slug}
                    </code>
                    {retiredLine(idea)}
                  </div>
                </Td>
                <Td>
                  <IdeaKindPill kind={idea.kind} />
                </Td>
                <Td className="text-(--el-text)">{idea.category.label}</Td>
                <Td>
                  <TagCell idea={idea} more={(n) => t('moreTags', { n })} />
                </Td>
                <Td>
                  <IdeaStatusPill status={idea.status} />
                </Td>
                <Td className="whitespace-nowrap text-(--el-text-secondary)">
                  {date(idea.addedAt)}
                </Td>
                <Td>
                  <ChevronRight aria-hidden className="h-4 w-4 text-(--el-text-secondary)" />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul data-testid="ideas-list-narrow" className="flex flex-col md:hidden">
        {ideas.map((idea) => (
          <li
            key={idea.id}
            className="relative flex flex-col gap-1 border-b border-(--el-border-soft) py-3 font-sans text-sm last:border-b-0"
          >
            <div className="flex items-start justify-between gap-2">
              <Link
                href={`/admin/ideas/${idea.slug}`}
                className="text-(--el-text) after:absolute after:inset-0 after:content-['']"
              >
                {idea.title}
              </Link>
              <IdeaStatusPill status={idea.status} />
            </div>
            <code className="font-mono text-xs text-(--el-text-identifier)">{idea.slug}</code>
            <span className="text-xs text-(--el-text-secondary)">
              {t(`kind.${idea.kind}`)} · {idea.category.label} · {date(idea.addedAt)}
            </span>
            {retiredLine(idea)}
          </li>
        ))}
      </ul>
    </>
  );
}

function TagCell({ idea, more }: { idea: StaffIdeaDto; more: (n: number) => string }) {
  if (idea.tags.length === 0) return null;
  const shown = idea.tags.slice(0, MAX_TAGS);
  const rest = idea.tags.length - shown.length;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((tag) => (
        <IdeaTagChip key={tag.slug} tag={tag} />
      ))}
      {rest > 0 ? (
        <span className="font-sans text-xs text-(--el-text-secondary)">{more(rest)}</span>
      ) : null}
    </span>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="py-2 pr-4 font-sans text-xs font-medium uppercase tracking-wide text-(--el-text-secondary)">
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`py-3 pr-4 align-top ${className}`}>{children}</td>;
}
