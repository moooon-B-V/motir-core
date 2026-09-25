import type { ApprovalGateKind, Prisma } from '@/generated/prisma/client';
import type {
  AcceptanceResultSubjectSummaryDTO,
  ApprovalGateSubjectSummaryDTO,
  DecisionApprovalSubjectSummaryDTO,
  DecisionChoiceSubjectSummaryDTO,
  DecisionConfirmationSubjectSummaryDTO,
  DesignResultSubjectSummaryDTO,
  PlanApprovalSubjectSummaryDTO,
  PullRequestApprovalSubjectSummaryDTO,
  UnregisteredSubjectSummaryDTO,
} from '@/lib/dto/approvalGate';
import type { RegisteredGateKind, UnregisteredGateKind } from '@/lib/approvalGates/registry';
import { isRegisteredGateKind } from '@/lib/approvalGates/registry';
import { acceptanceEvidenceRepository } from '@/lib/repositories/acceptanceEvidenceRepository';
import { designEvidenceRepository } from '@/lib/repositories/designEvidenceRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { parseChoiceOptions } from '@/lib/approvalGates/choiceOptions';
import { asksTheConfirmQuestion } from '@/lib/approvalGates/decisionConfirmationHandler';
import { decisionConfirmationSummaryOf } from '@/lib/approvalGates/decisionRecord';
import {
  workItemDeliveryRepository,
  type WorkItemDeliveryWithChecks,
} from '@/lib/repositories/workItemDeliveryRepository';
import { liveRowsAtLatestSha } from '@/lib/github/prCiState';
import { decisionIdentityOf, titleFromDecisionPath } from '@/lib/approvalGates/decisionSubject';
import { planGateHeldOf } from '@/lib/approvalGates/planApprovalHandler';
import { planRepository } from '@/lib/repositories/planRepository';
import { planRevisionRepository } from '@/lib/repositories/planRevisionRepository';

// THE SUBJECT SUMMARY — what a QUEUE ROW says about the thing being decided,
// resolved per KIND (Story MOTIR-4879 · Subtask MOTIR-4791; ADR
// docs/decisions/approval-gates.md §1).
//
// ⚠️ WHY THIS IS NOT A METHOD ON `GateHandler`. The registry's handler contract
// is about DECIDING one gate: every one of its seams takes `GateEffectArgs`,
// which carries the locked gate row and a resolved status key, and
// `resolveSubject` is documented to read *the exact version the reviewer is
// looking at*. A queue renders up to a page of gates and decides none of them,
// so routing it through that contract would mean N calls built out of args that
// only a decision has — and it would widen an interface MOTIR-4790 deliberately
// kept to the five things ADR §1's table asks of a kind. This card registers no
// kind and writes no handler; it adds the read's own per-kind seam beside the
// registry, keyed on the registry's own type.
//
// ⚠️ THE SAME COMPILE-TIME GUARANTEE, THOUGH, AND IT IS THE POINT OF THE FILE.
// `SUMMARY_LOADERS` is a `Record<RegisteredGateKind, …>`, so PROMOTING a kind
// fails the build until its summariser exists — exactly as
// `APPROVAL_GATE_HANDLERS` does for its handler. And `_SummaryIsTotal` below
// asserts the DTO union covers the whole Prisma enum, so ADDING a fifth member
// fails the build here too. The read's DTO is therefore total over the enum
// rather than over the kinds that happen to be built, which is the story's own
// criterion.
//
// ⚠️ AND THE ASSERTIONS LIVE HERE RATHER THAN IN `lib/dto/approvalGate.ts`
// BECAUSE OF THE CLIENT/SERVER BOUNDARY. That file is imported by the approval
// frame, a `'use client'` module, and `tests/planning/planChangeArchitecture.test.ts`
// refuses a client module importing the service layer — which is what pulling
// the registry (and through it `designResultHandler` → `workItemsService`) into
// the DTO would be. The types are declared where a client may read them and
// PROVED where the enum is legal to import.

/** The DTO union covers the Prisma enum EXACTLY — a fifth member fails here. */
type _SummaryIsTotal = AssertEqual<ApprovalGateSubjectSummaryDTO['kind'], ApprovalGateKind>;

/** The not-built-yet arm names exactly the registry's declared holes. */
type _UnregisteredArmMatchesRegistry = AssertEqual<
  UnregisteredSubjectSummaryDTO['kind'],
  UnregisteredGateKind
>;

/** Structural equality of two types, as a compile-time assertion — the same
 *  helper `registry.ts` uses, and for the same reason. */
type AssertEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : { ERROR: 'approval-gate subject summaries are not total over the kind enum'; A: A; B: B };

