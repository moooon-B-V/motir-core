import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { customFieldsService } from '@/lib/services/customFieldsService';
import { EmptyState } from '@/components/ui/EmptyState';
import { FieldsSettingsEditor } from './_components/FieldsSettingsEditor';
import { guardSettingsPage } from '../_guard';

// Project custom-fields settings — server component (Subtask 5.3.6). Reads
// the active project and its field definitions (through the 5.3.2 service:
// position order, option sets, value counts — the bounded admin read), then
// hands typed data to the client editor. The 6.4 members page is the
// structural template: every WRITE is re-gated in the service (the
// project-admin check in customFieldsService); `canManage` here only governs
// whether the mutation affordances render — a non-admin who reaches the page
// sees it read-only (the 5.3.4 degradation) and still can't mutate.
//
// `canManage` = a workspace owner/admin (the always-pass tier) OR a project
// admin — the 6.4 two-tier check. Reads stay open to members/viewers (the
// browse gate inside listFields); the rail needs the definitions.

export default async function ProjectFieldsPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings');

  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <div className="mx-auto max-w-[42rem]">
        <EmptyState title={t('project.empty.title')} description={t('project.empty.description')} />
      </div>
    );
  }

  // THE DESTINATION GUARD (MOTIR-2469). Hiding is presentation and never
  // protection: this page is still one typed URL away once its rail row is
  // gone. The key comes from the registry entry `fields`, never re-declared here.
  const refused = await guardSettingsPage('fields', ctx);
  if (refused) return refused;

  const actor = { key: ctx.project.identifier, actorUserId: ctx.userId, ctx };

  // The membership + workspace-role reads that used to ride this batch existed
  // ONLY to compute the private admin check MOTIR-2469 retired — two fewer round
  // trips on every load of this page.
  const fields = await customFieldsService.listFields(actor);

  // MOTIR-2469 retired the private admin check that used to sit here — a role
  // comparison against the workspace and project membership rows, written before
  // there was a permission model to ask, and a SECOND policy answering a question
  // the catalog already answers. The page is reached only by an actor who holds
  // its registry key (the guard above), so the manage affordances are simply on.
  const canManage = true;

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">
          {t('customFields.title')}
        </h1>
        <p className="text-(--el-text-muted) font-sans text-sm">
          {t.rich('customFields.subtitle', {
            projectName: ctx.project.name,
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
      </header>

      <FieldsSettingsEditor
        projectKey={ctx.project.identifier}
        fields={fields}
        canManage={canManage}
      />
    </div>
  );
}
