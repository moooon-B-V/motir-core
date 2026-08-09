import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { workflowsService } from '@/lib/services/workflowsService';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { sprintsService } from '@/lib/services/sprintsService';
import { customFieldsService } from '@/lib/services/customFieldsService';
import { componentsService } from '@/lib/services/componentsService';
import { labelsService } from '@/lib/services/labelsService';
import { automationRulesService } from '@/lib/services/automationRulesService';
import { collectFilterReferentIds } from '@/lib/filters/registry';
import { EmptyState } from '@/components/ui/EmptyState';
import { AutomationSettings } from './_components/AutomationSettings';
import { guardSettingsPage } from '../_guard';

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

  // THE DESTINATION GUARD (MOTIR-2469). Hiding is presentation and never
  // protection: this page is still one typed URL away once its rail row is
  // gone. The key comes from the registry entry `automation`, never re-declared here.
  const refused = await guardSettingsPage('automation', ctx);
  if (refused) return refused;

  // Gated on `automation:manage` end to end (MOTIR-2297): an actor without it
  // gets the no-access state, never the surface. The read resolves the actor's
  // whole permission SET once and tests membership, rather than asking a second
  // boolean question — and it still reads as 404 for a NON-BROWSER, so a project
  // they may not see stays hidden.
  //
  // ⚠️ MOTIR-2469 replaced the inline gate that used to sit here — this page's
  // own permission read, its own key test and its own NoAccessState. It
  // was the EXEMPLAR the card generalised: every settings page now asks the
  // shared guard above, and the key comes from the registry rather than being
  // spelled out here, so the row that hides this page and the page that refuses
  // the actor can never gate on different keys. The copy moved with it, from
  // `settings.automation.noAccess.*` to the uniform `settings.noAccess.*`.

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