/**
 * Load the summaries for one page's worth of subjects of ONE kind, in ONE round
 * trip, keyed by `subjectId`.
 *
 * A subject that no longer resolves is ABSENT from the map rather than mapped to
 * a placeholder — the caller decides what a row with an unresolvable subject
 * says, and that is a rendering decision rather than a data one.
 */
type SummaryLoader = (
  subjectIds: string[],
  tx: Prisma.TransactionClient,
  shared: SharedReads,
) => Promise<Map<string, ApprovalGateSubjectSummaryDTO>>;

/**
 * READS TWO KINDS SHARE, made ONCE per page (MOTIR-5679). The approve-and-merge row and
 * the decision row both read the card's delivery set by the work item's id, so a page
 * holding both reads it in one round trip for the union of their cards — a decision row
 * joining a queue that already lists a pull-request row costs no query at all.
 */
interface SharedReads {
  deliveries(subjectIds: readonly string[]): Promise<WorkItemDeliveryWithChecks[]>;
}

/** The kinds whose subject IS the card and whose summary reads its delivery set. */
const DELIVERY_KINDS: ReadonlySet<RegisteredGateKind> = new Set([
  'pull_request_approval',
  'decision_approval',
]);

function sharedReadsFor(
  byKind: ReadonlyMap<RegisteredGateKind, string[]>,
  tx: Prisma.TransactionClient,
): SharedReads {
  const ids = [
    ...new Set(
      [...byKind].flatMap(([kind, subjectIds]) => (DELIVERY_KINDS.has(kind) ? subjectIds : [])),
    ),
  ];
  let all: Promise<WorkItemDeliveryWithChecks[]> | null = null;
  return {
    async deliveries(subjectIds) {
      all ??= workItemDeliveryRepository.listByWorkItemsWithChecks(ids, tx);
      const wanted = new Set(subjectIds);
      return (await all).filter((delivery) => wanted.has(delivery.workItemId));
    },
  };
}

/** How much of a design note a ROW carries. A lead, not the note. */
const NOTE_EXCERPT_CHARS = 180;

/**
 * The first readable line of a design note, flattened.
 *
 * Markdown heading marks, emphasis and list bullets are stripped rather than
 * rendered, because a row is one line of plain text — a `##` arriving verbatim
 * in a list is the tell of a note excerpted by `slice` alone. Returns null for a
 * note that is absent or has no prose in it, which the DTO is honest about.
 */
