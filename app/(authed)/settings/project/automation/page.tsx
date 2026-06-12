import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workflowsService } from '@/lib/services/workflowsService';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { sprintsService } from '@/lib/services/sprintsService';
import { customFieldsService } from '@/lib/services/customFieldsService';
import { componentsService } from '@/lib/services/componentsService';
import { labelsService } from '@/lib/services/labelsService';
import { automationRulesService } from '@/lib/services/automationRulesService';
import { collectFilterReferentIds } from '@/lib/filters/registry';
import { EmptyState } from '@/components/ui/EmptyState';
import { NoAccessState } from '@/components/projects/NoAccessState';
import { AutomationSettings } from './_components/AutomationSettings';

// Project automation settings (Story 6.6 · Subtask 6.6.5) — the rule list + the
// when/if/then editor, mounted in the 6.5 settings AREA's reserved Automation
// slot (design/projects/automation.mock.html). Server component: it resolves the
// active project, ADMIN-GATES the whole surface (the verified Jira scope — no
// member/viewer read-only variant; a non-admin reads the no-access state, and
// the nav entry never renders for them), loads the editor's referent data
// (statuses / members / sprints / custom fields / components + the labels any
// rule condition references) + the project's rules, and hands them to the client
// editor. Every WRITE is re-gated in `automationRulesService` (the 6.4.3
// manage-project predicate) — `canManage` here only governs whether the surface
// renders at all. The page calls services only (4-layer), never Prisma.

export default async function ProjectAutomationPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings');

  const ctx = await getActiveProject();
  if (!ctx) {
    return (
      <div className="mx-auto max-w-[46rem]">
        <EmptyState title={t('area.noProjectTitle')} description={t('area.noProjectDescription')} />
      </div>
    );
  }

  // Admin-only end to end: a non-admin (member / viewer) gets the no-access
  // state, never the surface. `getManageCapabilities` reads as 404 for a
  // non-browser (the surface stays hidden) — here we degrade browsers-who-aren't
  // -admins to the same no-access page (the nav entry is already filtered away).
  const { canManage } = await projectAccessService.getManageCapabilities(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  if (!canManage) {
    const ta = await getTranslations('settings.automation.noAccess');
    return (
      <div className="mx-auto max-w-[46rem]">
        <NoAccessState
          title={ta('title')}
          description={ta('description')}
          backHref="/settings/project"
          backLabel={t('nav.details')}
        />
      </div>
    );
  }

  const wsCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };

  // Load the rules first so the editor's label referents (across every rule's
  // saved condition) resolve to names in the same bounded pass the issues page
  // uses — never load-all (finding #57); a rule whose condition carries no label
  // contributes no id.
  const rules = await automationRulesService.list(ctx.project.identifier, wsCtx);
  const referencedLabelIds = [
    ...new Set(
      rules.flatMap((r) => (r.condition ? collectFilterReferentIds(r.condition).labelIds : [])),
    ),
  ];

  const [workflow, members, sprints, customFields, components, referencedLabels] =
    await Promise.all([
      workflowsService.getWorkflow(ctx.projectId, ctx.workspaceId),
      assignableMembersService.list({
        projectId: ctx.projectId,
        accessLevel: ctx.project.accessLevel,
        ctx: wsCtx,
      }),
      sprintsService.listByProject(ctx.projectId, wsCtx),
      customFieldsService.listFields({
        key: ctx.project.identifier,
        actorUserId: ctx.userId,
        ctx: wsCtx,
      }),
      componentsService.listComponents(ctx.project.identifier, wsCtx),
      labelsService.resolveByIds(ctx.project.identifier, referencedLabelIds, wsCtx),
    ]);

  return (
    <div className="mx-auto flex max-w-[46rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">
          {t('automation.title')}
        </h1>
        <p className="text-(--el-text-muted) font-sans text-sm">
          {t.rich('automation.subtitle', {
            projectName: ctx.project.name,
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
      </header>

      <AutomationSettings
        projectKey={ctx.project.identifier}
        currentUserName={session.user.name ?? session.user.email}
        initialRules={rules}
        statuses={workflow.statuses}
        members={members}
        sprints={sprints}
        customFields={customFields}
        components={components}
        referencedLabels={referencedLabels}
      />
    </div>
  );
}
