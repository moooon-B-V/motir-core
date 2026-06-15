import { notFound } from 'next/navigation';
import { Info } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { EmptyState } from '@/components/ui/EmptyState';
import { PublicTabNav } from '@/app/(public)/_components/PublicTabNav';
import { PublicWorkItemCard } from '@/app/(public)/_components/PublicWorkItemCard';

// The public read-only BOARD (Story 6.12 · Subtask 6.12.4 · design Panel 2).
// Columns of public-projection cards as an anonymous viewer sees them: NO edit
// affordances (no create / move / assign / status / drag), internal fields
// absent. Bounded by the service cap (the at-scale rule — never load-all); a
// truncation note shows when the board exceeds the cap. Server-rendered.

export default async function PublicBoardPage({
  params,
}: {
  params: Promise<{ identifier: string }>;
}) {
  const { identifier } = await params;
  const session = await getSession();
  const actorUserId = session?.user.id ?? null;

  let board;
  try {
    board = await publicProjectsService.getBoard(identifier, actorUserId);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) notFound();
    throw err;
  }

  const t = await getTranslations('publicProjects');
  const itemsBase = `/p/${encodeURIComponent(identifier)}/items`;

  return (
    <>
      <PublicTabNav identifier={identifier} active="board" />
      <div className="p-(--spacing-card-padding)">
        {board.columns.length === 0 ? (
          <EmptyState title={t('boardEmptyTitle')} description={t('boardEmptyBody')} />
        ) : (
          <>
            <div className="grid auto-cols-[minmax(232px,1fr)] grid-flow-col gap-3.5 overflow-x-auto pb-2">
              {board.columns.map((col) => (
                <section key={col.id} className="flex min-w-0 flex-col">
                  <header className="flex items-center gap-2 px-1 pb-2.5">
                    <h2 className="text-xs font-bold uppercase tracking-wide text-(--el-text-secondary)">
                      {col.name}
                    </h2>
                    <span className="rounded-(--radius-badge) border border-(--el-border) bg-(--el-surface) px-2 py-px text-[11.5px] font-semibold text-(--el-text-faint)">
                      {col.totalCount}
                    </span>
                  </header>
                  <div className="flex flex-col gap-2.5">
                    {col.cards.length === 0 ? (
                      <p className="rounded-(--radius-card) border border-dashed border-(--el-border) px-1 py-3.5 text-center text-[12.5px] text-(--el-text-faint)">
                        {t('boardColumnEmpty')}
                      </p>
                    ) : (
                      col.cards.map((card) => (
                        <PublicWorkItemCard
                          key={card.id}
                          item={card}
                          href={`${itemsBase}/${encodeURIComponent(card.identifier)}`}
                        />
                      ))
                    )}
                  </div>
                </section>
              ))}
            </div>

            {board.truncated ? (
              <p className="mt-4 text-[12.5px] text-(--el-text-muted)">
                {t('boardTruncatedNote', { cap: board.cap })}
              </p>
            ) : null}

            <p className="mt-3 flex items-start gap-2 text-[12px] leading-relaxed text-(--el-text-muted)">
              <Info className="mt-px h-3.5 w-3.5 flex-none text-(--el-info)" aria-hidden />
              {t('boardProjectionNote')}
            </p>
          </>
        )}
      </div>
    </>
  );
}