export function excerptNote(noteMd: string | null): string | null {
  if (noteMd === null) return null;
  const flattened = noteMd
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/[*_`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flattened.length === 0) return null;
  if (flattened.length <= NOTE_EXCERPT_CHARS) return flattened;
  return `${flattened.slice(0, NOTE_EXCERPT_CHARS).trimEnd()}…`;
}

/**
 * THE LOADERS, total over {@link RegisteredGateKind}.
 *
 * One entry per kind this build can render. Promoting a kind into
 * `RegisteredGateKind` is a missing-property error here until somebody writes
 * its loader — the same sentence the handler registry enforces, one layer over.
 */
const SUMMARY_LOADERS: Record<RegisteredGateKind, SummaryLoader> = {
  // MOTIR-6035 — a PLAN row (design Part XXII §22.3's field table). `subjectId` is the
  // plan, and the row has no card, so everything it draws is read here: three queries
  // for the whole page — the plans, their trails (for `held`), and the targets' titles
  // per project. A plan that no longer exists is absent.
  async plan_approval(subjectIds, tx) {
    const plans = await planRepository.findManyForGateSummary(subjectIds, tx);
    const trails = new Map<string, Parameters<typeof planGateHeldOf>[0][number][]>();
    for (const row of await planRevisionRepository.listLeaseRowsByPlans(
      plans.map((plan) => plan.id),
      tx,
    )) {
      const trail = trails.get(row.planId);
      if (trail) trail.push(row);
      else trails.set(row.planId, [row]);
    }
    const keysByProject = new Map<string, Set<string>>();
    for (const plan of plans) {
      const keys = keysByProject.get(plan.projectId) ?? new Set<string>();
      for (const key of plan.session?.targetKeys ?? []) keys.add(key);
      keysByProject.set(plan.projectId, keys);
    }
    const titles = new Map<string, string>();
    for (const [projectId, keys] of keysByProject) {
      for (const item of await workItemRepository.findByIdentifiers(projectId, [...keys], tx)) {
        titles.set(`${projectId}:${item.identifier}`, item.title);
      }
    }
    const now = new Date();
    const out = new Map<string, ApprovalGateSubjectSummaryDTO>();
    for (const plan of plans) {
      const summary: PlanApprovalSubjectSummaryDTO = {
        kind: 'plan_approval',
        planId: plan.id,
        sessionId: plan.sessionId,
        sessionHasTurns: (plan.session?.turnCount ?? 0) > 0,
        title: plan.title,
        projectName: plan.project.name,
        targets: (plan.session?.targetKeys ?? []).map((key) => ({
          key,
          title: titles.get(`${plan.projectId}:${key}`) ?? null,
        })),
        proposalCount: plan._count.items,
        author: {
          source: plan.authorSource,
          harness: plan.authorHarness,
          origin: plan.origin,
        },
        held: planGateHeldOf(trails.get(plan.id) ?? [], now),
      };
      out.set(plan.id, summary);
    }
    return out;
  },
  // MOTIR-5891 — a choice row names the QUESTION and how many options it offers,
  // parsed from the work item's own body (`subjectId` is the work item). A body
  // that no longer parses is absent, and the row says the subject no longer resolves.
  async decision_choice(subjectIds, tx) {
    const items = await workItemRepository.findByIds([...subjectIds], tx);
    const out = new Map<string, ApprovalGateSubjectSummaryDTO>();
    for (const item of items) {
      const parse = parseChoiceOptions(item.descriptionMd);
      if (item.type !== 'choice' || !parse.ok) continue;
      const summary: DecisionChoiceSubjectSummaryDTO = {
        kind: 'decision_choice',
        optionCount: parse.options.length,
        question: parse.question,
      };
      out.set(item.id, summary);
    }
    return out;
  },
  // MOTIR-5954 — a confirm row names the DECISION (its first line), what kind of change
  // it records and how many work items it supersedes, parsed from the work item's own
  // body. A body that no longer parses is absent, as a choice's is.
  async decision_confirmation(subjectIds, tx) {
    const items = await workItemRepository.findByIds([...subjectIds], tx);
    const out = new Map<string, ApprovalGateSubjectSummaryDTO>();
    for (const item of items) {
      if (!asksTheConfirmQuestion(item)) continue;
      const parsed = decisionConfirmationSummaryOf(item.descriptionMd);
      if (!parsed) continue;
      const summary: DecisionConfirmationSubjectSummaryDTO = {
        kind: 'decision_confirmation',
        ...parsed,
      };
      out.set(item.id, summary);
    }
    return out;
  },
  // MOTIR-4950 — the acceptance row names the RECORDING the gate asks about.
  async acceptance_result(subjectIds, tx) {
    const rows = await acceptanceEvidenceRepository.findManyByIds(subjectIds, tx);
    const out = new Map<string, ApprovalGateSubjectSummaryDTO>();
    for (const [id, row] of rows) {
      const summary: AcceptanceResultSubjectSummaryDTO = {
        kind: 'acceptance_result',
        acceptanceEvidenceId: row.id,
        producedByKey: row.producedByKey,
        commitSha: row.commitSha,
        chapterCount: Array.isArray(row.chapters) ? row.chapters.length : 0,
      };
      out.set(id, summary);
    }
    return out;
  },
  async design_result(subjectIds, tx) {
    const rows = await designEvidenceRepository.findManyByIds(subjectIds, tx);
    const out = new Map<string, ApprovalGateSubjectSummaryDTO>();
    for (const [id, row] of rows) {
      const summary: DesignResultSubjectSummaryDTO = {
        kind: 'design_result',
        designEvidenceId: row.id,
        producedByKey: row.producedByKey,
        commitSha: row.commitSha,
        assetCount: row._count.assets,
        noteExcerpt: excerptNote(row.noteMd),
      };
      out.set(id, summary);
    }
    return out;
  },
  // MOTIR-5676 — a decision row names the DOCUMENT from the capture on the card's pull
  // requests: `subjectId` is the card, so one batched delivery read answers every
  // decision gate on the page, and no host is called. A card with no captured open pull
  // request is absent, and its row says the subject no longer resolves.
  async decision_approval(subjectIds, _tx, shared) {
    const deliveries = await shared.deliveries(subjectIds);
    const membersByItem = new Map<string, Parameters<typeof decisionIdentityOf>[0][number][]>();
    for (const delivery of deliveries) {
      const pr = delivery.pullRequest;
      if (pr.state !== 'open' || pr.merged) continue;
      const member = {
        repo: `${delivery.repo.owner}/${delivery.repo.name}`,
        number: pr.number,
        outcome: pr.decisionDocOutcome,
        path: pr.decisionDocPath,
        blobSha: pr.decisionDocBlobSha,
        headSha: pr.decisionDocHeadSha,
        paths: pr.decisionDocPaths,
      };
      const members = membersByItem.get(delivery.workItemId);
      if (members) members.push(member);
      else membersByItem.set(delivery.workItemId, [member]);
    }
    const out = new Map<string, ApprovalGateSubjectSummaryDTO>();
    for (const [workItemId, members] of membersByItem) {
      const identity = decisionIdentityOf(members);
      if (!identity) continue;
      const summary: DecisionApprovalSubjectSummaryDTO = identity.resolvable
        ? {
            kind: 'decision_approval',
            outcome: 'one',
            repo: identity.repo,
            number: identity.number,
            path: identity.path,
            title: titleFromDecisionPath(identity.path),
            blobSha: identity.blobSha,
            documentCount: 1,
          }
        : {
            kind: 'decision_approval',
            outcome: identity.reason,
            repo: identity.repo,
            number: identity.number,
            path: null,
            title: null,
            blobSha: null,
            documentCount: identity.paths.length,
          };
      out.set(workItemId, summary);
    }
    return out;
  },
  // ⚠️ THE `pull_request_merge` LOADER WAS HERE (MOTIR-4793) and retired with its kind
  // (MOTIR-5616). Its rows are superseded and unregistered now, so they take the
  // not-built-yet summary below with every other kind this build does not render.
  // MOTIR-5481 — the approve-and-merge kind's row names EVERY pull request in the card's
  // delivery set. `subjectId` is the work item's own id, so one batched delivery read
  // answers every gate of the kind on the page; a card that delivers nothing is absent,
  // and its row says the subject no longer resolves.
  async pull_request_approval(subjectIds, _tx, shared) {
    const deliveries = await shared.deliveries(subjectIds);
    const membersByItem = new Map<string, PullRequestApprovalSubjectSummaryDTO['members']>();
    for (const delivery of deliveries) {
      const pr = delivery.pullRequest;
      const member = {
        repo: `${delivery.repo.owner}/${delivery.repo.name}`,
        number: pr.number,
        headSha: liveRowsAtLatestSha(pr.checkRuns)[0]?.commitSha ?? null,
        state: pr.merged ? 'merged' : pr.state === 'open' ? 'open' : 'closed',
      } satisfies PullRequestApprovalSubjectSummaryDTO['members'][number];
      const members = membersByItem.get(delivery.workItemId);
      if (members) members.push(member);
      else membersByItem.set(delivery.workItemId, [member]);
    }
    const out = new Map<string, ApprovalGateSubjectSummaryDTO>();
    for (const [workItemId, members] of membersByItem) {
      // The set's canonical order — the order its version string is written in.
      members.sort((a, b) => (`${a.repo}#${a.number}` < `${b.repo}#${b.number}` ? -1 : 1));
      out.set(workItemId, { kind: 'pull_request_approval', members });
    }
    return out;
  },
};

