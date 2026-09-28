'use client';

import { useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Eye } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { personDisplayName } from '@/lib/people/personLabel';
import type { ProjectVisitorDTO, ProjectVisitorsPageDTO } from '@/lib/dto/visitors';

// The project's VISITORS, for its Managers (Story MOTIR-6170 · MOTIR-6667; the
// approved design MOTIR-6641, `design/projects/access-members--visitors.mock.html`
// panels V1–V3). The one surface in the product that shows a Visitor's email.
//
// It is only ever MOUNTED for a reader holding `project:manage_access` on a
// PUBLIC project — the page decides that, and the service refuses the read to
// anyone else, so this card never has to hide anything. Read-only: a visitor is
// not a member, and nothing here grants access.
//
// The first page arrives server-rendered; Show more fetches the next through
// `GET /api/projects/[key]/visitors` and APPENDS it (a lazy load — the page-state
// rule's case 3, an island that owns its own list).

interface ProjectVisitorsCardProps {
  projectKey: string;
  workspaceName: string;
  initialPage: ProjectVisitorsPageDTO;
}

export function ProjectVisitorsCard({
  projectKey,
  workspaceName,
  initialPage,
}: ProjectVisitorsCardProps) {
  const t = useTranslations('settings.access.visitors');
  const tc = useTranslations('common');
  const formatWhen = useVisitDate();
  const [visitors, setVisitors] = useState<ProjectVisitorDTO[]>(initialPage.visitors);
  const [cursor, setCursor] = useState<string | null>(initialPage.nextCursor);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // Guards a Show more pressed twice before the first answer lands.
  const inFlight = useRef(false);

  async function showMore() {
    if (!cursor || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectKey)}/visitors?cursor=${encodeURIComponent(cursor)}`,
      );
      if (!res.ok) throw new Error(`visitors page: ${res.status}`);
      const page = (await res.json()) as ProjectVisitorsPageDTO;
      setVisitors((prev) => [...prev, ...page.visitors]);
      setCursor(page.nextCursor);
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  return (
    <Card
      header={
        <div className="flex items-center gap-2">
          <h2 className="font-sans text-base font-semibold text-(--el-text)">{t('heading')}</h2>
          <Pill tone="neutral" aria-label={t('countLabel', { count: initialPage.total })}>
            <Eye className="size-3" aria-hidden />
            {initialPage.total}
          </Pill>
        </div>
      }
    >
      <p className="text-(--el-text-secondary) mb-3 font-sans text-xs">
        {t('subtitle', { workspace: workspaceName })}
      </p>

      {visitors.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 px-3 pt-7 pb-3 text-center">
          <p className="font-serif text-base font-semibold text-(--el-text)">{t('emptyTitle')}</p>
          <p className="text-(--el-text-secondary) max-w-[26rem] font-sans text-sm">
            {t('emptyBody', { workspace: workspaceName })}
          </p>
        </div>
      ) : (
        <>
          <ul role="list" className="flex flex-col" data-testid="project-visitors">
            {visitors.map((visitor) => {
              const name = personDisplayName(visitor, tc('personFallback'));
              const named = visitor.name.trim().length > 0;
              return (
                <li
                  key={`${visitor.email}|${visitor.consentedAt}`}
                  className="border-(--el-border-soft) flex items-start gap-3 border-b py-3 last:border-b-0"
                >
                  <span
                    className={
                      named
                        ? 'bg-(--el-text) text-(--el-text-inverted) inline-flex size-8 shrink-0 items-center justify-center rounded-full font-sans text-xs font-semibold'
                        : 'bg-(--el-tint-lavender) text-(--el-text-strong) inline-flex size-8 shrink-0 items-center justify-center rounded-full font-sans text-xs font-semibold'
                    }
                    aria-hidden
                  >
                    {named ? name.charAt(0).toUpperCase() : initialsOf(name)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-sans text-sm font-medium text-(--el-text)">
                      {name}
                    </p>
                    {/* The email as plain, selectable text — a Manager copies it. */}
                    <p className="text-(--el-text-secondary) truncate font-sans text-xs select-text">
                      {visitor.email}
                    </p>
                    <p className="text-(--el-text-secondary) mt-0.5 flex flex-wrap gap-x-3.5 gap-y-1 font-sans text-xs">
                      <VisitDate
                        label={t('firstVisit')}
                        iso={visitor.firstVisitAt}
                        format={formatWhen}
                      />
                      <VisitDate
                        label={t('latestVisit')}
                        iso={visitor.lastVisitAt}
                        format={formatWhen}
                      />
                      <VisitDate
                        label={t('agreed')}
                        iso={visitor.consentedAt}
                        format={formatWhen}
                      />
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
          {cursor || failed ? (
            <div className="border-(--el-border-soft) flex flex-col items-center gap-2 border-t pt-3">
              {failed ? (
                <p role="alert" className="text-(--el-danger-on-surface) font-sans text-xs">
                  {t('loadFailed')}
                </p>
              ) : null}
              {cursor ? (
                <Button variant="secondary" size="sm" loading={loading} onClick={showMore}>
                  {t('showMore')}
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

function VisitDate({
  label,
  iso,
  format,
}: {
  label: string;
  iso: string;
  format: (iso: string) => { short: string; full: string };
}) {
  const { short, full } = format(iso);
  return (
    <span>
      {label}{' '}
      <time dateTime={iso} title={full} className="font-medium text-(--el-text)">
        {short}
      </time>
    </span>
  );
}

/** Two letters of the neutral label, for the no-name avatar ("Project member" → "PM"). */
function initialsOf(label: string): string {
  const letters = label
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase());
  return letters.slice(0, 2).join('') || label.slice(0, 2);
}

/**
 * A visit time the way the design draws it: relative while it is recent ("2 hours
 * ago", "yesterday"), the date after that ("12 Sep"), and the full date and time
 * in the `title` either way.
 */
function useVisitDate(): (iso: string) => { short: string; full: string } {
  const locale = useLocale();
  return (iso: string) => {
    const at = new Date(iso);
    const hours = Math.max(0, Math.round((Date.now() - at.getTime()) / 3_600_000));
    const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    const short =
      hours < 24
        ? relative.format(-hours, 'hour')
        : hours < 48
          ? relative.format(-1, 'day')
          : new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(at);
    const full = new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(at);
    return { short, full };
  };
}
