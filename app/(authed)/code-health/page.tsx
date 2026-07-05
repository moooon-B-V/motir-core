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

// The Code-health page (Subtask 7.14.5 / MOTIR-926) — a top-level, active-project
// page (like /ready + /reports) rendering the audit report + the proposed-convention
// review/approve surface. Server Component: session-gate, resolve the active project,
// read BOTH panels' initial data through aiConventionService over the 7.1 boundary
// (project-admin gated in the service — a non-admin sees the admin-only state), then
// seed the interactive island. A boundary failure degrades to the island's retry
// state rather than crashing the route.

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
  let initialConvention: ConventionSurfaceDTO | null = null;
  let loadError = false;

  try {
    [initialAudit, initialConvention] = await Promise.all([
      aiConventionService.getAudit(ctx.projectId, svcCtx),
      aiConventionService.getConvention(ctx.projectId, svcCtx),
    ]);
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
      loadError = true;
    } else {
      throw err;
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Header title={t('title')} subtitle={t('subtitle')} />
      <CodeHealthClient
        initialAudit={initialAudit}
        initialConvention={initialConvention}
        loadError={loadError}
      />
    </div>
  );
}
