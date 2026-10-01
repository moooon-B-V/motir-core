import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { isHostedRunsAvailable } from '@/lib/hostedRuns/availability';
import { NO_PROJECT_PATH } from '@/lib/navigation/landing';
import { guardSettingsPage, settingsEntryKeys } from '../_guard';
import { HostedAgentSettingsEditor } from './_components/HostedAgentSettingsEditor';

// The Hosted agent settings room (Story MOTIR-6989 · MOTIR-6995), drawn by
// MOTIR-6991 (`design/settings/hosted-agent.mock.html`). Mounted in the project
// settings AREA through its registry entry `hosted-agent` (Automation, under AI
// planning), which lights the rail row and the ⌘K deep link.
//
// THREE questions, answered in order (design panel 0):
//   1. does the room EXIST on this build — `isHostedRunsAvailable()`, a build
//      fact; without it `notFound()`, as billing does off-cloud;
//   2. may this actor STAND in it — the entry's VIEW key (`work_item:edit`),
//      asked by the destination guard;
//   3. may they CHANGE it — the entry's WRITE key, read off the registry through
//      `settingsEntryKeys`, never typed here, and handed to the editor.
//
// The editor reads the settings itself (a client island): the room's loading
// and unavailable states are that read, and motir-ai's offered list is never
// cached, so the page resolves only the gates. No `<Suspense>` is owed — nothing
// here waits on anything slower than the guard.

export default async function ProjectHostedAgentPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  // A BUILD fact: a deployment that runs no hosted agents has no such room.
  if (!isHostedRunsAvailable()) notFound();

  const ctx = await getActiveProject();
  if (!ctx) redirect(NO_PROJECT_PATH);

  // THE DESTINATION GUARD (MOTIR-2469) on the entry's VIEW key.
  const refused = await guardSettingsPage('hosted-agent', ctx);
  if (refused) return refused;

  const [t, held] = await Promise.all([
    getTranslations('settings'),
    projectAccessService.getPermissions(ctx.projectId, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    }),
  ]);
  const canConfigure = held.has(settingsEntryKeys('hosted-agent').write);

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">
          {t('hostedAgent.title')}
        </h1>
        <p className="text-(--el-text-muted) font-sans text-sm">
          {t('hostedAgent.pageDescription')}
        </p>
      </header>

      <HostedAgentSettingsEditor projectKey={ctx.project.identifier} canConfigure={canConfigure} />
    </div>
  );
}
