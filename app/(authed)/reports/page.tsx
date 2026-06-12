import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { TrendingDown, BarChart3, ListTree, TrendingUp, PieChart, Plus } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { sprintsService } from '@/lib/services/sprintsService';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/lib/utils/cn';

// The project Reports hub (Story 6.3 · Subtask 6.3.6) — the grouped index the
// sidebar "Reports" link opens, replacing the Epic-6 stub. Per
// design/reports/dashboard.mock.html panel 6: an AGILE group whose cards LINK
// into the already-shipped 4.4–4.6 surfaces (burndown / velocity / sprint
// report — referenced, never redrawn) + an ANALYSIS group opening the two
// report pages this story builds. Server Component (services only — 4-layer):
// it resolves the active project + the sprint the agile cards deep-link to.

export default async function ReportsPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('reports');
  const ctx = await getActiveProject();

  if (!ctx) {
    return (
      <div className="flex flex-col gap-6">
        <Header title={t('hub.title')} subtitle={t('hub.subtitle')} />
        <EmptyState title={t('hub.noProjectTitle')} description={t('hub.noProjectBody')} />
      </div>
    );
  }

  if (ctx.project.archivedAt) {
    const ts = await getTranslations('shell');
    return (
      <div className="flex flex-col gap-6">
        <Header title={t('hub.title')} subtitle={t('hub.subtitle')} />
        <EmptyState title={ts('stub.archivedTitle')} description={ts('stub.archivedDescription')} />
      </div>
    );
  }

  // The agile reports all live in the SPRINT REPORT (the 4.4.6 surface that
  // mounts the 4.6.5 burndown + 4.6.6 velocity). Deep-link to the current
  // sprint's report — the active sprint, else the most recently completed; with
  // no sprints yet, fall back to the backlog (where sprints are created).
  const sprints = await sprintsService.listByProject(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  const current =
    sprints.find((s) => s.state === 'active') ??
    sprints.filter((s) => s.state === 'complete').at(-1) ??
    null;
  const agileHref = current ? `/sprints/${current.id}/report` : '/backlog';

  return (
    <div className="flex flex-col gap-6">
      <Header title={t('hub.title')} subtitle={t('hub.subtitle')} />

      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-semibold tracking-wide text-(--el-text-muted) uppercase">
          {t('hub.agileGroup')}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <HubCard
            href={agileHref}
            muted
            icon={<TrendingDown className="h-5 w-5" aria-hidden />}
            title={t('hub.burndownTitle')}
            body={t('hub.burndownBody')}
          />
          <HubCard
            href={agileHref}
            muted
            icon={<BarChart3 className="h-5 w-5" aria-hidden />}
            title={t('hub.velocityTitle')}
            body={t('hub.velocityBody')}
          />
          <HubCard
            href={agileHref}
            muted
            icon={<ListTree className="h-5 w-5" aria-hidden />}
            title={t('hub.sprintReportTitle')}
            body={t('hub.sprintReportBody')}
          />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-semibold tracking-wide text-(--el-text-muted) uppercase">
          {t('hub.analysisGroup')}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <HubCard
            href="/reports/created-vs-resolved"
            icon={<TrendingUp className="h-5 w-5" aria-hidden />}
            title={t('hub.createdVsResolvedTitle')}
            body={t('hub.createdVsResolvedBody')}
          />
          <HubCard
            href="/reports/distribution"
            icon={<PieChart className="h-5 w-5" aria-hidden />}
            title={t('hub.distributionTitle')}
            body={t('hub.distributionBody')}
          />
          <HubCardDisabled
            icon={<Plus className="h-5 w-5" aria-hidden />}
            title={t('hub.moreTitle')}
            tag={t('hub.extensionTag')}
            body={t('hub.moreBody')}
          />
        </div>
      </section>
    </div>
  );
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="flex flex-col gap-1">
      <h1 className="flex items-center gap-2 font-serif text-2xl font-semibold text-(--el-text)">
        <BarChart3 className="h-6 w-6 text-(--el-text-secondary)" aria-hidden />
        {title}
      </h1>
      <p className="text-sm text-(--el-text-muted)">{subtitle}</p>
    </header>
  );
}

// A clickable hub card. Card (`components/ui/Card`) renders a <div role=button>
// and is not polymorphic to an <a>, so a navigation card composes the same card
// shape tokens onto a real <Link> — the semantically-correct element here.
function HubCard({
  href,
  icon,
  title,
  body,
  muted,
}: {
  href: string;
  icon: ReactNode;
  title: string;
  body: string;
  muted?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'group flex items-start gap-3 rounded-(--radius-card) border border-(--el-border) p-(--spacing-card-padding) transition-shadow',
        'hover:shadow-(--shadow-card) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:ring-offset-2 focus-visible:ring-offset-(--el-page-bg) focus-visible:outline-none',
        muted ? 'bg-(--el-surface-soft)' : 'bg-(--el-page-bg)',
      )}
    >
      <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-surface) text-(--el-text-secondary)">
        {icon}
      </span>
      <span className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-(--el-text)">{title}</span>
        <span className="text-xs text-(--el-text-muted)">{body}</span>
      </span>
    </Link>
  );
}

function HubCardDisabled({
  icon,
  title,
  tag,
  body,
}: {
  icon: ReactNode;
  title: string;
  tag: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-(--radius-card) border border-dashed border-(--el-border) p-(--spacing-card-padding) opacity-60">
      <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-surface) text-(--el-text-faint)">
        {icon}
      </span>
      <span className="flex flex-col gap-1">
        <span className="flex items-center gap-2 text-sm font-semibold text-(--el-text-secondary)">
          {title}
          <span className="rounded-(--radius-badge) bg-(--el-surface) px-(--spacing-chip-x) py-(--spacing-chip-y) text-[10px] font-medium tracking-wide text-(--el-text-muted) uppercase">
            {tag}
          </span>
        </span>
        <span className="text-xs text-(--el-text-muted)">{body}</span>
      </span>
    </div>
  );
}
