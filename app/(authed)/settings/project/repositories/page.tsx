import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Pause } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectRepoRoomService } from '@/lib/services/projectRepoRoomService';
import { EmptyState } from '@/components/ui/EmptyState';
import { RepositoriesRoom } from './_components/RepositoriesRoom';
import type { ProjectRepoDto } from '@/lib/dto/projectRepos';

// THE TAKE-IT-OVER ROOM (Story MOTIR-1775 · MOTIR-1939) — the surface behind the
// ownership promise's `How moving it works` door, the billing panel's
// `Move repositories` button, and the project-settings `Repositories` rail row.
// Layout source of truth: `design/repository-set/takeover.mock.html` §14.
//
// A SERVER component over a client island, split along the page-state contract:
// the header summary and the paused banner are server-rendered so
// `router.refresh()` updates them after a takeover, while the ROWS are a client
// island with its own refetch (which `router.refresh()` provably cannot reach).
// Getting that split wrong is the recurring bug the contract exists to stop.
//
// ⚠️ THE ORG→PROJECT SCOPE GAP IS DRAWN, NOT PAPERED OVER. The billing door is
// org-scoped while a takeover is per ROW, so the banner names the OTHER projects
// Motir still hosts, each a link, and says that moving this project's
// repositories does not move theirs (§14.4).

export default async function ProjectRepositoriesPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('repositoryTakeover');
  const ts = await getTranslations('settings');

  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <div className="mx-auto max-w-[46rem]">
        <EmptyState title={ts('project.empty.title')} description={t('empty')} />
      </div>
    );
  }

  const view = await projectRepoRoomService.getRoomView(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });

  // ONE timestamp for the whole render, threaded into the rows: `Date.now()` in
  // a client render would disagree with the server's by the round-trip and the
  // "days later" copy would hydrate differently — this repo's known relative-time
  // hydration-flake class, avoided at the root rather than patched at the leaf.
  const nowIso = new Date().toISOString();
  const counts = summarize(view.rows);

  return (
    <div className="mx-auto flex max-w-[46rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">{t('title')}</h1>
        <p className="font-sans text-sm text-(--el-text-muted)">
          {t('lead', { projectName: ctx.project.name })}
        </p>
        {view.rows.length > 0 ? (
          <p className="font-sans text-sm text-(--el-text-helper)">{t('summary', counts)}</p>
        ) : null}
      </header>

      {view.ciPaused ? (
        <div
          role="status"
          className="flex gap-3 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-warning-surface) p-(--spacing-card-padding)"
        >
          <Pause className="mt-0.5 size-5 shrink-0 text-(--el-warning)" aria-hidden="true" />
          <div className="flex min-w-0 flex-col gap-1 text-sm leading-relaxed text-(--el-warning-text)">
            <p className="min-w-0">
              <span className="font-semibold">{t('pausedTitle')}</span> {t('pausedBody')}
            </p>
            {view.otherHostedProjects.length > 0 ? (
              <p className="min-w-0">
                {t.rich('pausedOtherProjects', {
                  projects: () => (
                    <>
                      {view.otherHostedProjects.map((project, index) => (
                        <span key={project.id}>
                          {index > 0 ? ', ' : null}
                          <Link
                            href={`/projects/${project.identifier}`}
                            className="font-medium text-(--el-link) hover:text-(--el-link-pressed)"
                          >
                            {project.name}
                          </Link>
                        </span>
                      ))}
                    </>
                  ),
                })}
              </p>
            ) : null}
            <p className="min-w-0">
              <Link
                href="/settings/organization/billing"
                className="font-medium text-(--el-link) hover:text-(--el-link-pressed)"
              >
                {t('addCreditsInstead')}
              </Link>
            </p>
          </div>
        </div>
      ) : null}

      <RepositoriesRoom
        projectKey={ctx.project.identifier}
        view={view}
        connectHref="/settings/workspace/github"
        nowIso={nowIso}
      />
    </div>
  );
}

/**
 * The header's count of the truth — `{moving} moving · {hosted} hosted by Motir ·
 * {yours} yours`.
 *
 * Three ownerships in one set are LEGAL AT ONCE (MOTIR-711's per-row rule at set
 * scale), so the summary counts them separately rather than implying the whole
 * project is "moving" because one row is.
 */
function summarize(rows: ProjectRepoDto[]): {
  moving: number;
  hosted: number;
  yours: number;
} {
  let moving = 0;
  let hosted = 0;
  let yours = 0;
  for (const row of rows) {
    const takeover = row.takeover?.state ?? null;
    if (takeover && takeover !== 'done' && takeover !== 'failed') moving += 1;
    else if (takeover === 'done' || row.state === 'connected') yours += 1;
    else if (row.state === 'created') hosted += 1;
  }
  return { moving, hosted, yours };
}
