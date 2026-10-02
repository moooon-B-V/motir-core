import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { ArrowLeft, Info } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import type { PlatformWorkspacePageDTO } from '@/lib/dto/platform';
import { requirePlatformStaff } from '@/lib/platform/auth';
import { PlatformWorkspaceNotFoundError } from '@/lib/platform/errors';
import { platformOrgPageService } from '@/lib/services/platformOrgPageService';

/**
 * The WORKSPACE PAGE beneath the org — design `console--estate-usage-drilldown.mock.html`
 * **D6** (MOTIR-7295). ← {org} returns to the org page. Tabs: Overview (here) and
 * Usage & cost — the org page's tab with the scope preset to this workspace.
 * Overview: Projects with this month's spend, Members, attributed Recent jobs.
 *
 * One view is ONE audited `estate.read` naming the workspace; a workspace that is
 * not the org's in the URL is a 404 with no audit row.
 */

export const metadata: Metadata = {
  // No description — the console's standing rule (see the landing page).
  title: 'Workspace',
};

export const dynamic = 'force-dynamic';

export default async function AdminWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
  searchParams: Promise<{ members?: string; jobs?: string }>;
}) {
  const principal = await requirePlatformStaff('support');
  const { orgId, workspaceId } = await params;
  const query = await searchParams;
  const jobsStack = (query.jobs ?? '').split(',').filter(Boolean);

  let page: PlatformWorkspacePageDTO;
  try {
    page = await platformOrgPageService.getWorkspacePage(principal, orgId, workspaceId, {
      membersCursor: query.members ?? null,
      jobsCursor: jobsStack.at(-1) ?? null,
    });
  } catch (err) {
    if (err instanceof PlatformWorkspaceNotFoundError) notFound();
    throw err;
  }

  const t = await getTranslations('platformAdmin.workspacePage');
  const to = await getTranslations('platformAdmin.orgPage');
  const tf = await getTranslations('platformAdmin.overview.feed');
  const format = await getFormatter();
  const orgHref = `/admin/tenants/${encodeURIComponent(orgId)}`;
  const usageHref = `${orgHref}?tab=usage&scope=${encodeURIComponent(`workspace:${workspaceId}`)}`;
  const here = (extra: Record<string, string | null>) => {
    const p = new URLSearchParams();
    const merged = { members: query.members ?? null, jobs: jobsStack.join(',') || null, ...extra };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const q = p.toString();
    return `${orgHref}/workspaces/${encodeURIComponent(workspaceId)}${q ? `?${q}` : ''}`;
  };
  const credits = (n: number | null) => (n === null ? '—' : format.number(n));
  const monthLabel = format.dateTime(new Date(`${page.month}-01T00:00:00Z`), {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <Link
        href={orgHref}
        className="inline-flex items-center gap-1 self-start rounded-(--radius-input) px-2 py-1 font-sans text-sm text-(--el-text-secondary) hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
      >
        <ArrowLeft aria-hidden className="h-4 w-4" />
        {page.organization.name}
      </Link>

      <p className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-sky) p-(--spacing-card-padding) font-sans text-xs text-(--el-text-strong)">
        <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-info)" />
        <span>
          {t('auditBanner', {
            org: page.organization.name,
            name: page.workspace.name,
            operator: principal.email,
          })}
        </span>
      </p>

      <div>
        <h1 className="font-serif text-2xl text-(--el-text)">{page.workspace.name}</h1>
        <span className="font-sans text-sm text-(--el-text-secondary)">{page.workspace.slug}</span>
      </div>

      <nav aria-label={t('tabsLabel')} className="flex gap-1 border-b border-(--el-border)">
        <span
          aria-current="page"
          className="-mb-px border-b-2 border-(--el-accent-on-surface) px-3 py-2 font-sans text-sm text-(--el-text)"
        >
          {to('tabs.overview')}
        </span>
        <Link
          href={usageHref}
          className="-mb-px border-b-2 border-transparent px-3 py-2 font-sans text-sm text-(--el-text-secondary) hover:text-(--el-text)"
        >
          {to('tabs.usage')}
        </Link>
      </nav>

      <Card
        header={
          <h2 className="font-sans text-sm font-semibold text-(--el-text)">
            {t('projects.title', { month: monthLabel })}
          </h2>
        }
      >
        {page.projects.length === 0 ? (
          <p className="font-sans text-sm text-(--el-text-secondary)">{t('projects.empty')}</p>
        ) : (
          <table className="w-full font-sans text-sm" data-testid="workspace-projects">
            <thead>
              <tr className="text-left text-xs text-(--el-text-secondary)">
                <th className="py-1 font-medium">{t('projects.name')}</th>
                <th className="py-1 font-medium">{t('projects.key')}</th>
                <th className="py-1 text-right font-medium">{t('projects.planning')}</th>
                <th className="py-1 text-right font-medium">{t('projects.runsAndCi')}</th>
                <th className="py-1 text-right font-medium">{t('projects.charged')}</th>
              </tr>
            </thead>
            <tbody>
              {page.projects.map((p) => (
                <tr key={p.id} className="border-t border-(--el-border)">
                  <td className="py-1 text-(--el-text)">{p.name}</td>
                  <td className="py-1 font-mono text-xs text-(--el-text-secondary)">{p.key}</td>
                  <td className="py-1 text-right tabular-nums">{credits(p.planningCredits)}</td>
                  <td className="py-1 text-right tabular-nums">{credits(p.runsAndCiCredits)}</td>
                  <td className="py-1 text-right font-semibold tabular-nums">
                    {credits(p.chargedCredits)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {page.projectSpendUnavailable ? (
          <p role="status" className="mt-2 font-sans text-xs text-(--el-text-secondary)">
            {t('projects.spendUnavailable')}
          </p>
        ) : null}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card
          header={
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-sans text-sm font-semibold text-(--el-text)">
                {to('members.title')}
              </h2>
              <Pill tone="neutral">{format.number(page.members.total)}</Pill>
            </div>
          }
        >
          {page.members.items.length === 0 ? (
            <p className="font-sans text-sm text-(--el-text-secondary)">{t('members.empty')}</p>
          ) : (
            <ul className="flex flex-col" data-testid="workspace-members">
              {page.members.items.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center justify-between gap-2 border-b border-(--el-border) py-2 last:border-b-0"
                >
                  <span className="min-w-0">
                    <Link
                      href={`/admin/users/${encodeURIComponent(m.userId)}`}
                      className="block truncate font-sans text-sm text-(--el-text) hover:underline"
                    >
                      {m.name ?? m.email}
                    </Link>
                    <span className="block truncate font-sans text-xs text-(--el-text-secondary)">
                      {m.email}
                    </span>
                  </span>
                  <Pill tone="neutral">{t(`members.role.${m.role}`)}</Pill>
                </li>
              ))}
            </ul>
          )}
          {page.members.nextCursor || query.members ? (
            <div className="mt-2 flex gap-3 font-sans text-xs">
              {query.members ? (
                <Link
                  href={here({ members: null })}
                  className="text-(--el-accent-on-surface) hover:underline"
                >
                  {to('members.first')}
                </Link>
              ) : null}
              {page.members.nextCursor ? (
                <Link
                  href={here({ members: page.members.nextCursor })}
                  className="text-(--el-accent-on-surface) hover:underline"
                >
                  {to('members.next')}
                </Link>
              ) : null}
            </div>
          ) : null}
        </Card>

        <Card
          header={
            <h2 className="font-sans text-sm font-semibold text-(--el-text)">{to('jobs.title')}</h2>
          }
        >
          {page.jobs.unavailable ? (
            <p role="status" className="font-sans text-sm text-(--el-text-secondary)">
              {to('jobs.unavailable')}
            </p>
          ) : page.jobs.items.length === 0 ? (
            <p className="font-sans text-sm text-(--el-text-secondary)">{t('jobs.empty')}</p>
          ) : (
            <ul className="flex flex-col" data-testid="workspace-jobs">
              {page.jobs.items.map((job) => (
                <li
                  key={`${job.kind}:${job.id}`}
                  className="flex flex-wrap items-center justify-between gap-2 border-b border-(--el-border) py-2 font-sans text-sm last:border-b-0"
                >
                  <span>
                    {tf(`kind.${job.kind}`)}
                    {job.project ? ` · ${job.project.name}` : ''}
                  </span>
                  <span className="text-xs text-(--el-text-secondary)">
                    {format.dateTime(new Date(job.at), { dateStyle: 'medium', timeStyle: 'short' })}{' '}
                    ·{' '}
                    {tf('runDetail', {
                      model: job.model ?? '—',
                      credits: format.number(job.credits ?? 0),
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {jobsStack.length > 0 || page.jobs.nextCursor ? (
            <div className="mt-2 flex gap-3 font-sans text-xs">
              {jobsStack.length > 0 ? (
                <Link
                  href={here({ jobs: jobsStack.slice(0, -1).join(',') || null })}
                  className="text-(--el-accent-on-surface) hover:underline"
                >
                  {to('jobs.newer')}
                </Link>
              ) : null}
              {page.jobs.nextCursor ? (
                <Link
                  href={here({ jobs: [...jobsStack, page.jobs.nextCursor].join(',') })}
                  className="text-(--el-accent-on-surface) hover:underline"
                >
                  {to('jobs.older')}
                </Link>
              ) : null}
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
