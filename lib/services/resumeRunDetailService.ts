import type { ApprovalGate, Prisma } from '@/generated/prisma/client';
import type { ItemGatedRunDto, ResumeGateDto, ResumeRunDto } from '@/lib/dto/home';
import { toGateResumeAttemptDto } from '@/lib/mappers/homeMappers';
import { gateResumeRepository } from '@/lib/repositories/gateResumeRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { dispatchRunEventRepository } from '@/lib/repositories/dispatchRunEventRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { readHeldGateVerdict, type HeldGateRef } from '@/lib/services/resumeStateService';
import { resolveContinueBranch } from '@/lib/services/workItemContinueService';
import { notePreviewOf } from '@/lib/workItems/fixReason';

// WHAT A TO RESUME ENTRY SAYS ABOUT ITS RUN (Story MOTIR-7701 · MOTIR-7712;
// `design/workbench/design-notes.md` § 35.4) — line 2's aside (who ran it and
// where, its branch) and the gate list (one line per held gate, as it stands now).
//
// ⚠️ THE GATES ARE `readHeldGateVerdict`'s, never a second reading. The column the
// tab lists by and the continue claim both read that function, so the entry draws
// exactly the gates that decided which state it is in — a design republished after
// the run stopped shows the version a person is actually asked about.

/** Where the run ran, in the aside's four words (§ 35.6 `workbench.toResume.ranBy.*`). */
export function ranWhereOf(header: {
  origin: 'local' | 'hosted' | 'instance';
  reportedBy: 'cli' | 'agent';
}): ResumeRunDto['ranWhere'] {
  if (header.origin === 'hosted') return 'hosted';
  if (header.origin === 'instance') return 'instance';
  // A local run the AGENT reported is the runbook's; the CLI reports its own.
  return header.reportedBy === 'agent' ? 'runbook' : 'terminal';
}

/**
 * One gated run's entry detail, read inside the caller's transaction. `headItemId` is
 * the entry's head card — the branch is read for it, the way the continue claim reads
 * the branch it would take over. Null when the run is not readable.
 */
export async function describeResumeRun(
  runId: string,
  headItemId: string,
  tx: Prisma.TransactionClient,
): Promise<ResumeRunDto | null> {
  // Sequential: one transaction's client runs one query at a time.
  const header = await dispatchRunRepository.findResumeHeaderById(runId, tx);
  if (!header) return null;
  const run = await dispatchRunRepository.findForWorkItemById(runId, headItemId, tx);
  const verdict = await readHeldGateVerdict(runId, tx);
  const head = run ? await workItemRepository.findById(headItemId, tx) : null;
  const branch =
    run && head
      ? (await resolveContinueBranch(head.id, run, tx, head.targetRepos[0] ?? null)).branch
      : null;

  // Decided first (§ 35.5, Panel 7): approved, then sent back, then waiting.
  const refs: HeldGateRef[] = [...verdict.released, ...verdict.sentBack, ...verdict.waiting];
  const cards = await workItemRepository.findByIds([...new Set(refs.map((r) => r.workItemId))], tx);
  const gates: Array<ApprovalGate | null> = [];
  for (const ref of refs) gates.push(await approvalGateRepository.findById(ref.gateId, tx));
  const cardOf = new Map(cards.map((card) => [card.id, card]));
  return {
    ranWhere: ranWhereOf(header),
    ranById: header.createdBy?.id ?? null,
    ranByName: header.createdBy?.name ?? null,
    agentName: header.agentInstance?.name ?? null,
    branch,
    gates: refs.map((ref, i): ResumeGateDto => {
      const card = cardOf.get(ref.workItemId);
      /* v8 ignore next -- one gate read per ref, in order */
      const gate = gates[i] ?? null;
      return {
        gateId: ref.gateId,
        kind: ref.kind,
        state: ref.state,
        subjectKey: ref.key,
        // The cards were read for exactly these refs.
        /* v8 ignore next */
        subjectTitle: card?.title ?? '',
        /* v8 ignore next */
        deciderId: card ? (card.assigneeId ?? card.reporterId) : null,
        decidedById: gate?.decidedById ?? null,
        decidedByLabel: gate?.decidedByLabel ?? null,
        decidedAt: gate?.decidedAt?.toISOString() ?? null,
        notePreview: notePreviewOf(gate?.noteMd ?? null),
      };
    }),
  };
}

