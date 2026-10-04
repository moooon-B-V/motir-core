import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ChevronRight } from 'lucide-react';
import type { PlatformLessonRowDTO } from '@/lib/dto/platformLessons';
import { LessonInjectionCell, LessonOwnerCell, LessonTypePill } from './LessonBits';

/**
 * The LESSONS table — design Panel 1. A real `<table>`; each row opens the
 * detail through a link whose accessible name is the lesson's title, stretched
 * over the row so the whole row is the target.
 */
export async function LessonsTable({
  rows,
  retentionDays,
}: {
  rows: PlatformLessonRowDTO[];
  retentionDays: number;
}) {
  const t = await getTranslations('platformAdmin.lessons');
  const format = await getFormatter();
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] border-collapse font-sans text-sm">
        <thead>
          <tr className="border-b border-(--el-border) text-left">
            <Th>{t('col.lesson')}</Th>
            <Th>{t('col.type')}</Th>
            <Th>{t('col.owner')}</Th>
            <Th>{t('col.injection')}</Th>
            <Th>{t('col.recurred')}</Th>
            <th aria-hidden className="w-6" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              data-testid={`lesson-row-${row.id}`}
              className="relative border-b border-(--el-border-soft) last:border-b-0 hover:bg-(--el-surface-soft)"
            >
              <Td className="max-w-[24rem]">
                <div className="flex flex-col gap-1">
                  <Link
                    href={`/admin/planning-lessons/${row.id}`}
                    className="text-(--el-text) after:absolute after:inset-0 after:content-['']"
                  >
                    {row.title}
                  </Link>
                  {row.categories.length > 0 ? (
                    <span className="flex flex-wrap gap-1">
                      {row.categories.map((c) => (
                        <code
                          key={c}
                          className="rounded-(--radius-badge) bg-(--el-surface) px-(--spacing-chip-x) font-mono text-xs text-(--el-text-identifier)"
                        >
                          {c}
                        </code>
                      ))}
                    </span>
                  ) : null}
                </div>
              </Td>
              <Td>
                <LessonTypePill mistakeType={row.mistakeType} />
              </Td>
              <Td>
                <LessonOwnerCell owner={row.owner} />
              </Td>
              <Td>
                <LessonInjectionCell state={row.injection} retentionDays={retentionDays} />
              </Td>
              <Td>
                <div className="flex flex-col gap-0.5">
                  <span className="text-(--el-text)">{t('recur', { n: row.recurrenceCount })}</span>
                  <span className="text-xs text-(--el-text-secondary)">
                    {t('recurLast', {
                      when: format.dateTime(new Date(row.lastOccurredAt), { dateStyle: 'medium' }),
                    })}
                  </span>
                </div>
              </Td>
              <Td>
                <ChevronRight aria-hidden className="h-4 w-4 text-(--el-text-secondary)" />
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
