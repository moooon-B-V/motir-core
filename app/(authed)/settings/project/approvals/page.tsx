import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { approvalGateSettingsService } from '@/lib/services/approvalGateSettingsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { AcceptanceVideoGateCard } from './_components/AcceptanceVideoGateCard';
import { guardSettingsPage, settingsEntryKeys } from '../_guard';

// `Project settings ▸ Approvals` — server component (Story MOTIR-4925 · Subtask
// MOTIR-5170), built to `design/projects/approvals.mock.html` panel 0 (the door)
// and panels 1–2 (the switch's two ordinary states).
//
// THE ROOM, not a card bolted onto an existing page, and the design argues it from
// the switch's readers and writers rather than from resemblance: a second
// project-tier gate switch is already decided (`docs/decisions/approval-gates.md`
// §7 moves the pull-request merge mode here, where `manual` raises a gate and
// `auto` raises none), and §7 also asks for a deep link from the approval surface
// to the switch that stops asking — which needs somewhere to land.
//
// Sibling of the Workflow / Board / Estimation rooms, and deliberately NEXT to
// Workflow in the rail: a status graph and an approval gate are the two things in
// Motir that decide when work may move.

export default async function ProjectApprovalsPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings');

  const ctx = await getActiveProject();
  // UNREACHABLE for a signed-in reader (MOTIR-4870 seeds a default project at the
  // WORKSPACE tier). The guard stays because the type does, and it redirects
  // rather than rendering — the sibling rooms' own reasoning.
  if (!ctx) redirect('/sign-in');

  // THE DESTINATION GUARD (MOTIR-2469). Hiding is presentation and never
  // protection: this page is one typed URL away once its rail row is gone. The
  // key comes from the registry entry `approvals` and is never re-declared here,
  // so the row that hides the page and the page that refuses the actor cannot
  // gate on different keys.
  const refused = await guardSettingsPage('approvals', ctx);
  if (refused) return refused;

  // ⚠️ THE GUARD ADMITS ON THE VIEW KEY, SO THE ACTOR HERE MAY CHANGE NOTHING
  // (MOTIR-5278). `approvals` opens on `project:browse`, so the switch is live
  // only for an actor holding the entry's WRITE key — looked up through the
  // registry, never typed: `tests/settings/projectSettingsNav.test.ts` fails this
  // page if it names the literal. `canManage` decides only whether the control is
  // offered; the read-only STATE, with the reason it carries, is MOTIR-5171's.
  const actor = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const [held, settings] = await Promise.all([
    projectAccessService.getPermissions(ctx.projectId, actor),
    approvalGateSettingsService.getSettings(ctx.projectId, actor),
  ]);
  const canManage = held.has(settingsEntryKeys('approvals').write);

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">
          {t('approvals.title')}
        </h1>
        <p className="text-(--el-text-secondary) font-sans text-sm">
          {t('approvals.pageDescription')}
        </p>
      </header>

      <AcceptanceVideoGateCard
        projectKey={ctx.project.identifier}
        initialEnabled={settings.acceptanceVideoEnabled}
        canManage={canManage}
      />
    </div>
  );
}
