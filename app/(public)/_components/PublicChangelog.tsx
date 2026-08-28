'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import type { PublicChangelogEntryDto } from '@/lib/dto/publicProjects';
import type { WorkItemKindDto } from '@/lib/dto/workItems';

// The public CHANGELOG list (Story 8.9 · Subtask 8.9.4 · design
// `design/public-projects/public-changelog.mock.html` Panel B).
//
// A client island for ONE reason: the "Load more" pager. The FIRST page is
// server-rendered into this component's props by the page, so the crawlable HTML
// carries real entries — the same split the Roadmap and Work-items tabs use, and
// the reason neither of them fetches its first page in an effect.
//
// ⚠️ DATES ARE ABSOLUTE, AND THAT IS A DELIBERATE DIVERGENCE FROM THE MOCK,
// which draws "2 hours ago" per entry. A relative timestamp rendered on the
// server and re-computed at hydration is the shipped `relativeTime` hydration
// trap: the two renders disagree the moment a minute boundary falls between
// them, and React logs a mismatch on a page whose whole job is to be crawlable.
// The day HEADING carries the date instead — as a real `<time dateTime>`, which
// is also what a machine reading this page wants — and the per-entry slot is
// dropped rather than filled with a redundant second copy of it.

/** Group entries by calendar day (UTC), preserving the server's ordering. */
function groupByDay(entries: PublicChangelogEntryDto[]): Array<{
  day: string;
  entries: PublicChangelogEntryDto[];
}> {
  const groups: Array<{ day: string; entries: PublicChangelogEntryDto[] }> = [];
  for (const entry of entries) {
    // The ISO date part IS the UTC day, with no parsing and no timezone guess.
    const day = entry.shippedAt.slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.entries.push(entry);
    else groups.push({ day, entries: [entry] });
  }
  return groups;
}

/**
 * Format a `YYYY-MM-DD` day as a heading.
 *
 * Pinned to a fixed locale and to UTC so the server render and the hydrated
 * render produce the same string — the locale and the zone are the two inputs
 * that would otherwise differ between them, and a mismatch on either is the
 * same hydration error a relative timestamp would have caused.
 *
 * `en-GB` rather than `en`, deliberately: `en` resolves to `en-US`, which
 * formats "August 26, 2026", and the design asset draws the day-first
 * "26 August 2026". The heading is prose for a reader; the machine-readable
 * form is the `dateTime` attribute beside it, which is ISO either way.
 */
function formatDay(day: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00.000Z`));
}

export function PublicChangelog({
  identifier,
  initialEntries,
  initialCursor,
}: {
  identifier: string;
  initialEntries: PublicChangelogEntryDto[];
  initialCursor: string | null;
}) {
  const t = useTranslations('publicProjects');
  const [entries, setEntries] = useState(initialEntries);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const loadMore = useCallback(async () => {
    if (!cursor || loading) return;
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch(
        `/api/public/p/${encodeURIComponent(identifier)}/changelog?cursor=${encodeURIComponent(cursor)}`,
      );
      if (!res.ok) throw new Error(`changelog page failed: ${res.status}`);
      const page = (await res.json()) as {
        entries: PublicChangelogEntryDto[];
        nextCursor: string | null;
      };
      // APPEND rather than replace: the cursor is a seek-after position, so a
      // page can never overlap the one before it.
      setEntries((prev) => [...prev, ...page.entries]);
      setCursor(page.nextCursor);
    } catch {
      // A failed page leaves the entries already on screen alone and offers a
      // retry — losing them would punish the reader for our error.
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [cursor, identifier, loading]);

  const groups = groupByDay(entries);

  return (
    <div>
      {groups.map((group) => (
        <section key={group.day} className="mb-2">
          <h2 className="mt-5 mb-2.5 flex items-center gap-3 first:mt-1">
            <time
              dateTime={group.day}
              className="flex-none text-[12px] font-bold tracking-[0.04em] text-(--el-text-secondary) uppercase"
            >
              {formatDay(group.day)}
            </time>
            <span className="h-px flex-1 bg-(--el-border-soft)" aria-hidden />
          </h2>
          <ul className="list-none">
            {group.entries.map((entry) => (
              <li key={entry.identifier} className="mb-2">
                <Link
                  href={`/p/${encodeURIComponent(identifier)}/items/${encodeURIComponent(entry.identifier)}`}
                  className="flex items-start gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) p-3 transition-colors hover:border-(--el-border-strong)"
                >
                  <span className="mt-px flex h-6.5 w-6.5 flex-none items-center justify-center rounded-(--radius-control) bg-(--el-muted)">
                    <IssueTypeIcon type={entry.kind as WorkItemKindDto} className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] leading-snug font-semibold text-(--el-text)">
                      {entry.title}
                    </span>
                    <span className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[11.5px] text-(--el-text-secondary)">
                        {entry.identifier}
                      </span>
                      {entry.epic ? <Pill tone="neutral">{entry.epic.title}</Pill> : null}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {failed ? (
        <div
          role="alert"
          className="mt-3.5 flex items-start gap-2.5 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) p-3.5"
        >
          <AlertTriangle
            className="mt-px h-4 w-4 flex-none text-(--el-danger-on-surface)"
            aria-hidden
          />
          <span className="text-[12.5px] leading-relaxed text-(--el-text-secondary)">
            <span className="font-semibold text-(--el-text)">{t('changelogErrorTitle')}</span>{' '}
            {t('changelogErrorBody')}
          </span>
        </div>
      ) : null}

      {cursor ? (
        <div className="mt-3.5 flex justify-center">
          <Button variant="secondary" onClick={loadMore} disabled={loading}>
            {loading ? t('changelogLoading') : t('changelogLoadMore')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
