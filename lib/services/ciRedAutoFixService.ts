import type { WorkItem } from '@/generated/prisma/client';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { agentInstanceRunService } from './agentInstanceRunService';
import { resolveRunTargetFor } from './runTarget';
import { workItemRepairService } from './workItemRepairService';

// THE AUTO-START OF A FIX ON A RED DELIVERY (MOTIR-9054, Story MOTIR-8981).
//
// A terminal red verdict is recorded, the badge goes red, and — until this — nobody
// is handed the failure unless they happen to be looking. Behind a project switch
// that is OFF by default, this starts the fix in the card's own agent by itself.
//
// ⚠️ A SIDE EFFECT OF A DURABLE WRITE, NEVER A CONDITION OF IT. The caller
// (`applyOneCiDelivery`) runs it after the verdict has committed, inside its own
// `catch`; it also never throws, so a refusal of any kind is a returned
// disposition and one log line — no comment, no status, no fix reason.
//
// ⚠️ TWO SEPARATE BOUNDS, NEITHER A NEW COUNTER:
//   * one attempt per head — the start's `idempotencyKey` is
//     `auto-fix:<changeRequest>:<head>:<runTarget>`, and step 0 of `start` answers a
//     repeat with the run that key opened (`created: false`);
//   * no recursive kick — a fix run holds the repair claim while it works, so the
//     open-repair read below refuses every red verdict its own pushes produce.
//     `CI_FIX_ATTEMPTS` stays inside that run.

export type CiRedAutoFixDisposition =
  | 'started'
  | 'already_started'
  | 'setting_off'
  | 'no_cards'
  | 'multiple_run_targets'
  | 'no_agent_run'
  | 'agent_not_running'
  | 'repair_open'
  | 'refused';

export interface CiRedAutoFixInput {
  changeRequestId: string;
  headSha: string;
  workspaceId: string;
  deliveredWorkItemIds: readonly string[];
}

/** The one idempotency key an automatic fix is started under. */
export function autoFixKey(changeRequestId: string, headSha: string, runTargetId: string): string {
  return `auto-fix:${changeRequestId}:${headSha}:${runTargetId}`;
}

interface Plan {
  target: WorkItem;
  agent: { id: string; ownerId: string; state: string } | null;
}

export async function maybeAutoFixOnRed(
  input: CiRedAutoFixInput,
): Promise<CiRedAutoFixDisposition> {
  let targetKey = '';
  const finish = (disposition: CiRedAutoFixDisposition, detail?: string) => {
    console.warn('[ciRedAutoFix]', {
      disposition,
      changeRequestId: input.changeRequestId,
      headSha: input.headSha,
      runTarget: targetKey || null,
      ...(detail ? { detail } : {}),
    });
    return disposition;
  };

  if (input.deliveredWorkItemIds.length === 0) return finish('no_cards');

  // ── Phase 1 · read, under system context with the tenant bound ───────────
  const read = await withSystemContext(async (tx) => {
    await bindWorkspaceContext(tx, input.workspaceId);
    const cards = (
      await Promise.all(input.deliveredWorkItemIds.map((id) => workItemRepository.findById(id, tx)))
    ).filter((c): c is WorkItem => c !== null);
    if (cards.length === 0) return { kind: 'no_cards' as const };

    // The project's switch: the raw read, no actor, no permission asserted.
    const enabled = await projectRepository.findAgentAutoFixEnabled(cards[0]!.projectId, tx);
    if (!enabled) return { kind: 'setting_off' as const };

    // One run per delivery: the DISTINCT run targets, and only a single one acts.
    const targets = new Map<string, WorkItem>();
    for (const card of cards) {
      const rt = await resolveRunTargetFor(card, tx);
      const target = rt.kind === 'ancestor' ? rt.holder : card;
      targets.set(target.id, target);
    }
    if (targets.size !== 1) return { kind: 'multiple_run_targets' as const };
    const target = [...targets.values()][0]!;

    const last = await dispatchRunRepository.findLatestResumeRunForWorkItem(target.id, tx);
    if (!last?.agentInstance) return { kind: 'no_agent_run' as const, target };
    const agent = await agentInstanceRepository.findLiveForOwner(
      last.agentInstance.id,
      last.agentInstance.ownerId,
      tx,
    );
    return {
      kind: 'plan' as const,
      plan: {
        target,
        agent: agent ? { id: agent.id, ownerId: agent.ownerId, state: agent.state } : null,
      } satisfies Plan,
    };
  });

  if (read.kind === 'no_cards') return finish('no_cards');
  if (read.kind === 'setting_off') return finish('setting_off');
  if (read.kind === 'multiple_run_targets') return finish('multiple_run_targets');
  if (read.kind === 'no_agent_run') {
    targetKey = read.target.identifier;
    return finish('no_agent_run');
  }
  const { target, agent } = read.plan;
  targetKey = target.identifier;

  // "Up" is checked BEFORE the start, because the start would otherwise wake the
  // machine; narrower than the launch job's AGENT_UP on purpose.
  if (!agent || agent.state !== 'running') return finish('agent_not_running');

  // The run is started as the AGENT'S OWNER — their agent, their card, their credits.
  const ctx: ServiceContext = { userId: agent.ownerId, workspaceId: input.workspaceId };

  const open = await workItemRepairService.findOpenRepairRuns([target.id], ctx);
  if (open.has(target.id)) return finish('repair_open');

  try {
    const started = await agentInstanceRunService.start(
      {
        workItemKey: target.identifier,
        agentInstanceId: agent.id,
        idempotencyKey: autoFixKey(input.changeRequestId, input.headSha, target.id),
        command: 'fix',
      },
      ctx,
    );
    return finish(started.created ? 'started' : 'already_started');
  } catch (err) {
    return finish('refused', err instanceof Error ? err.name : 'unknown');
  }
}
