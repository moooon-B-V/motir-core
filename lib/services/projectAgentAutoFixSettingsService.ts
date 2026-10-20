import { withWorkspaceContext } from '@/lib/workspaces/context';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import type {
  ProjectAgentAutoFixSettingsDto,
  UpdateProjectAgentAutoFixSettingsInput,
} from '@/lib/dto/projectAgentAutoFixSettings';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

/**
 * The project's AGENT AUTO-FIX switch (Story MOTIR-8981 · MOTIR-9060) — a row of
 * the Hosted agent settings room, so it takes that room's two keys, spelled out as
 * literals (the settings registry's key-drift check reads this file for them):
 * `work_item:edit` to read and `ai:configure` to write, as
 * `projectHostedAgentSettingsService.get` / `.update` assert.
 *
 * Its own service and not a field on the hosted-agent DTO: that service reads
 * motir-ai's offered list before every read and write, which would make a boolean
 * on a project row unreadable while motir-ai is down. This one reads the row alone.
 *
 * ⚠️ THE FLIP HAS NO CASCADE. It starts nothing; the starter reads the value.
 */
export const projectAgentAutoFixSettingsService = {
  async getSettings(
    projectId: string,
    ctx: ServiceContext,
  ): Promise<ProjectAgentAutoFixSettingsDto> {
    await projectAccessService.assertPermission(projectId, ctx, 'work_item:edit');

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const project = await projectRepository.findAgentAutoFixEnabled(projectId, tx);
        if (!project) throw new ProjectNotFoundError(projectId);
        return { agentAutoFixEnabled: project.agentAutoFixEnabled };
      },
    );
  },

  /**
   * Flip the switch, re-gated here rather than trusting the page's own guard. The
   * stored value is read under the project's row lock; a patch naming the value the
   * project already holds is a READ, so a retried request cannot write twice.
   */
  async updateSettings(
    projectId: string,
    patch: UpdateProjectAgentAutoFixSettingsInput,
    ctx: ServiceContext,
  ): Promise<ProjectAgentAutoFixSettingsDto> {
    await projectAccessService.assertPermission(projectId, ctx, 'ai:configure');

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        const locked = await projectRepository.lockById(projectId, tx);
        if (!locked) throw new ProjectNotFoundError(projectId);
        const current = await projectRepository.findAgentAutoFixEnabled(projectId, tx);
        if (!current) throw new ProjectNotFoundError(projectId);
        const next = patch.agentAutoFixEnabled;
        if (next !== undefined && current.agentAutoFixEnabled !== next) {
          const written = await projectRepository.updateAgentAutoFixEnabled(projectId, next, tx);
          return { agentAutoFixEnabled: written.agentAutoFixEnabled };
        }
        return { agentAutoFixEnabled: current.agentAutoFixEnabled };
      },
    );
  },
};