export const resumeRunDetailService = {
  /**
   * The card's gated run for its item page (MOTIR-7713), read from the stored
   * `resumeState` / `resumeRunId` the To resume tab lists by — so the page and the tab
   * never disagree about whether the card waits. Null when it does not.
   */
  async readForWorkItem(workItemId: string, ctx: ServiceContext): Promise<ItemGatedRunDto | null> {
    return withWorkspaceContext(ctx, async (tx) => {
      const item = await workItemRepository.findById(workItemId, tx);
      if (!item) return null;
      if (item.resumeState === null || item.resumeRunId === null) {
        return readResuming(item.id, tx);
      }
      const runId = item.resumeRunId;
      const [scope] = await dispatchRunRepository.findScopesByIds([runId], tx);
      /* v8 ignore next -- the stored run id names an existing run */
      const scopeId = scope?.scopeWorkItemId ?? null;
      const parent =
        scopeId !== null && scopeId !== item.id
          ? await workItemRepository.findById(scopeId, tx)
          : null;
      // TO FIX WINS OVER TO RESUME, at the run's target (MOTIR-8011): the run is there to
      // resume only while the card it was opened on waits on it — the tab's own rule, so
      // the page never offers a resume the tab no longer lists.
      const target = parent ?? item;
      if (target.fixReason !== null || target.resumeRunId !== runId) return null;
      const run = await describeResumeRun(runId, scopeId ?? item.id, tx);
      /* v8 ignore next -- as above */
      if (!run) return null;
      const [attempt] = await gateResumeRepository.listByRunIds([runId], tx);
      return {
        state: item.resumeState,
        runId,
        resumedRunId: null,
        parent: parent ? { key: parent.identifier } : null,
        run,
        attempt: attempt ? toGateResumeAttemptDto(attempt) : null,
        names: await namesOf(run, tx),
      };
    });
  },
};

/**
 * RESUMING (G3): the card no longer waits — the continue claim cleared its column — and
 * its current run is the live continue an approval started. Its `run_opened` names the
 * gated run it carries on (`continuesRunId`) and that it resumes one (`resumesGated`).
 */
async function readResuming(
  itemId: string,
  tx: Prisma.TransactionClient,
): Promise<ItemGatedRunDto | null> {
  const latest = await dispatchRunRepository.findLatestForWorkItem(itemId, tx);
  if (!latest || latest.command !== 'continue' || latest.status !== 'running') return null;
  const opened = await dispatchRunEventRepository.findLatestOfKind(latest.id, 'run_opened', tx);
  const data = (opened?.data ?? null) as {
    continuesRunId?: unknown;
    resumesGated?: unknown;
  } | null;
  if (data?.resumesGated !== true || typeof data.continuesRunId !== 'string') return null;
  const run = await describeResumeRun(data.continuesRunId, itemId, tx);
  /* v8 ignore next -- a continue's `continuesRunId` names the run it claimed */
  if (!run) return null;
  const [attempt] = await gateResumeRepository.listByRunIds([data.continuesRunId], tx);
  return {
    state: 'resuming',
    runId: data.continuesRunId,
    resumedRunId: latest.id,
    parent: null,
    run,
    attempt: attempt ? toGateResumeAttemptDto(attempt) : null,
    names: await namesOf(run, tx),
  };
}

/** Every person the gates name, by id — the item page has no member table to read. */
async function namesOf(
  run: ResumeRunDto,
  tx: Prisma.TransactionClient,
): Promise<Record<string, string>> {
  const ids = [
    ...new Set(
      run.gates.flatMap((g) => [g.deciderId, g.decidedById]).filter((id): id is string => !!id),
    ),
  ];
  const users = await userRepository.findByIds(ids, tx);
  return Object.fromEntries(users.map((u) => [u.id, u.name]));
}
