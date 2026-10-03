import type {
  DispatchCardDisposition,
  DispatchRun,
  DispatchRunCard,
  DispatchRunEvent,
  WorkItem,
} from '@/generated/prisma/client';
import { profileDisplayName } from '@/lib/agentInstances/profiles';
import type {
  DispatchRunAgentInstanceDto,
  DispatchRunCardDto,
  DispatchRunContinuesDto,
  DispatchRunDto,
  DispatchRunEventDto,
  DispatchRunLegCountsDto,
  DispatchRunListItemDto,
  DispatchRunRepairDto,
  DispatchRunScopeDto,
} from '@/lib/dto/dispatchRuns';

// Prisma rows → DISPATCH RUN DTOs (Story MOTIR-1789 · MOTIR-1792).
//
// Pure functions, called by `dispatchRunService` just before it returns. They do
// two things and nothing else: serialize `Date` to ISO strings, and DROP the
// columns no client is owed (`workspaceId`, `updatedAt`, `idempotencyKey`).
//
// ⚠️ `idempotencyKey` IS DELIBERATELY NOT ON THE WIRE. It is a value the CALLER
// supplied and already holds; echoing it back adds nothing and turns a
// caller-chosen string into a published field this contract would then owe
// stability to. `created` on the open result answers the only question the
// caller actually has about it.

export function toDispatchRunCardDto(row: DispatchRunCard): DispatchRunCardDto {
  return {
    id: row.id,
    key: row.workItemKey,
    workItemId: row.workItemId,
    position: row.position,
    disposition: row.disposition,
    skipReason: row.skipReason,
    sessionBranch: row.sessionBranch,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    exitCode: row.exitCode,
    model: row.model,
  };
}

