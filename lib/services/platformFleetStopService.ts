import { hostedRunDispatchId } from '@/lib/hostedRuns/ids';
import type { FleetStopPreviewDTO, FleetStopResultDTO } from '@/lib/dto/platformFleetStop';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { PlatformOrganizationNotFoundError } from '@/lib/platform/errors';
import { withOrgServiceWriteContext } from '@/lib/organizations/context';
import { actionsRunsClient } from '@/lib/github/actionsRuns';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';
import { ciRunnerProvisioningIntentRepository as intents } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { fleetInFlightSlotRepository } from '@/lib/repositories/fleetInFlightSlotRepository';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { agentInstanceLifecycleService } from '@/lib/services/agentInstanceLifecycleService';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import { fleetStopService } from '@/lib/services/fleetStopService';
import { hostedRunService } from '@/lib/services/hostedRunService';
import { assertReasonSatisfied, platformAuditService } from '@/lib/services/platformAuditService';
import { withSystemContext } from '@/lib/workspaces/context';

// STOP ONE ORGANISATION'S CONTAINERS for a platform admin (Story MOTIR-6905 ·
// MOTIR-7317). Three stop paths that already exist, composed behind one
// `superadmin` door with a stated reason and one `fleet.stop` audit row:
//
//   1. CI — `fleetStopService.stopOrganization(org, 'admin_stop')` cancels the
//      org's live GitHub Actions runs on its Motir-hosted repositories, then
//      destroys its CI containers and settles their intents `admin_stop`.
//   2. HOSTED AGENTS — every live `hosted_agent` slot of the org names a run;
//      `hostedRunService.endHostedRun(run, 'cancelled', …)` revokes its keys and
//      closes it, and the run's supervisor tears the container down, charges and
//      releases it at its next poll.
//   3. AGENT INSTANCES — `hibernateAllForOrganization(org, 'admin_stop')`.
//
// ⚠️ INDEX CONTAINERS ARE NOT STOPPED, deliberately. Motir does not charge for
// indexing, so they cannot be a charging leak; they are capped at three per org
// (`fleet-per-org-pool.md` §7) and end on their own. The preview still counts
// them, so the admin sees what is left running.
//
// ⚠️ NO OTHER ORGANISATION IS TOUCHED. Every step is scoped by `organizationId`
// — never by app, fleet or workload alone — and that holds under every partial
// failure, because no step widens its scope when an earlier one fails.
//
// ⚠️ IT NEVER THROWS ON A PARTIAL STOP. Each path is commit-then-effect inside
// the service it calls and reports its failures; this composes the reports and
// records them. The only throws are the refusals, and every one of them comes
// BEFORE the first effect.

const ADMIN_STOP_DETAIL = 'stopped by a platform admin';
const HOSTED_RUN_PREFIX = hostedRunDispatchId('');

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : 'unknown';
}

/** The run a `hosted_agent` slot holds, from its ref; null for a ref of another shape. */
function dispatchRunIdOf(ref: string): string | null {
  return ref.startsWith(HOSTED_RUN_PREFIX) ? ref.slice(HOSTED_RUN_PREFIX.length) || null : null;
}

async function requireOrganization(organizationId: string): Promise<{ name: string }> {
  const org = await withOrgServiceWriteContext(organizationId, (tx) =>
    organizationRepository.findByIdInTx(organizationId, tx),
  );
  if (!org) throw new PlatformOrganizationNotFoundError(organizationId);
  return { name: org.name };
}

/** How many live workflow runs a stop would cancel, or null when GitHub could
 *  not be read for every repository — a preview never guesses. */
async function countActiveRuns(organizationId: string): Promise<number | null> {
  try {
    let runs = 0;
    for (const repo of await fleetStopService.listHostedRepos(organizationId)) {
      runs += (await actionsRunsClient.listActiveRuns(repo)).length;
    }
    return runs;
  } catch (err) {
    console.error('[platformFleetStopService] could not count the active runs', {
      organizationId,
      detail: detailOf(err),
    });
    return null;
  }
}

