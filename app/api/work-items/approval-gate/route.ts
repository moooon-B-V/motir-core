import { NextResponse } from 'next/server';
import { getActiveProject } from '@/lib/projects';
import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';
import { workItemsService } from '@/lib/services/workItemsService';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { designEvidenceService } from '@/lib/services/designEvidenceService';
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
// arm, and the no-existence-leak 404. Thin HTTP over three SHIPPED service reads
// and no new one:
//
//   1. `workItemsService.getWorkItemByIdentifier` — the key → item resolution,
//      and the BROWSE gate. `getForWorkItem` binds the workspace but asserts no
//      browse permission, so without this read a reader could ask about a gate
//      on a card in a private project they are not in.
//   2. `approvalGatesService.getForWorkItem` — the frame's own read: the gate of
//      that kind in whatever state, `canDecide` as the AUTHORITY answer, and the
//      live *waiting on* name. Nothing here re-derives any of it.
//   3. `designEvidenceService.getForGateSubject` — the port, read by the gate's
//      own `subjectId`, only for a kind this build registers.
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
  ctx: ServiceContext,
): Promise<ApprovalGateOverlaySubjectDTO> {
  if (!gate) return { state: 'no_gate' };
  if (!isRegisteredGateKind(kind)) return { state: 'kind_not_built' };
  switch (kind) {
    case 'design_result': {
      const { evidence, filesKept } = await designEvidenceService.getForGateSubject(
        { workItemId: gate.workItemId, subjectId: gate.subjectId },
        ctx,
      );
      return evidence
        ? { state: 'resolved', kind: 'design_result', evidence, filesKept }
        : { state: 'gone' };
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
    const read = await approvalGatesService.getForWorkItem({ workItemId: item.id, kind }, ctx);
    const body: ApprovalGateOverlayReadDTO = {
      workItem: { id: item.id, identifier: item.identifier, title: item.title },
      gate: read.gate,
      canDecide: read.canDecide,
      routedToLabel: read.routedToLabel,
      subject: await readSubject(kind, read.gate, ctx),
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
