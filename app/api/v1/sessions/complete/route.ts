import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { parseV1Body } from '@/lib/api/v1/workItems/schema';
import {
  presentSessionCloseOut,
  sessionCloseOutBodySchema,
  toProvenanceInput,
} from '@/lib/api/v1/workLoop/schema';
import { workItemsService } from '@/lib/services/workItemsService';

// POST /api/v1/sessions/complete (Story 11.7 · Subtask 11.7.4 — MOTIR-2238) —
// close out a session branch after a human merges its pull request. Every work
// item recorded on the branch moves to `done` and its branch is cleared, in ONE
// transaction.
//
// ── The BRANCH rides in the BODY, and the literal `complete` is RESERVED ────
// ADR Amendment 6 Q1. A session branch is a git ref and routinely contains `/`
// (`subtask/MOTIR-…`): a Next.js `[param]` segment does not match one at all,
// and `%2F` is normalised by proxies and CDNs before a route ever sees it, so
// putting it in the path would make correctness depend on hops we do not
// control. A catch-all segment would "work" and make `refs/heads/x` and its
// encoded form two addresses for one ref.
//
// There is no session ROW — `session_branch` is a column on `work_item` — so
// `sessions` is a collection with no members to address, and the amendment
// records that `GET /api/v1/sessions/{id}` is not available. A bulk write
// addressed by its body is already the shipped idiom
// (`POST /api/v1/projects/{projectKey}/backlog/work-items`).
//
// ── PARTIAL SUCCESS IS A REAL OUTCOME, and 200 is the honest status ─────────
// A branch with a dozen items can legitimately close nine and skip three: the
// service checks the legal transition BEFORE any write and does NOT roll back
// the nine that succeeded. So the request SUCCEEDED — what it did is in the
// per-item `results`, which is the payload. It is not a 500 (nothing faulted),
// not a 422 (the body was fine), and not a 207 (the API has one error envelope
// and one success vocabulary; a status nothing else uses would teach clients a
// second parser for a case they must read the body for anyway). A client reports
// what came back; it never re-derives an outcome from a count.
//
// An UNKNOWN branch is 200 with an empty `results`, not a 404: the branch is not
// a resource, and "nothing was recorded on it" is a true answer to the question
// asked. The service returns exactly that without opening a transaction.

export const POST = withV1Route({ scope: 'integration' }, async (ctx) => {
  const body = await parseV1Body(ctx.req, sessionCloseOutBodySchema);

  const provenance = toProvenanceInput(body);

  // Workspace-scoped by the service: it finds the items on the branch across the
  // caller's accessible projects in THIS workspace, so a branch name shared with
  // another tenant closes nothing of theirs.
  const result = await workItemsService.completeSession(
    body.sessionBranch,
    ctx.service,
    provenance,
  );

  return NextResponse.json(presentSessionCloseOut(result));
});
