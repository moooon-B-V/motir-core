import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { NoAccessState } from '@/components/projects/NoAccessState';

// THE LESSON-LIBRARY ACCESS CHECK, in ONE place (Subtask MOTIR-3338).
//
// ⚠️ WHY THIS EXISTS AT ALL, rather than the key being read three times. The
// AI-planning area is gated by its registry entry (`ai:configure`, looked up by
// `guardSettingsPage`), and the library needs a SECOND key on top of it —
// `lesson:view` (MOTIR-3336). A registry entry carries one `permission`, so
// there is nowhere in the registry to put the second one.
//
// That is exactly the situation `tests/settings/settings-destination-guard.test.tsx`
// forbids solving by hand: a key copied into each page is how "the door hides on
// one permission while the destination refuses on another" happens, which is
// invisible in review because everything renders and everything refuses. So the
// key is declared ONCE here and the three surfaces that consult it — the door
// card on the AI-planning page, the list, and the detail — all call this.
//
// The area gate still runs FIRST in every page (`guardSettingsPage`); this is
// the narrower question asked after it.

/** The one declaration of the key the lesson surfaces gate on. */
export const LESSON_VIEW_PERMISSION: PermissionKey = 'lesson:view';

export interface LessonAccessContext {
  projectId: string;
  userId: string;
  workspaceId: string;
}

/** Whether this actor may read what the project taught its planner. */
export async function canViewLessonLibrary(ctx: LessonAccessContext): Promise<boolean> {
  const held = await projectAccessService.getPermissions(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  return held.has(LESSON_VIEW_PERMISSION);
}

/**
 * The DESTINATION guard for the two library pages — `null` when the actor may
 * read, otherwise the refusal node the page returns as its whole body (the
 * shape `guardSettingsPage` uses, for the same reason: the refusal renders
 * INSIDE the settings chrome, so the reader keeps their bearings).
 *
 * Hiding the door is presentation; this is what makes the typed URL refuse too.
 */
export async function guardLessonLibrary(ctx: LessonAccessContext): Promise<ReactNode | null> {
  if (await canViewLessonLibrary(ctx)) return null;
  const t = await getTranslations('settings');
  return (
    <NoAccessState
      title={t('noAccess.title')}
      description={t('aiPlanning.lessons.noAccessBody')}
      backHref="/settings/project/ai-planning"
      backLabel={t('aiPlanning.lessons.backToAiPlanning')}
    />
  );
}