/** The org's live hosted-agent runs, by the slots that hold their containers. */
async function liveHostedRuns(organizationId: string, now: Date): Promise<string[]> {
  const slots = await withSystemContext((tx) =>
    fleetInFlightSlotRepository.listLiveForOrganization(organizationId, 'hosted_agent', now, tx),
  );
  return slots.flatMap((slot) => {
    const id = dispatchRunIdOf(slot.ref);
    return id ? [id] : [];
  });
}

export const platformFleetStopService = {
  /**
   * What a stop WOULD do now — the confirmation's counts. A read: `support` may
   * see it, audited `estate.read` on the org.
   */
  async preview(
    principal: PlatformPrincipal,
    organizationId: string,
    now: Date = new Date(),
  ): Promise<FleetStopPreviewDTO> {
    await requirePlatformStaff('support');
    const org = await requireOrganization(organizationId);

    const [ciRuns, ciContainers, hostedRuns, instances, census] = await Promise.all([
      countActiveRuns(organizationId),
      withSystemContext((tx) => intents.countInFlightForOrganization(organizationId, tx)),
      liveHostedRuns(organizationId, now),
      withSystemContext((tx) =>
        agentInstanceRepository.listLiveForOrganization(organizationId, tx),
      ),
      withSystemContext((tx) => fleetCeilingService.orgCensus(organizationId, now, tx)),
    ]);

    await platformAuditService.record(principal, {
      action: 'estate.read',
      targetKind: 'organization',
      targetId: organizationId,
      targetLabel: org.name,
      organizationId,
    });

    return {
      ciRuns,
      ciContainers,
      hostedRuns: hostedRuns.length,
      agentInstances: instances.filter((row) => row.state === 'running').length,
      indexContainers: census.byWorkload.code_graph_index,
    };
  },

  /**
   * Stop one organisation's containers: CI, then hosted runs, then agent
   * instances. `superadmin` only, with a non-blank reason — both refused before
   * any effect. Answers what each step achieved; the `fleet.stop` row is written
   * AFTER the effects, carrying those counts and failures.
   */
  async stop(
    principal: PlatformPrincipal,
    organizationId: string,
    reason: string,
    now: Date = new Date(),
  ): Promise<FleetStopResultDTO> {
    await requirePlatformStaff('superadmin');
    const trimmed = typeof reason === 'string' ? reason.trim() : '';
    const entry = {
      action: 'fleet.stop' as const,
      targetKind: 'organization' as const,
      targetId: organizationId,
      organizationId,
      reason: trimmed,
    };
    assertReasonSatisfied(entry);
    const org = await requireOrganization(organizationId);

    // ── 1 · CI: cancel the runs, then destroy the containers ─────────────────
    const ci = await fleetStopService.stopOrganization(organizationId, 'admin_stop');

    // ── 2 · hosted-agent runs: end each; its supervisor tears the container down
    let hostedRunsEnded = 0;
    let hostedFailures = 0;
    for (const dispatchRunId of await liveHostedRuns(organizationId, now)) {
      try {
        const ended = await hostedRunService.endHostedRun(
          dispatchRunId,
          'cancelled',
          ADMIN_STOP_DETAIL,
        );
        if (ended.closed) hostedRunsEnded += 1;
        if (ended.runKey === 'failed') hostedFailures += 1;
      } catch (err) {
        hostedFailures += 1;
        console.error('[platformFleetStopService] could not end a hosted run', {
          organizationId,
          dispatchRunId,
          detail: detailOf(err),
        });
      }
    }

    // ── 3 · agent instances: hibernate every running one ─────────────────────
    const instances = await agentInstanceLifecycleService.hibernateAllForOrganization(
      organizationId,
      'admin_stop',
    );

    const result: FleetStopResultDTO = {
      runsCancelled: ci.runsCancelled,
      ciContainersStopped: ci.containersStopped,
      hostedRunsEnded,
      agentInstancesHibernated: instances.hibernated,
      failures: {
        ci: ci.failures,
        hosted: hostedFailures,
        instances: instances.failures.length,
      },
    };

    await platformAuditService.record(principal, {
      ...entry,
      targetLabel: org.name,
      metadata: {
        ...result,
        failures: { ...result.failures },
        instanceFailures: instances.failures.map((failure) => ({ ...failure })),
      },
    });
    return result;
  },
};