/**
 * Summarise every gate on one page, grouped by kind — **one query per KIND
 * present, never one per gate.**
 *
 * ⚠️ AN UNREGISTERED KIND NEEDS NO QUERY AND GETS NO LOADER. Its summary is the
 * kind itself: there is nothing in this build that knows how to read its
 * subject, which is precisely what the row has to say. Routing it through a
 * loader would mean inventing a read for a kind whose owning card has not
 * shipped one.
 *
 * Returns a map keyed by GATE id — not by subject id — because two gates of
 * different kinds may legitimately carry the same opaque `subjectId`, and the
 * caller is holding gates.
 */
export async function summarizeGateSubjects(
  gates: readonly { id: string; kind: ApprovalGateKind; subjectId: string }[],
  tx: Prisma.TransactionClient,
): Promise<Map<string, ApprovalGateSubjectSummaryDTO | null>> {
  const byKind = new Map<RegisteredGateKind, string[]>();
  for (const gate of gates) {
    if (!isRegisteredGateKind(gate.kind)) continue;
    const bucket = byKind.get(gate.kind);
    if (bucket) bucket.push(gate.subjectId);
    else byKind.set(gate.kind, [gate.subjectId]);
  }

  const loaded = new Map<RegisteredGateKind, Map<string, ApprovalGateSubjectSummaryDTO>>();
  const shared = sharedReadsFor(byKind, tx);
  for (const [kind, subjectIds] of byKind) {
    loaded.set(kind, await SUMMARY_LOADERS[kind](subjectIds, tx, shared));
  }

  const out = new Map<string, ApprovalGateSubjectSummaryDTO | null>();
  for (const gate of gates) {
    if (!isRegisteredGateKind(gate.kind)) {
      // The not-built-yet row. The kind is the whole summary, and it is a real
      // answer rather than a missing one.
      out.set(gate.id, { kind: gate.kind } satisfies UnregisteredSubjectSummaryDTO);
      continue;
    }
    // Null when the subject no longer resolves — the loader omits it, and the
    // row says so rather than pretending it read something.
    out.set(gate.id, loaded.get(gate.kind)?.get(gate.subjectId) ?? null);
  }
  return out;
}
