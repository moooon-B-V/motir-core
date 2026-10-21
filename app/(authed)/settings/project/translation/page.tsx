import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { billingService } from '@/lib/services/billingService';
import { isAiPaywallApplicable } from '@/lib/billing/aiEntitlement';
import { NO_PROJECT_PATH } from '@/lib/navigation/landing';
import { guardSettingsPage, settingsEntryKeys } from '../_guard';
import { AutoTranslateRoom } from './_components/AutoTranslateRoom';

// The Translation settings room (Story MOTIR-7738 · MOTIR-8830), drawn by
// MOTIR-8822 (`design/settings/auto-translate.mock.html` · `design/settings/
// design-notes.md` § Auto-translate room). Mounted in the project settings AREA
// through its registry entry `translation` (Automation, under Hosted agent),
// which lights the rail row and the ⌘K deep link.
//
// TWO questions, answered in order:
//   1. may this actor STAND in it — the entry's VIEW key (`project:browse`),
//      asked by the destination guard. A non-browser never gets this far: the
//      area layout already answered them with the project's not-found;
//   2. may they CHANGE it — the entry's WRITE key, read off the registry through
//      `settingsEntryKeys`, never typed here, and handed to the island.
//
// The room has no BUILD flag: it exists on every deployment, so unlike Hosted
// agent there is no `notFound()` for a build without it.
//
// The island reads the setting itself (its history's loading and failed faces ARE
// that read), so the page resolves only the gates and the organisation's credit
// verdict. No `<Suspense>` is owed — nothing here waits on anything slower than
// the guard and one member-safe entitlement read.

export default async function ProjectTranslationPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getActiveProject();
  if (!ctx) redirect(NO_PROJECT_PATH);

  // THE DESTINATION GUARD (MOTIR-2469) on the entry's VIEW key.
  const refused = await guardSettingsPage('translation', ctx);
  if (refused) return refused;

  const [t, held, access] = await Promise.all([
    getTranslations('settings'),
    projectAccessService.getPermissions(ctx.projectId, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    }),
    // A thrown read degrades to "not applicable" (no callout), as
    // `app/api/ai/access/route.ts` does: a boundary outage must not take the room
    // down, and the reactive out-of-credits path still catches a real block.
    billingService
      .getAiAccessForContext({ actorUserId: ctx.userId, workspaceId: ctx.workspaceId })
      .catch(() => null),
  ]);
  const canChange = held.has(settingsEntryKeys('translation').write);

  // `notApplicableAiAccess()` is an inert sentinel (self-host, a `meta` organisation),
  // so the paywall question is asked first, as `lib/billing/aiEntitlement.ts` requires.
  const noCredit =
    access !== null &&
    isAiPaywallApplicable(access) &&
    (!access.hasPaidAiPlan || access.balance <= 0);

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">
          {t('translation.title')}
        </h1>
        <p className="text-(--el-text-muted) font-sans text-sm">
          {t('translation.pageDescription')}
        </p>
      </header>

      <AutoTranslateRoom
        projectKey={ctx.project.identifier}
        canChange={canChange}
        noCredit={noCredit}
        canAddCredit={noCredit && access !== null && access.canManageBilling}
      />
    </div>
  );
}
