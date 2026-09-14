import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { allSettledOrThrow } from '@/lib/async/allSettledOrThrow';
import { bugDestinationService } from '@/lib/services/bugDestinationService';
import { foldersService } from '@/lib/services/foldersService';
import { BugDestinationRoom } from './_components/BugDestinationRoom';
import { guardSettingsPage } from '../_guard';

// `Project settings ▸ Bugs` — server component (Story MOTIR-4927 · Subtask
// MOTIR-4938), built to `design/projects/bug-destination.mock.html` as amended by
// MOTIR-5536: where Motir files the bugs it creates on its own for this project —
// a folder, or the project root.
//
// Two reads, in parallel: the room's view of the destination (the stored pointer
// resolved to a named folder, and which folder is "this project's Bugs folder"),
// and every folder of the project for the shipped folder picker. The write is the
// card's PATCH, re-gated in `bugDestinationService`.

export default async function ProjectBugsPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings');

  const ctx = await getActiveProject();
  // UNREACHABLE for a signed-in reader (MOTIR-4870 seeds a default project at the
  // WORKSPACE tier). The guard stays because the type does — the only null left is
  // a session-less request — and it redirects rather than rendering.
  if (!ctx) redirect('/sign-in');

  // THE DESTINATION GUARD (MOTIR-2469). Hiding is presentation and never
  // protection: this page is one typed URL away once its rail row is gone. The key
  // comes from the registry entry `bugs`, never re-declared here.
  const refused = await guardSettingsPage('bugs', ctx);
  if (refused) return refused;

  // `allSettledOrThrow`, not `Promise.all`: both reads run an access gate that
  // rejects on an ordinary path, and a sibling must not be left running
  // unobserved when one does (MOTIR-3077).
  const serviceCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const [destination, folders] = await allSettledOrThrow([
    bugDestinationService.getSettings(ctx.projectId, serviceCtx),
    foldersService.listProjectFolders({ projectId: ctx.projectId }, serviceCtx),
  ]);

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">{t('bugs.title')}</h1>
        <p className="text-(--el-text-secondary) font-sans text-sm">{t('bugs.pageDescription')}</p>
      </header>

      <BugDestinationRoom
        projectKey={ctx.project.identifier}
        initial={destination}
        folders={folders.folders}
        truncated={folders.truncated}
      />
    </div>
  );
}
