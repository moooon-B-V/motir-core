import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Activity } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { NotProjectAdminError, ProjectNotFoundError } from '@/lib/projects/errors';
import { MotirAiError } from '@/lib/ai/errors';
import { aiConventionService } from '@/lib/services/aiConventionService';
import { EmptyState } from '@/components/ui/EmptyState';
import type { CodeAuditSurfaceDTO, ConventionSurfaceDTO } from '@/lib/dto/codeHealth';
import { CodeHealthClient } from './_components/CodeHealthClient';

// The Code-health page (MOTIR-926/1663) — a top-level, active-project page
// rendering the audit report + per-repo read-only convention cards. Server
// Component: session-gate, resolve the active project, read initial data
// through aiConventionService over the 7.1 boundary (project-admin gated),
// then seed the interactive island.

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

  try {
    const [auditResult, conventionResult] = await Promise.all([
      aiConventionService.getAudit(ctx.projectId, svcCtx),
      aiConventionService.getConvention(ctx.projectId, svcCtx),
    ]);
    initialAudit = auditResult;
    initialConventions = [conventionResult].filter(
      (c) => c.proposed !== null || c.standard !== null,
    );
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

  return (
    <div className="flex flex-col gap-6">
      <Header title={t('title')} subtitle={t('subtitle')} />
      <CodeHealthClient
        projectId={ctx.projectId}
        initialAudit={initialAudit}
        initialConventions={initialConventions}
        loadError={loadError}
      />
    </div>
  );
}