export function toDispatchRunEventDto(row: DispatchRunEvent): DispatchRunEventDto {
  return {
    id: row.id,
    seq: row.seq,
    kind: row.kind,
    cardId: row.dispatchRunCardId,
    data: row.data ?? null,
    body: row.body,
    reportedBy: row.reportedBy,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The run with its SET.
 *
 * `cards` arrives in `position` order from the repository's `include`, and this
 * mapper does NOT re-sort it — the order is the run's own stored fact, and a
 * mapper that sorted would be a second opinion about it.
 */
/** The agent a run executed in (MOTIR-7023), as the run section prints it. */
export interface DispatchRunAgentInstanceRow {
  id: string;
  name: string;
  profileId: string;
}

/**
 * The run's agent → its DTO: the name and the coding agent, with the profile's
 * display name resolved here so no surface keeps a second profile table.
 */
export function toDispatchRunAgentInstanceDto(
  row: DispatchRunAgentInstanceRow | null | undefined,
): DispatchRunAgentInstanceDto | null {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    profile: row.profileId,
    profileLabel: profileDisplayName(row.profileId),
  };
}

export function toDispatchRunDto(
  row: DispatchRun & {
    cards: DispatchRunCard[];
    /** Carried by every repository read that includes the legs; absent reads as none. */
    agentInstance?: DispatchRunAgentInstanceRow | null;
  },
  seq: number,
): DispatchRunDto {
  return {
    id: row.id,
    projectId: row.projectId,
    command: row.command,
    origin: row.origin,
    scopeWorkItemId: row.scopeWorkItemId,
    scopeLabel: row.scopeLabel,
    status: row.status,
    stopReason: row.stopReason,
    agent: row.agent,
    model: row.model,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
    reportedBy: row.reportedBy,
    createdById: row.createdById,
    agentInstance: toDispatchRunAgentInstanceDto(row.agentInstance),
    cards: row.cards.map(toDispatchRunCardDto),
    seq,
  };
}

/**
 * Every disposition at zero — the base a run's leg counts are added onto.
 *
 * ⚠️ WRITTEN OUT RATHER THAN DERIVED, and `satisfies` is what makes that safe:
 * the generated client exports the enum as a TYPE here, and a runtime list of
 * its members would be a second copy of a closed set to keep total. Spelling the
 * keys makes adding a disposition to the ADR a compile error in this file, which
 * is exactly where a new value needs to be noticed — the index renders these
 * counts, so a member missing here renders as nothing at all.
 */
const NO_LEGS = {
  queued: 0,
  running: 0,
  integrated: 0,
  implemented: 0,
  failed: 0,
  replanned: 0,
  skipped: 0,
  not_reached: 0,
} as const satisfies Record<DispatchCardDisposition, number>;

/** The run's legs COUNTED by disposition, total over the enum. */
export function toDispatchRunLegCounts(cards: DispatchRunCard[]): DispatchRunLegCountsDto {
  const counts: DispatchRunLegCountsDto = { ...NO_LEGS };
  for (const card of cards) counts[card.disposition] += 1;
  return counts;
}

/**
 * One row of the RUNS INDEX (MOTIR-3922): the header, and the set as COUNTS.
 *
 * The counts are derived from the `cards` the query already included, so a page
 * of fifty runs costs the same one query a page of one does. Nothing here reads
 * a leg's key: the index says how a run came out, and the run view says which
 * cards it came out that way on.
 */
export function toDispatchRunListItemDto(
  row: DispatchRun & {
    cards: DispatchRunCard[];
    agentInstance?: DispatchRunAgentInstanceRow | null;
  },
): DispatchRunListItemDto {
  return {
    id: row.id,
    command: row.command,
    origin: row.origin,
    scopeWorkItemId: row.scopeWorkItemId,
    scopeLabel: row.scopeLabel,
    status: row.status,
    stopReason: row.stopReason,
    agent: row.agent,
    model: row.model,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    createdById: row.createdById,
    agentInstance: toDispatchRunAgentInstanceDto(row.agentInstance),
    cardCount: row.cards.length,
    legs: toDispatchRunLegCounts(row.cards),
  };
}

/**
 * The header of a NARROWED runs index (MOTIR-5363): the scope work item's key,
 * title and whether it is archived. `archivedAt` becomes a flag, because the
 * header draws a pill and has no use for the instant.
 */
export function toDispatchRunScopeDto(
  row: Pick<WorkItem, 'identifier' | 'title' | 'archivedAt'>,
): DispatchRunScopeDto {
  return { key: row.identifier, title: row.title, archived: row.archivedAt !== null };
}

/**
 * A `continue` run's `run_opened` data as what it resumes (MOTIR-6795). Written
 * by the continue claim; read defensively, since an older claim wrote no scope
 * shape and an unreadable field must read as absent, never throw.
 */
export function toDispatchRunContinuesDto(data: unknown): DispatchRunContinuesDto {
  const d = (data ?? {}) as {
    continuesRunId?: unknown;
    branch?: unknown;
    branches?: unknown;
    mode?: unknown;
    landedKeys?: unknown;
    resumedKeys?: unknown;
  };
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const branches = Array.isArray(d.branches)
    ? (d.branches as Array<{ repository?: unknown; branch?: unknown }>).flatMap((b) => {
        const branch = str(b?.branch);
        // The clone URL is the project's, not the event's: the service fills it.
        return branch ? [{ repository: str(b?.repository), branch, cloneUrl: null }] : [];
      })
    : [];
  return {
    fromRunId: str(d.continuesRunId),
    branch: str(d.branch),
    branches,
    mode: d.mode === 'parent' ? 'parent' : 'card',
    landedKeys: strings(d.landedKeys),
    resumedKeys: strings(d.resumedKeys),
  };
}

const REPAIR_CLASSES = new Set(['ci', 'acceptance_rerun', 'review']);
const REVIEW_GATES = new Set(['agent_review', 'pull_request_approval']);

/**
 * A HOSTED `fix` run's `run_opened` data as what it repairs (MOTIR-6929). Written by
 * the repair claim's hosted opening (MOTIR-6928, `hostedRepairOpenedData`); read
 * defensively. A LOCAL repair's `run_opened` is the CLI's and records no class, so it
 * reads as null — and so does anything unreadable, rather than a guess: a container
 * handed a half-read decision would push to a branch nobody chose.
 */
export function toDispatchRunRepairDto(data: unknown): DispatchRunRepairDto | null {
  const d = (data ?? {}) as {
    repairClass?: unknown;
    title?: unknown;
    pullRequests?: unknown;
    findings?: unknown;
  };
  if (typeof d.repairClass !== 'string' || !REPAIR_CLASSES.has(d.repairClass)) return null;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  const pullRequests = Array.isArray(d.pullRequests)
    ? (d.pullRequests as Array<Record<string, unknown> | null>).flatMap((pr) => {
        const repo = str(pr?.repo);
        const branch = str(pr?.branch) ?? str(pr?.headRef);
        const url = str(pr?.url);
        const number = pr?.number;
        if (!repo || !branch || !url || typeof number !== 'number') return [];
        return [
          { repo, number, url, branch, baseRef: str(pr?.baseRef), headSha: str(pr?.headSha) },
        ];
      })
    : [];
  const f = (d.findings ?? null) as Record<string, unknown> | null;
  const findings =
    f && typeof f.gate === 'string' && REVIEW_GATES.has(f.gate) && str(f.decidedAt)
      ? {
          gate: f.gate as 'agent_review' | 'pull_request_approval',
          gateId: str(f.gateId),
          subjectVersion: str(f.subjectVersion),
          // Verbatim: a findings text is never trimmed or re-read here.
          findingsMd: typeof f.findingsMd === 'string' ? f.findingsMd : null,
          reviewerName: str(f.reviewerName),
          decidedByLabel: str(f.decidedByLabel),
          decidedUnderAuthority: str(f.decidedUnderAuthority),
          decidedAt: str(f.decidedAt) as string,
        }
      : null;
  return {
    repairClass: d.repairClass as DispatchRunRepairDto['repairClass'],
    title: str(d.title),
    pullRequests,
    findings,
  };
}
