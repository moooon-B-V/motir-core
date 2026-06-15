'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { cn } from '@/lib/utils/cn';
import type {
  PublicRoadmapBucketKey,
  PublicRoadmapCardDto,
  PublicRoadmapColumnDto,
  PublicRoadmapColumnPageDto,
} from '@/lib/dto/publicProjects';
import { PublicRoadmapVote } from './PublicRoadmapVote';

// The PUBLIC ROADMAP (Story 6.12 · Subtask 6.12.7 · design Panel 3) — four
// status-grouped, vote-counted columns (Submitted → Planned → In progress →
// Done) of a public project's public-facing items, over the 6.12.4 public
// projection. Client island: it renders the SSR'd first page of every column
// (so the cards are in the crawlable HTML — SEO/GEO) and lazily pages each
// column via GET /api/public/p/[identifier]/roadmap (per-column, never load-all —
// the at-scale rule). The only interactive elements are the upvote controls; the
// projection guarantees no internal field is present to leak.
//
// Card title links: a PROMOTED card (planned / in progress / done) exists on the
// public Work items tab, so its title links to that tab's anchor (the same
// target the public board card uses — there is no public request DETAIL route
// yet; that surface, design Panel 5, is unbuilt). A SUBMITTED card is a
// still-in-triage request that is NOT on the Work items tab, so its title is
// plain text (no dead link) — only its upvote is interactive.

const BUCKET_LABEL: Record<PublicRoadmapBucketKey, string> = {
  submitted: 'roadmapSubmitted',
  planned: 'roadmapPlanned',
  in_progress: 'roadmapInProgress',
  done: 'roadmapDone',
};

const BUCKET_HEAD_TINT: Record<PublicRoadmapBucketKey, string> = {
  submitted: 'bg-(--el-roadmap-submitted)',
  planned: 'bg-(--el-roadmap-planned)',
  in_progress: 'bg-(--el-roadmap-progress)',
  done: 'bg-(--el-roadmap-done)',
};

const KIND_LABEL: Record<PublicRoadmapCardDto['kind'], string> = {
  epic: 'kindEpic',
  story: 'kindStory',
  task: 'kindFeature',
  bug: 'kindBug',
  subtask: 'kindSubtask',
};

function RoadmapCard({
  card,
  bucket,
  identifier,
  signedIn,
}: {
  card: PublicRoadmapCardDto;
  bucket: PublicRoadmapBucketKey;
  identifier: string;
  signedIn: boolean;
}) {
  const t = useTranslations('publicProjects');
  // The title link target: a promoted card lives on the Work items tab; a
  // submitted (still-in-triage) request does not, so it stays plain text.
  const href =
    bucket === 'submitted' ? null : `/p/${encodeURIComponent(identifier)}/items#${card.identifier}`;
  const titleClass = 'block text-[13px] font-semibold leading-snug text-(--el-text)';

  return (
    <article className="flex gap-2.5 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) p-3 shadow-(--shadow-subtle) transition-colors hover:border-(--el-border-strong)">
      <PublicRoadmapVote
        requestId={card.id}
        initialVoted={card.voted}
        initialCount={card.voteCount}
        signedIn={signedIn}
      />
      <div className="min-w-0 flex-1">
        {href ? (
          <Link href={href} className={cn(titleClass, 'hover:text-(--el-link)')}>
            {card.title}
          </Link>
        ) : (
          <span className={titleClass}>{card.title}</span>
        )}
        <span className="mt-1.5 inline-flex items-center gap-1.5 text-[11.5px] text-(--el-text-muted)">
          <IssueTypeIcon type={card.kind} className="h-[13px] w-[13px]" />
          {t(KIND_LABEL[card.kind])}
        </span>
      </div>
    </article>
  );
}

function RoadmapColumn({
  column,
  identifier,
  signedIn,
  onLoadMore,
  loading,
}: {
  column: PublicRoadmapColumnDto;
  identifier: string;
  signedIn: boolean;
  onLoadMore: (bucket: PublicRoadmapBucketKey) => void;
  loading: boolean;
}) {
  const t = useTranslations('publicProjects');
  const remaining = Math.max(0, column.totalCount - column.cards.length);

  return (
    <section className="flex min-w-0 flex-col">
      <header
        className={cn(
          'flex items-center gap-2 rounded-t-(--radius-card) px-3 py-2 text-[12.5px] font-bold text-(--el-text-strong)',
          BUCKET_HEAD_TINT[column.key],
        )}
      >
        <span>{t(BUCKET_LABEL[column.key])}</span>
        <span className="ml-auto text-[11.5px] font-semibold text-(--el-text-secondary)">
          {column.totalCount}
        </span>
      </header>
      <div className="flex min-h-[220px] flex-1 flex-col gap-2.5 rounded-b-(--radius-card) border border-t-0 border-(--el-border) bg-(--el-surface-soft) p-2.5">
        {column.cards.length === 0 ? (
          <p className="rounded-(--radius-card) border border-dashed border-(--el-border) px-1 py-3.5 text-center text-[12.5px] text-(--el-text-faint)">
            {t('roadmapColEmpty')}
          </p>
        ) : (
          column.cards.map((card) => (
            <RoadmapCard
              key={card.id}
              card={card}
              bucket={column.key}
              identifier={identifier}
              signedIn={signedIn}
            />
          ))
        )}
        {column.nextCursor ? (
          <button
            type="button"
            onClick={() => onLoadMore(column.key)}
            disabled={loading}
            className="mt-0.5 self-start px-1 py-1.5 text-left text-[12px] font-semibold text-(--el-link) hover:text-(--el-link-pressed) disabled:opacity-60"
          >
            {loading ? t('loadingMore') : t('roadmapLoadMoreCount', { count: remaining })}
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function PublicRoadmap({
  identifier,
  initialColumns,
  signedIn,
}: {
  identifier: string;
  initialColumns: PublicRoadmapColumnDto[];
  signedIn: boolean;
}) {
  const [columns, setColumns] = useState(initialColumns);
  const [loadingBucket, setLoadingBucket] = useState<PublicRoadmapBucketKey | null>(null);

  const loadMore = useCallback(
    async (bucket: PublicRoadmapBucketKey) => {
      const column = columns.find((c) => c.key === bucket);
      if (!column?.nextCursor || loadingBucket) return;
      setLoadingBucket(bucket);
      try {
        const url = `/api/public/p/${encodeURIComponent(identifier)}/roadmap?bucket=${bucket}&cursor=${encodeURIComponent(
          column.nextCursor,
        )}`;
        const res = await fetch(url);
        if (!res.ok) return;
        const page: PublicRoadmapColumnPageDto = await res.json();
        setColumns((prev) =>
          prev.map((c) =>
            c.key === bucket
              ? { ...c, cards: [...c.cards, ...page.cards], nextCursor: page.nextCursor }
              : c,
          ),
        );
      } finally {
        setLoadingBucket(null);
      }
    },
    [columns, identifier, loadingBucket],
  );

  return (
    <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
      {columns.map((column) => (
        <RoadmapColumn
          key={column.key}
          column={column}
          identifier={identifier}
          signedIn={signedIn}
          onLoadMore={loadMore}
          loading={loadingBucket === column.key}
        />
      ))}
    </div>
  );
}
