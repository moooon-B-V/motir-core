import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { PROJECT_SETTINGS_NAV, visibleSettingsNav } from '@/lib/settings/projectSettingsNav';
import { NoAccessState } from '@/components/projects/NoAccessState';

// THE DESTINATION GUARD (Story MOTIR-2258 · Subtask MOTIR-2469).
//
// Hiding is presentation and never protection. Once MOTIR-2468's rail stops
// offering a settings entry, the page behind it is still one typed URL, one
// bookmark and one old link away — so every settings page asks this before it
// renders. A story that only hid things would trade a confusing product for one
// that merely LOOKS governed, which is worse.
//
// ⚠️ THE KEY IS LOOKED UP, NEVER RE-DECLARED. A page names its own registry
// entry by id and this reads the `permission` off it, so the row that hides the
// page and the page that refuses the actor cannot gate on different keys. That
// divergence is invisible in review — everything renders, everything refuses,
// and the only symptom is that the wrong people are let in or kept out.
//
// ⚠️ AND IT DOES NOT TOUCH THE 404-vs-403 POSTURE. A NON-BROWSER never reaches
// here: `app/(authed)/settings/project/layout.tsx` already answers them with the
// project-level no-access state, before any page runs. This guard is for the
// actor who CAN browse the project and simply does not hold this domain's key.
// Do not collapse the two — the first must not learn that a section exists.

/** Every registry id, as a type, so a page cannot name an entry that isn't there. */
export type SettingsEntryId = (typeof PROJECT_SETTINGS_NAV)[number]['id'];

/**
 * Ask whether `entryId`'s destination is open to this actor.
 *
 * Returns `null` when it is — the page proceeds unchanged. Returns the refusal
 * NODE when it is not, which the caller returns as its whole body:
 *
 *     const refused = await guardSettingsPage('members', ctx);
 *     if (refused) return refused;
 *
 * Written as a node rather than a thrown error so the refusal renders INSIDE the
 * settings area chrome (the rail stays, the reader keeps their bearings) rather
 * than replacing the shell.
 */
/**
 * The DECISION, with no IO and no JSX — pure over (entry id, held set), so the
 * whole matrix of destination × role is assertable without a database.
 *
 * `null` means the destination is open. Otherwise it names the copy key and
 * where "back" goes, which is the part with a trap in it: back must land on a
 * page the actor CAN open. NOT hard-wired to Details — `Details` is gated on
 * `project:administer` now, so a board-only actor would be bounced straight into
 * a second refusal. Take the first entry their own rail offers, and fall out of
 * the area entirely when it offers none.
 */
export function resolveSettingsRefusal(
  entryId: SettingsEntryId,
  held: ReadonlySet<PermissionKey>,
): { descriptionKey: string; backHref: string; backLabelKey: string | null } | null {
  const entry = PROJECT_SETTINGS_NAV.find((e) => e.id === entryId);
  // Unreachable through the typed id above; a runtime guard so a future registry
  // edit fails loudly here rather than silently opening the page to everyone.
  if (!entry) throw new Error(`No settings registry entry for id "${entryId}"`);
  if (held.has(entry.permission)) return null;

  const [firstReachable] = visibleSettingsNav(held);
  return {
    descriptionKey: `noAccess.section.${entryId}`,
    backHref: firstReachable ? firstReachable.href : '/dashboard',
    backLabelKey: firstReachable ? firstReachable.labelKey : null,
  };
}

/**
 * Ask whether `entryId`'s destination is open to this actor.
 *
 * Returns `null` when it is — the page proceeds unchanged. Returns the refusal
 * NODE when it is not, which the caller returns as its whole body:
 *
 *     const refused = await guardSettingsPage('members', ctx);
 *     if (refused) return refused;
 *
 * Written as a node rather than a thrown error so the refusal renders INSIDE the
 * settings area chrome (the rail stays, the reader keeps their bearings) rather
 * than replacing the shell.
 */
export async function guardSettingsPage(
  entryId: SettingsEntryId,
  ctx: { projectId: string; userId: string; workspaceId: string },
): Promise<ReactNode | null> {
  const held = await projectAccessService.getPermissions(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  const refusal = resolveSettingsRefusal(entryId, held);
  if (!refusal) return null;

  const t = await getTranslations('settings');
  const ta = await getTranslations('projectAccess');

  return (
    <div className="mx-auto max-w-[46rem]">
      <NoAccessState
        title={t('noAccess.title')}
        description={t(refusal.descriptionKey)}
        backHref={refusal.backHref}
        backLabel={refusal.backLabelKey ? t(refusal.backLabelKey) : ta('backToProjects')}
      />
    </div>
  );
}
