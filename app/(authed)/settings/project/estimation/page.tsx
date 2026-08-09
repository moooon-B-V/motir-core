import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { estimationService } from '@/lib/services/estimationService';
import { EmptyState } from '@/components/ui/EmptyState';
import { EstimationSettingsEditor } from './_components/EstimationSettingsEditor';
import { guardSettingsPage } from '../_guard';

// Estimation settings — server component (Subtask 4.3.6). Reads the active
// project, the caller's role (owner == project admin in v1, finding #36), and
// the project's estimation config, then hands typed serializable data to the
// client editor. The PATCH is re-gated in estimationService (owner-only), so
// `isAdmin` here only governs whether the edit affordances render — a non-admin
// who reaches the page sees it read-only. Sibling of the Workflow + Board
// settings pages (the project-scoped Estimation deviation — see story-4.3.ts).

export default async function ProjectEstimationPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings');

  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <div className="mx-auto max-w-[42rem]">
        <EmptyState
          title={t('project.empty.title')}
          description={t('estimation.empty.description')}
        />
      </div>
    );
  }

  // THE DESTINATION GUARD (MOTIR-2469). Hiding is presentation and never
  // protection: this page is still one typed URL away once its rail row is
  // gone. The key comes from the registry entry `estimation`, never re-declared here.
  const refused = await guardSettingsPage('estimation', ctx);
  if (refused) return refused;

  // MOTIR-2473 retired the private admin derivation that used to sit here — a
  // WORKSPACE-OWNER check (`isOwnerRole`) standing in for "may configure this",
  // which was both a second policy and a tighter one than the key the service
  // actually asserts. The page is reached only by an actor who holds its registry
  // key (the guard above), so the edit affordances are simply on.
  const isAdmin = true;
  const config = await estimationService.getEstimationConfig(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">
          {t('estimation.title')}
        </h1>
        <p className="text-(--el-text-muted) font-sans text-sm">
          {t('estimation.pageDescription')}
        </p>
      </header>

      <EstimationSettingsEditor
        projectKey={ctx.project.identifier}
        config={config}
        isAdmin={isAdmin}
      />
    </div>
  );
}
