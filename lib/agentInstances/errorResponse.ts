import { NextResponse } from 'next/server';
import {
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import {
  AgentInstanceNameInvalidError,
  AgentInstanceNameTakenError,
  AgentInstanceNoTerminalServerError,
  AgentInstanceNotFoundError,
  AgentInstanceNotRunningError,
  AgentInstanceStartRefusedError,
  AgentInstanceStateConflictError,
  AgentInstancesUnavailableError,
  AgentProfileNotOfferedError,
  AgentTerminalNotOwnerError,
} from './errors';

// The agent-instance routes' ONE error mapper (Story MOTIR-6860 · MOTIR-6872).
// Every refusal the lifecycle service raises is a typed error carrying the words
// the Instances page shows, and each becomes a status here — never a 500.
//
// ⚠️ THE ACCESS ARMS COME FIRST, for `lib/monitors/errorResponse.ts`'s reason:
// every operation reaches `projectAccessService.assertPermission('instance:use')`,
// and a mapper that does not know `PermissionDeniedError` turns the refusal into
// a 500 (`tests/permissions/storyGate.test.ts` guard 3 refuses exactly that).

export function mapAgentInstanceError(err: unknown): NextResponse | null {
  if (err instanceof ProjectNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof PermissionDeniedError) {
    return NextResponse.json(
      { code: err.code, error: err.message, permission: err.permission },
      { status: 403 },
    );
  }
  if (err instanceof ProjectAccessDeniedError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
  }
  if (err instanceof AgentTerminalNotOwnerError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
  }
  if (err instanceof AgentInstanceNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof AgentInstanceNameInvalidError || err instanceof AgentProfileNotOfferedError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 400 });
  }
  if (
    err instanceof AgentInstanceNameTakenError ||
    err instanceof AgentInstanceStateConflictError ||
    err instanceof AgentInstanceNotRunningError ||
    err instanceof AgentInstanceNoTerminalServerError
  ) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  if (err instanceof AgentInstanceStartRefusedError) {
    // 402 for money (no paid AI plan, or no credits — as Motir Studio's establish
    // answers `ai_plan_required`), 503 for an answer that could not be read, 429
    // for a cap: a client can tell "pay" from "try again" from "wait or free one"
    // by status alone, and `reason` names the exact rule.
    const status =
      err.reason === 'credits' || err.reason === 'ai_plan_required'
        ? 402
        : err.reason === 'credits_unknown' || err.reason === 'ai_plan_unknown'
          ? 503
          : 429;
    return NextResponse.json(
      { code: err.code, error: err.message, reason: err.reason },
      { status },
    );
  }
  if (err instanceof AgentInstancesUnavailableError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 503 });
  }
  return null;
}
