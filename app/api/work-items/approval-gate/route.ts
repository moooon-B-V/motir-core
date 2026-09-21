import { NextResponse } from 'next/server';
import { getActiveProject } from '@/lib/projects';
import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';
import { workItemsService } from '@/lib/services/workItemsService';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { acceptanceEvidenceService } from '@/lib/services/acceptanceEvidenceService';
import { designEvidenceService } from '@/lib/services/designEvidenceService';
import { decisionDocumentService } from '@/lib/services/decisionDocumentService';
import { choiceGateService } from '@/lib/services/choiceGateService';
import { howToTestService } from '@/lib/services/howToTestService';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import { pullRequestMergeService } from '@/lib/services/pullRequestMergeService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import {
  APPROVAL_GATE_HANDLERS,
  UNREGISTERED_GATE_KINDS,
  isRegisteredGateKind,
} from '@/lib/approvalGates/registry';
import type {
  ApprovalGateDTO,
  ApprovalGateKindDTO,
  ApprovalGateOverlayReadDTO,
  ApprovalGateOverlaySubjectDTO,
} from '@/lib/dto/approvalGate';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// GET /api/work-items/approval-gate?key=<identifier>&kind=<gate kind>
// (Story MOTIR-5214 · Subtask MOTIR-5223) — the approval OVERLAY's only read.
//
// The overlay is mounted in the authed shell and opened by its URL, so it is a
// client island, and no client component may reach the service layer
// (CLAUDE.md's 4-layer rule) — the same reason `peek` and `planning-anchor` are
// routes. The in-list disclosure's server action (deleted by MOTIR-5225) could
// not serve it: that action was handed a `(workItemId, subjectId)` off a queue
// row the browser already held, and an overlay address can be pasted into a cold
// tab with no row anywhere.
//
// Built in the exact shape of `app/api/work-items/planning-anchor/route.ts`:
// resolve against the actor's ACTIVE project, the 2FA hold AFTER the no-project
// arm, and the no-existence-leak 404. Thin HTTP over SHIPPED service reads and no
// new one:
//
//   1. `workItemsService.getWorkItemByIdentifier` — the key → item resolution,
//      and the BROWSE gate. `getForWorkItem` binds the workspace but asserts no
//      browse permission, so without this read a reader could ask about a gate
//      on a card in a private project they are not in.
//   2. `approvalGatesService.getForWorkItem` — the frame's own read: the gate of
//      that kind in whatever state, `canDecide` as the AUTHORITY answer, and the
//      live *waiting on* name. Nothing here re-derives any of it.
//   3. THE PORT, per kind, only for a kind this build registers:
//      - `design_result` — `designEvidenceService.getForGateSubject`, read by the
//        gate's own `subjectId`;
//      - `pull_request_approval` (MOTIR-5439) — the Development block, read by the
//        SAME calls the item page's late stack makes (`lateReads.ts`):
//        `workItemsService.listLinkedPullRequests` + `getDeliveryView`,
//        `howToTestService.getForWorkItem`, `designEvidenceService.getCurrentForWorkItem`,
//        and — for an approved OR AWAITING gate (MOTIR-5806: the re-asked gate's members
//        carry the row's verb) — `pullRequestMergeService.listApprovalMembers`.
//
// No `db` / no `$transaction` here.
//
// A stale / deleted / cross-workspace / forbidden key is the same 404 (never a
// 403, which would leak "it exists but you can't see it"). A card with no gate
// of that kind is NOT a 404 — it is a card with nothing to decide, and the
// overlay says so.

/** Every gate kind the enum carries — registered and not — read from the
 *  registry rather than written out, so a new kind cannot be refused here while
 *  the registry classifies it. */
const GATE_KINDS: ReadonlySet<string> = new Set<string>([
  ...Object.keys(APPROVAL_GATE_HANDLERS),
  ...UNREGISTERED_GATE_KINDS,
]);

