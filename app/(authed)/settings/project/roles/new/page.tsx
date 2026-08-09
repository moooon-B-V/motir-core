import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { EmptyState } from '@/components/ui/EmptyState';
import { RoleEditor } from '../_components/RoleEditor';
import { guardSettingsPage } from '../../_guard';

// Project settings → Access → Roles & permissions → CREATE (Story MOTIR-2257 ·
// Subtask MOTIR-2483), `design/projects/roles-permissions.mock.html` panel 3.
//
// ⚠️ The STATIC `new` segment resolves ahead of the sibling dynamic `[roleKey]`,
// so `/roles/new` reaches this page and never the detail screen — Next's own
// precedence, relied on rather than worked around with a reserved-word check.
//
// ⚠️ THE PAGE'S GATE IS PRESENTATION, NEVER PROTECTION. An actor who cannot
// manage the project's access gets the shared refusal state here, and the API
// refuses the write independently (MOTIR-2474) — so removing this check would
// cost a nice error, not a security boundary.

export default async function NewProjectRolePage() {
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
  // protection: this door is still one typed URL away once its rail row is gone.
  // The key comes from the registry entry `roles`, never re-declared here.
  //
  // ⚠️ THIS REPLACED A `notFound()`. MOTIR-2483 shipped a bare 404 on
  // `project:manage_access`, reasoning that a settings surface an actor cannot
  // use should look missing. MOTIR-2469 answered that question for EVERY settings
  // destination and answered it the other way: the shared refusal state, which
  // says what happened and where to go, on every one of them. A single route
  // keeping its own posture is the inconsistency, not the improvement — and the
  // key now lives in one place instead of two.
  const refused = await guardSettingsPage('roles', ctx);
  if (refused) return refused;

  const actor = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const catalog = await projectAccessService.getRoleCatalog(ctx.projectId, actor);

  return (
    <RoleEditor projectKey={ctx.project.identifier} domains={catalog.domains} catalog={catalog} />
  );
}
