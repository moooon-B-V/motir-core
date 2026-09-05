import Link from 'next/link';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Pause } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectRepoRoomService } from '@/lib/services/projectRepoRoomService';
import { EmptyState } from '@/components/ui/EmptyState';
import { SettingsPaneFrame } from '@/components/settings/SettingsPaneFrame';
import { summarizeRepositories } from '@/lib/projectRepos/roomSections';
import { GitConnectBanner } from '@/components/settings/GitConnectBanner';
import { RepositoriesRoom } from './_components/RepositoriesRoom';
import { guardSettingsPage } from '../_guard';

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
// ⚠️ THE HEADER SPEAKS FOR BOTH REGISTRIES (MOTIR-3126). The room renders the
// project's whole repository DOMAIN — the Motir-hosted set AND the
// workspace-connected repositories — so the lead sentence and the summary count
// are computed over both. The old lead ("Motir hosts the repositories it created
// for you") describes something a project with no hosted rows cannot see, so such
// a project gets `leadConnected` instead; a summary read off the set alone would
// report `0 yours` for a project holding four repositories of its own.
//
// ⚠️ THE ORG→PROJECT SCOPE GAP IS DRAWN, NOT PAPERED OVER. The billing door is
// org-scoped while a takeover is per ROW, so the banner names the OTHER projects
// Motir still hosts, each a link, and says that moving this project's
// repositories does not move theirs (§14.4).

// ⚠️ A GIT CONNECT FLOW CAN NOW RETURN HERE (MOTIR-4676). This room is one of
// the surfaces that STARTS a connect (`GITHUB_RETURN_SURFACES.projectRepositories`),
// so it renders the `?github=<status>` outcome exactly as the workspace Git page
// does — through the shared `GitConnectBanner`, which owns the status → tone map
// so the two surfaces cannot disagree about what an outcome means.
interface ProjectRepositoriesPageProps {
  searchParams: Promise<{ github?: string }>;
}

export default async function ProjectRepositoriesPage({
  searchParams,
}: ProjectRepositoriesPageProps) {
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

  // THE DESTINATION GUARD (MOTIR-2469). Hiding is presentation and never
  // protection: this page is still one typed URL away once its rail row is
  // gone. The key comes from the registry entry `repositories`, never re-declared here.
  const refused = await guardSettingsPage('repositories', ctx);
  if (refused) return refused;

  // MOTIR-3558 — allocation row 5: THE FRAME ONLY. One read, so there is nothing
  // to make concurrent.
  //
  // ⚠️ ONLY the <h1> is tier 1 here, and that is the asset's call rather than a
  // convenience: the lead line chooses between two strings on
  // `view.rows.length`, and the summary line renders at all only when the view
  // has something in it. Both are therefore ABOUT the pending read and cannot be
  // painted ahead of it — so the header is SPLIT, with the title above the
  // boundary and its two paragraphs below. Every other pane in this card paints
  // its whole header from the gate.
  const sp = await searchParams;

  return (
    <div className="mx-auto flex max-w-[46rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">{t('title')}</h1>
      </header>

      {/* ABOVE the Suspense boundary, deliberately: the banner is about the round
          trip the reader just took, it needs none of the room read, and a
          confirmation that waits for a database is a confirmation that arrives
          after the reader has started wondering. */}
      <GitConnectBanner status={sp.github} />

      <Suspense fallback={<SettingsPaneFrame />}>
        <RepositoriesPaneBody
          projectId={ctx.projectId}
          projectKey={ctx.project.identifier}
          projectName={ctx.project.name}
          userId={ctx.userId}
          workspaceId={ctx.workspaceId}
        />
      </Suspense>
    </div>
  );
}

/** The room read and everything that depends on it — the lead line, the summary
 *  line, the CI-paused banner and the rows. */
async function RepositoriesPaneBody({
  projectId,
  projectKey,
  projectName,
  userId,
  workspaceId,
}: {
  projectId: string;
  projectKey: string;
  projectName: string;
  userId: string;
  workspaceId: string;
}) {
  const t = await getTranslations('repositoryTakeover');
  const view = await projectRepoRoomService.getRoomView(projectId, { userId, workspaceId });

  // ONE timestamp for the whole render, threaded into the rows: `Date.now()` in
  // a client render would disagree with the server's by the round-trip and the
  // "days later" copy would hydrate differently — this repo's known relative-time
  // hydration-flake class, avoided at the root rather than patched at the leaf.
  const nowIso = new Date().toISOString();
  const counts = summarizeRepositories(view.rows, view.connected);
  const hasAny = view.rows.length > 0 || view.connected.length > 0;

  return (
    <>
      <div className="flex flex-col gap-1">
        <p className="font-sans text-sm text-(--el-text-muted)">
          {view.rows.length > 0 ? t('lead', { projectName }) : t('leadConnected', { projectName })}
        </p>
        {hasAny ? (
          <p className="font-sans text-sm text-(--el-text-helper)">{t('summary', counts)}</p>
        ) : null}
      </div>

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
        projectKey={projectKey}
        view={view}
        connectHref="/settings/workspace/github"
        nowIso={nowIso}
      />
    </>
  );
}