function parseKind(raw: string | null | undefined): ApprovalGateKindDTO | null {
  const kind = raw?.trim();
  return kind && GATE_KINDS.has(kind) ? (kind as ApprovalGateKindDTO) : null;
}

/** The three ways the key can say "there is nothing here for you" — one answer. */
function isNotAvailable(err: unknown): boolean {
  /* v8 ignore else -- the fall-through below is unreachable; see its note. */
  if (err instanceof WorkItemNotFoundError || err instanceof ProjectAccessDeniedError) return true;
  /* v8 ignore next -- unreachable FROM HERE: `getWorkItemByIdentifier` resolves
     the item inside the active project and rejects a foreign workspace with
     `WorkItemNotFoundError` before `assertCanBrowse` runs. Kept because this
     handler is the peek route's twin, and a leak-sensitive catch is the wrong
     place to narrow on a reading of another module's call order. */
  return err instanceof ProjectNotFoundError;
}

/**
 * What the port renders. TOTAL over `ApprovalGateKind`: a kind the registry
 * leaves unregistered is a real row with a drawn not-built-yet arm, never a
 * throw and never an empty body.
 */
async function readSubject(
  kind: ApprovalGateKindDTO,
  gate: ApprovalGateDTO | null,
  item: { id: string; type: string | null; targetRepos: readonly string[] },
  ctx: ServiceContext,
): Promise<ApprovalGateOverlaySubjectDTO> {
  if (!gate) return { state: 'no_gate' };
  if (!isRegisteredGateKind(kind)) return { state: 'kind_not_built' };
  switch (kind) {
    case 'design_result': {
      // ⚠️ A DESIGN GATE THAT CARRIES A MERGE GATE IS PORTED BY THE DEVELOPMENT BLOCK
      // (Bug MOTIR-5712; `design-result.md` AMENDMENT 6 Q1). While the design question
      // is open on a card whose pull requests await a merge decision, one press answers
      // both — so the reader must see what that press MERGES, exactly as the item page's
      // frame shows it (MOTIR-5667): the design result first, its pull requests and How
      // to test beneath. The To-approve queue lists such a card by this gate only, so
      // this port is the one place the queue's reader meets those pull requests.
      if (gate.state === 'awaiting') {
        const merge = await approvalGatesService.getForWorkItem(
          { workItemId: gate.workItemId, kind: 'pull_request_approval' },
          ctx,
        );
        if (merge.gate?.state === 'awaiting') return readDevelopmentBlock(gate, item, ctx);
      }
      const { evidence, filesKept } = await designEvidenceService.getForGateSubject(
        { workItemId: gate.workItemId, subjectId: gate.subjectId },
        ctx,
      );
      return evidence
        ? { state: 'resolved', kind: 'design_result', evidence, filesKept }
        : { state: 'gone' };
    }
    // ⚠️ `pull_request_merge` HAS NO ARM, and needs none: MOTIR-5616 moved the kind to
    // `UNREGISTERED_GATE_KINDS`, so `isRegisteredGateKind` above answers it with
    // `kind_not_built` before this switch is reached. MOTIR-5615 recorded why the arm
    // could not go earlier — this switch is total over the REGISTERED kinds, so the case
    // could only be deleted in the same diff that unregisters the kind.
    //
    // ⚠️ MERGE RESOLUTION, 2026-09-16: MOTIR-5437 (#2920) landed on `main` in between and
    // gave `pull_request_approval` the real port below, while keeping a merge arm that
    // returned `kind_not_built`. Both halves are kept — 5437's port, and no merge arm —
    // because the kind that arm answered for is no longer registered to reach it.
    case 'pull_request_approval':
      return readDevelopmentBlock(gate, item, ctx);
    // MOTIR-4950 — the acceptance port is the RECORDING the gate asks about, read by
    // the gate's own `subjectId` exactly as the design arm reads its evidence.
    case 'acceptance_result': {
      // ⚠️ A STORY RUN'S ACCEPTANCE IS PORTED BY THE DEVELOPMENT BLOCK (MOTIR-5790), for
      // the design arm's reason above: while it awaits beside an awaiting merge question,
      // one press answers both, so the reader must see what that press merges.
      if (gate.state === 'awaiting') {
        const merge = await approvalGatesService.getForWorkItem(
          { workItemId: gate.workItemId, kind: 'pull_request_approval' },
          ctx,
        );
        if (merge.gate?.state === 'awaiting') return readDevelopmentBlock(gate, item, ctx);
      }
      const evidence = await acceptanceEvidenceService.getForGateSubject(
        { workItemId: gate.workItemId, subjectId: gate.subjectId },
        ctx,
      );
      return evidence
        ? { state: 'resolved', kind: 'acceptance_result', evidence }
        : { state: 'gone' };
    }

    // THE DECISION PORT (MOTIR-5678; design §27 Panel 7): the Development block with the
    // decision document FIRST — read here, on the server, through the resolver — and the
    // pull requests one press merges beneath it. The document is read beside the block,
    // never inside a transaction, because the production resolver calls the Git host.
    case 'decision_approval': {
      const [block, document] = await Promise.all([
        readDevelopmentBlock(gate, item, ctx),
        decisionDocumentService.readViewForWorkItem(gate.workItemId, ctx).catch(() => null),
      ]);
      return block.state === 'resolved' && block.kind === 'pull_request_approval'
        ? { ...block, decision: { document } }
        : block;
    }
    // THE CHOICE PORT (Story MOTIR-4914 · MOTIR-5891): the options parsed from the work
    // item's own body — which IS the subject. A body that no longer parses has nothing
    // left to pick from, so the port answers `gone`, exactly as a vanished design does.
    case 'decision_choice': {
      const choice = await choiceGateService.readPort(gate.workItemId, ctx);
      return choice ? { state: 'resolved', kind: 'decision_choice', choice } : { state: 'gone' };
    }
    /* v8 ignore next 4 -- unreachable by construction: `kind` is narrowed to
       `RegisteredGateKind`, and registering a second kind is a compile error
       here until it has its own arm. */
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
}

/**
 * THE DEVELOPMENT BLOCK as a port — the approve-to-merge gate's own, and a design
 * gate's while it carries one (see the `design_result` arm).
 *
 * ⚠️ `members` is read against the gate HANDED IN, and only once it is approved — a
 * design gate still awaiting has merged nothing, exactly like an awaiting merge gate.
 */
async function readDevelopmentBlock(
  gate: ApprovalGateDTO,
  item: { id: string; type: string | null; targetRepos: readonly string[] },
  ctx: ServiceContext,
): Promise<ApprovalGateOverlaySubjectDTO> {
  // THE DEVELOPMENT BLOCK as the port (Story MOTIR-5437 · MOTIR-5439). The subject
  // is the card's DELIVERY SET (`pullRequestApprovalHandler.resolveSubject`), so a
  // set that has emptied — every pull request unlinked — is GONE, exactly as the
  // handler answers null for it. Nothing is read by `subjectId` beyond that: the
  // gate's `subjectId` IS the work item's id.
  const [
    pullRequests,
    deliveryView,
    howToTest,
    designEvidence,
    members,
    repair,
    acceptanceEvidence,
    acceptanceRead,
  ] = await Promise.all([
    workItemsService.listLinkedPullRequests(gate.workItemId, ctx),
    workItemsService.getDeliveryView(gate.workItemId, item.targetRepos, ctx),
    howToTestService.getForWorkItem(gate.workItemId, ctx),
    designEvidenceService.getCurrentForWorkItem(gate.workItemId, ctx),
    // ⚠️ READ FOR AN AWAITING GATE TOO (MOTIR-5802 · MOTIR-5806). The RE-ASKED gate is
    // awaiting, and its members are what carry the row's verb — *Queue again* /
    // *Retry merge*, whose press decides that very gate. The item page's late stack
    // reads both for the same reason, and `approval-gate-route.test.ts` COMPARES them.
    gate.state === 'approved' || gate.state === 'awaiting'
      ? pullRequestMergeService.listApprovalMembers(
          { workItemId: gate.workItemId, approvalGateId: gate.id },
          ctx,
        )
      : Promise.resolve([]),
    // ⚠️ `motir fix` BELONGS IN THE OVERLAY TOO (MOTIR-5806; § 28 panel 7). The page
    // has offered it since MOTIR-5721; the overlay is where most approvals are
    // actually decided, and a person deciding there saw only the approve.
    workItemRepairService.getRepairView(gate.workItemId, ctx),
    // A story run's receipt and its gate (MOTIR-5790) — the subject when acceptance leads.
    acceptanceEvidenceService.getCurrentForStory(gate.workItemId, ctx),
    approvalGatesService.getForWorkItem(
      { workItemId: gate.workItemId, kind: 'acceptance_result' },
      ctx,
    ),
  ]);
  if (deliveryView.deliveries.length === 0) return { state: 'gone' };
  return {
    state: 'resolved',
    kind: 'pull_request_approval',
    pullRequests,
    repoDelivery: deliveryView.repos,
    deliveries: deliveryView.deliveries,
    howToTest,
    designEvidence,
    isDesignCard: item.type === 'design',
    members,
    repair,
    acceptanceEvidence,
    acceptanceGate: acceptanceRead.gate,
  };
}

export async function GET(req: Request): Promise<Response> {
  const active = await getActiveProject();
  if (!active) {
    return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
  }

  // The 2FA hold (MOTIR-3653) — AFTER the no-project arm, exactly where the
  // peek and the planning anchor place it.
  const hold = await refuseIfNonCompliant(active.userId);
  if (hold) return hold;

  const params = new URL(req.url).searchParams;
  const key = params.get('key')?.trim();
  if (!key) {
    return NextResponse.json({ code: 'BAD_REQUEST', error: '`key` is required.' }, { status: 400 });
  }
  const kind = parseKind(params.get('kind'));
  if (!kind) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`kind` must be an approval-gate kind.' },
      { status: 400 },
    );
  }

  const ctx: ServiceContext = { userId: active.userId, workspaceId: active.workspaceId };

  try {
    const item = await workItemsService.getWorkItemByIdentifier(active.projectId, key, ctx);
    // ⚠️ `?since=` IS A QUESTION, NOT A CURSOR. A reader who has been holding
    // this approval open hands back the stamp they were shown, and the read
    // answers what has moved since — through the decide door's own comparison
    // (Story MOTIR-5238 · Subtask MOTIR-5243). Absent, the answer is empty and
    // this route behaves exactly as it did.
    const since = params.get('since');
    const read = await approvalGatesService.getForWorkItem(
      { workItemId: item.id, kind, since },
      ctx,
    );
    const body: ApprovalGateOverlayReadDTO = {
      workItem: { id: item.id, identifier: item.identifier, title: item.title },
      gate: read.gate,
      canDecide: read.canDecide,
      routedToLabel: read.routedToLabel,
      stamp: read.stamp,
      movedSince: read.movedSince,
      earlierApproval: read.earlierApproval,
      subject: await readSubject(kind, read.gate, item, ctx),
    };
    return NextResponse.json(body, {
      // A gate's state changes under the reader by design — never serve a
      // decision that has since been made.
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (err) {
    /* v8 ignore else -- the RE-THROW arm, unreachable for the same reason: every
       class the key resolution raises is answered here; anything else is a real
       fault for Next's error boundary, never a 404. */
    if (isNotAvailable(err)) {
      return NextResponse.json(
        { code: 'NOT_FOUND', error: 'Work item not available.' },
        { status: 404 },
      );
    }
    /* v8 ignore next -- the RE-THROW: every class the key resolution raises is
       answered above; anything else is a real fault for Next's error boundary. */
    throw err;
  }
}
