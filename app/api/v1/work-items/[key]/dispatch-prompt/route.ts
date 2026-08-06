import { NextResponse } from 'next/server';
import { withV1Route } from '@/lib/api/v1/route';
import { InvalidRequestError } from '@/lib/api/v1/errors';
import { resolveWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import { presentDispatchPrompt } from '@/lib/api/v1/workLoop/schema';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';

// GET /api/v1/work-items/{key}/dispatch-prompt (Story 11.7 · Subtask 11.7.3 —
// MOTIR-2237) — the first WORK-LOOP operation on the public API, and the one
// `motir run` / `next` / `auto` / `batch` are built out of.
//
// ── A READ, and the whole endpoint turns on it staying one ──────────────────
// Fetching a prompt does NOT claim the item, does NOT move its status, and does
// NOT change its recorded `session_branch`. Printing a prompt to look at it must
// never mutate the plan — an agent orchestrator that could not preview work
// without taking it would have no safe way to decide what to take. The service
// enforces this (it reads and assembles; the claim lives in `claim_next_ready`),
// and the suite asserts the row is byte-identical before and after, including
// for an item already `in_progress`.
//
// ── `sessionBranch` is a FALLBACK the server may ignore ─────────────────────
// It seeds an unattended run when the item has no lineage of its own. It never
// OVERRIDES: an item whose dependencies are already integrated, or that is
// itself integrated, keeps its own branch. That is the one way this endpoint
// could corrupt state — redirecting a live lineage onto a caller-supplied branch
// would strand an integrated chain across two branches — so it is asserted
// directly rather than trusted to the service.
//
// ── The branch pattern is validated HERE, before the read ───────────────────
// The seed is INTERPOLATED INTO PROMPT TEXT that instructs an agent to run
// `git … origin/<branch>`, so a name carrying whitespace, a shell metacharacter
// or a leading `-` would become a command an agent might run on the caller's
// behalf. Refusing those is cheaper than escaping them and every real branch name
// passes. The MCP tool refuses the same set at its own boundary
// (`lib/mcp/tools/dispatchPrompt.ts`); this is the same rule re-expressed for
// this transport, not an import from it — v1 never reaches into `lib/mcp/tools`.
//
// Two service calls, both RESOLVE/PROJECT: the key → project resolution and the
// one read. ADR Amendment 3 Q4's bounded-call rule; no `db.*`, no transaction.

/** A git ref name restricted to what may safely be interpolated into the prompt. */
const SEED_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;
const MAX_SEED_BRANCH_LENGTH = 200;

/**
 * Read the optional `?sessionBranch=`.
 *
 * An ABSENT parameter and an EMPTY one are the same thing — no seed — because a
 * client assembling a query string from an optional value would otherwise have
 * to know the difference between omitting the key and sending it blank.
 */
function parseSessionBranch(req: Request): string | null {
  const raw = new URL(req.url).searchParams.get('sessionBranch');
  if (raw === null) return null;
  const branch = raw.trim();
  if (branch === '') return null;
  if (branch.length > MAX_SEED_BRANCH_LENGTH || !SEED_BRANCH_PATTERN.test(branch)) {
    throw new InvalidRequestError(
      'INVALID_SESSION_BRANCH',
      'The `sessionBranch` parameter is not a safe branch name.',
    );
  }
  return branch;
}

export const GET = withV1Route<{ key: string }>({ scope: 'read' }, async (ctx) => {
  // Parse BEFORE reading: an unsafe branch name is the caller's to fix, and
  // answering 422 without a database round-trip is both faster and honest.
  const sessionBranch = parseSessionBranch(ctx.req);
  const { projectId, identifier } = await resolveWorkItemKey(ctx.params.key, ctx.service);

  const dto = await dispatchPromptService.getDispatchPrompt(projectId, identifier, ctx.service, {
    sessionBranch,
  });

  return NextResponse.json(presentDispatchPrompt(dto));
});
