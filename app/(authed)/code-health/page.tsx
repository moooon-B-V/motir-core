import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Activity } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { NotProjectAdminError, ProjectNotFoundError } from '@/lib/projects/errors';
import { MotirAiError } from '@/lib/ai/errors';
import { resolveCodeContext } from '@/lib/ai/codeContext';
import { aiConventionService } from '@/lib/services/aiConventionService';
import { EmptyState } from '@/components/ui/EmptyState';
import type { CodeAuditSurfaceDTO, ConventionSurfaceDTO } from '@/lib/dto/codeHealth';
import { CodeHealthClient } from './_components/CodeHealthClient';

// The Code-health page (MOTIR-926/1663) — a top-level, active-project page
// rendering the audit report + per-repo read-only convention cards. Server
// Component: session-gate, resolve the active project, read initial data
// through aiConventionService over the 7.1 boundary (project-admin gated),
// then seed the interactive island.

/**
 * The page's initial read for a connected repo SET (MOTIR-2123).
 *
 * ONE convention surface PER connected repo — the convention is scoped to a
 * (project, repo) pair (MOTIR-1660/1662) and `ConventionPanel` has rendered one
 * card per repo since MOTIR-1663, so reading only the first repo's surface was
 * what made four of MOTIR's five repos invisible.
 *
 * The AUDIT stays scoped to a SINGLE repo — the first — deliberately: how N
 * audit REPORTS are presented (a repo selector? stacked? worst-first?) is an
 * undesigned presentation question, not part of this fix.
 *
 * Exported for the page test (the `resolveSelectedBoardId` precedent) — the
 * composition is the behaviour worth pinning, not the JSX around it.
 */
export async function loadCodeHealthSurfaces(
  projectId: string,
  svcCtx: { userId: string; workspaceId: string },
  repoRefs: string[],
): Promise<{ audit: CodeAuditSurfaceDTO | null; conventions: ConventionSurfaceDTO[] }> {
  const auditRepoKey = repoRefs[0];
  if (auditRepoKey === undefined) return { audit: null, conventions: [] };
  const [audit, conventions] = await Promise.all([
    aiConventionService.getAudit(projectId, svcCtx, { repoKey: auditRepoKey }),
    Promise.all(
      repoRefs.map((repoKey) => aiConventionService.getConvention(projectId, svcCtx, { repoKey })),
    ),
  ]);
  return {
    audit,
    // Skip a repo with nothing derived yet — the tab's own empty state covers
    // it, and one un-derived repo must not hide the repos that DO have a
    // convention. Reads the field motir-ai actually populates (MOTIR-2127).
    conventions: conventions.filter((c) => c.convention !== null),
  };
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="flex flex-col gap-1">
      <h1 className="flex items-center gap-2 font-serif text-2xl font-semibold text-(--el-text)">
        <Activity className="h-6 w-6 text-(--el-text-secondary)" aria-hidden />
        {title}
      </h1>
      <p className="text-sm text-(--el-text-muted)">{subtitle}</p>
    </header>
  );
}

export default async function CodeHealthPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('codeHealth');
  const ctx = await getActiveProject();

  if (!ctx) {
    return (
      <div className="flex flex-col gap-6">
        <Header title={t('title')} subtitle={t('subtitle')} />
        <EmptyState title={t('noProjectTitle')} description={t('noProjectDescription')} />
      </div>
    );
  }

  const svcCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  let initialAudit: CodeAuditSurfaceDTO | null = null;
  let initialConventions: ConventionSurfaceDTO[] = [];
  let loadError: string | false = false;

  // Resolve connected repos for per-repo convention/audit scoping (MOTIR-1662).
  const code = await resolveCodeContext({
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  const repoRefs = (code?.repos ?? []).map((repo) => repo.repoRef);

  if (repoRefs.length > 0) {
    try {
      const surfaces = await loadCodeHealthSurfaces(ctx.projectId, svcCtx, repoRefs);
      initialAudit = surfaces.audit;
      initialConventions = surfaces.conventions;
    } catch (err) {
      if (err instanceof NotProjectAdminError || err instanceof ProjectNotFoundError) {
        return (
          <div className="flex flex-col gap-6">
            <Header title={t('title')} subtitle={t('subtitle')} />
            <EmptyState title={t('adminOnlyTitle')} description={t('adminOnlyDescription')} />
          </div>
        );
      }
      if (err instanceof MotirAiError) {
        loadError = `${err.code}: ${err.message}`;
      } else {
        throw err;
      }
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Header title={t('title')} subtitle={t('subtitle')} />
      <CodeHealthClient
        projectId={ctx.projectId}
        repoRefs={repoRefs}
        initialAudit={initialAudit}
        initialConventions={initialConventions}
        loadError={loadError}
      />
    </div>
  );
}
