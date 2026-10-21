import { withWorkspaceContext } from '@/lib/workspaces/context';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectSettingChangeRepository } from '@/lib/repositories/projectSettingChangeRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { toProjectAutoTranslateSettingsDTO } from '@/lib/mappers/projectAutoTranslateSettingsMappers';
import {
  RECENT_CHANGE_LIMIT,
  type ProjectAutoTranslateSettingsDTO,
  type UpdateProjectAutoTranslateSettingsInput,
} from '@/lib/dto/projectAutoTranslateSettings';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { Prisma } from '@/generated/prisma/client';

/**
 * The project's AUTO-TRANSLATE WORK CONTENT switch (Story MOTIR-7738 ·
 * MOTIR-8826) — read by `Settings → Project → Translation`, written by the route
 * behind it. The only service that flips the switch, and so the only writer of
 * its change trail.
 *
 * ⚠️ TWO VERBS, TWO KEYS, DELIBERATELY. The read takes `project:browse` — the floor
 * that admits every member and no outsider — because a member without
 * `project:administer` must be able to SEE the state; the write takes
 * `project:administer`. `project:browse` is also the room's VIEW key, and the
 * settings registry's view-key drift check reads this file for `assertPermission`
 * and that literal, so the gate is spelled out below rather than hidden in a helper.
 *
 * ⚠️ THE FLIP HAS NO CASCADE. It translates nothing, drops no kept translation
 * (the off state still serves the kept copies to an on-demand press) and moves no
 * credit; other cards read the switch's value.
 */

/** Everything the room shows, read inside the caller's workspace-bound transaction. */
async function readState(
  projectId: string,
  tx: Prisma.TransactionClient,
): Promise<ProjectAutoTranslateSettingsDTO> {
  const project = await projectRepository.findAutoTranslateWorkContent(projectId, tx);
  if (!project) throw new ProjectNotFoundError(projectId);

  const [rows, totalChanges] = await Promise.all([
    projectSettingChangeRepository.listRecentByProject(projectId, RECENT_CHANGE_LIMIT, tx),
    projectSettingChangeRepository.countByProject(projectId, tx),
  ]);

  // The actor is stored by id and named when read, so a change survives the
  // removal of the person who made it: an actor that no longer resolves keeps its
  // row and loses only the name.
  const actorIds = [
    ...new Set(rows.flatMap((r) => (r.changedByUserId ? [r.changedByUserId] : []))),
  ];
  const users = await userRepository.findByIds(actorIds, tx);
  const names = new Map(users.map((u) => [u.id, u.name]));

  return toProjectAutoTranslateSettingsDTO(
    project.autoTranslateWorkContent,
    rows,
    totalChanges,
    names,
  );
}

export const projectAutoTranslateSettingsService = {
  /**
   * The room's read: the switch, its bounded newest-first change trail, and the
   * total so a surface can say the list is capped. A non-browser — and a project
   * of another workspace — reads as not existing.
   */
  async getSettings(
    projectId: string,
    ctx: ServiceContext,
  ): Promise<ProjectAutoTranslateSettingsDTO> {
    await projectAccessService.assertPermission(projectId, ctx, 'project:browse');

    return withWorkspaceContext({ userId: ctx.userId, workspaceId: ctx.workspaceId }, (tx) =>
      readState(projectId, tx),
    );
  },

  /**
   * Flip the switch. Re-gated here rather than trusting the page's own guard.
   *
   * ONE TRANSACTION: the previous value is read under the project's row lock, so
   * the `from` a trail row records is the value this write actually replaced when
   * two administrators flip at once; the column write and the trail append commit
   * together or not at all. A patch naming the value the project already holds is
   * a READ — no column write, no trail row — so a retried request cannot fabricate
   * a second entry.
   */
  async updateSettings(
    projectId: string,
    patch: UpdateProjectAutoTranslateSettingsInput,
    ctx: ServiceContext,
  ): Promise<ProjectAutoTranslateSettingsDTO> {
    await projectAccessService.assertPermission(projectId, ctx, 'project:administer');

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const next = patch.autoTranslateWorkContent;
        if (next !== undefined) {
          const locked = await projectRepository.lockById(projectId, tx);
          if (!locked) throw new ProjectNotFoundError(projectId);
          const current = await projectRepository.findAutoTranslateWorkContent(projectId, tx);
          if (!current) throw new ProjectNotFoundError(projectId);

          if (current.autoTranslateWorkContent !== next) {
            await projectRepository.updateAutoTranslateWorkContent(projectId, next, tx);
            await projectSettingChangeRepository.append(
              {
                workspaceId: ctx.workspaceId,
                projectId,
                changedByUserId: ctx.userId,
                fromEnabled: current.autoTranslateWorkContent,
                toEnabled: next,
              },
              tx,
            );
          }
        }
        return readState(projectId, tx);
      },
    );
  },
};
