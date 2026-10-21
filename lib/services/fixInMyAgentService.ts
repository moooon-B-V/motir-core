import type { FixInMyAgentDoorDto } from '@/lib/dto/agentInstanceRuns';
import { agentInstanceRunService } from '@/lib/services/agentInstanceRunService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// THE "FIX IN MY AGENT" DOOR'S READ (Story MOTIR-8981 · MOTIR-9053) — composes the
// repair claim's own evaluation (`getRepairView`, the ONE predicate: no second one
// here), the card's last in-agent run, and the viewer's agent list into the door's
// state. It opens nothing and writes nothing.

const notOffered = (
  reason: Extract<FixInMyAgentDoorDto, { offered: false }>['reason'],
  extra: Partial<Extract<FixInMyAgentDoorDto, { offered: false }>> = {},
): FixInMyAgentDoorDto => ({ offered: false, reason, run: null, refusal: null, ...extra });

export const fixInMyAgentService = {
  async readDoor(workItemKey: string, ctx: ServiceContext): Promise<FixInMyAgentDoorDto> {
    const identifier = workItemKey.trim().toUpperCase();
    const project = await projectsService.getByKey(
      identifier.slice(0, identifier.lastIndexOf('-')),
      ctx,
    );
    const item = await workItemsService.getWorkItemByIdentifier(project.id, identifier, ctx);

    const view = await workItemRepairService.getRepairView(item.id, ctx);
    if (view.state === 'hidden') return notOffered('green');
    if (view.state === 'pointer') return notOffered('no_pull_request');
    if (view.state === 'in_progress') {
      const runId = view.run?.id ?? null;
      const { agents: own } = runId
        ? await agentInstanceRunService.listAgentsForCard(identifier, ctx)
        : { agents: [] };
      const agentName = own.find((a) => a.runningRun?.id === runId)?.name ?? null;
      return notOffered('repair_open', {
        run: view.run
          ? {
              id: view.run.id,
              label: view.run.label,
              startedAt: view.startedAt,
              holder: view.holder ? { id: view.holder.id, name: view.holder.name } : null,
              byViewer: view.byViewer,
              agentName,
            }
          : null,
      });
    }
    if (view.repairClass !== 'ci') return notOffered('not_ci');

    const [{ agents }, { lastRun }] = await Promise.all([
      agentInstanceRunService.listAgentsForCard(identifier, ctx),
      agentInstanceRunService.resumeTargetForCard(identifier, ctx),
    ]);
    const lastId = lastRun?.agentIsReaders ? (lastRun.agent?.id ?? null) : null;
    const chosen =
      (lastId ? agents.find((a) => a.id === lastId) : undefined) ??
      agents.find((a) => a.refusal === null) ??
      null;
    if (!chosen) return notOffered('no_agent');
    if (chosen.refusal) return notOffered('agent_unusable', { refusal: chosen.refusal });
    return {
      offered: true,
      agent: {
        id: chosen.id,
        name: chosen.name,
        profileId: chosen.profileId,
        profileName: chosen.profileName,
        state: chosen.state,
      },
    };
  },
};
