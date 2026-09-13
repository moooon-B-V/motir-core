import { NextResponse } from 'next/server';
import {
  NotProjectAdminError,
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import {
  MonitorConnectionAlreadyExistsError,
  MonitorConnectionNotFoundError,
  MonitorGrantNotFoundError,
  MonitorProviderCallError,
  UnknownMonitorProviderError,
} from './errors';

// Typed error → HTTP status for the monitor connection surface (Story
// MOTIR-4926 · MOTIR-5260). One module so the four routes cannot map the same
// refusal to different statuses, mirroring
// `lib/projectRepos/errorResponse.ts`.
//
// Returns `null` for anything it does not recognise, so a route re-throws rather
// than flattening an unknown fault into a 400 — an unrecognised error is a bug to
// see in the logs, not a status to invent.

export function mapMonitorError(err: unknown): NextResponse | null {
  // ⚠️ THE ACCESS ARMS COME FIRST, AND THEY ARE NOT OPTIONAL. Every method on
  // `monitorConnectionService` reaches `projectAccessService.assertPermission`,
  // which raises `PermissionDeniedError` — and a mapper that does not know it
  // lets the refusal fall through to a **500 instead of a 403**. That gap has
  // shipped before (six mappers at once, MOTIR-2299), every service test stayed
  // green because only the ROUTE knows its mapper, and
  // `tests/permissions/storyGate.test.ts` guard 3 is what now refuses it — it
  // caught these four routes while this card was being written.
  if (err instanceof ProjectNotFoundError) {
    // 404, and it is also the answer for a project in ANOTHER workspace: the
    // access gate raises this rather than confirming a cross-tenant id is real.
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof PermissionDeniedError) {
    // Same 403 as `ProjectAccessDeniedError`; the body gains the KEY, so a
    // client can say which permission is missing rather than "forbidden".
    return NextResponse.json(
      { code: err.code, error: err.message, permission: err.permission },
      { status: 403 },
    );
  }
  if (err instanceof NotProjectAdminError || err instanceof ProjectAccessDeniedError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 403 });
  }
  if (err instanceof MonitorConnectionNotFoundError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
  }
  if (err instanceof MonitorGrantNotFoundError) {
    // 409, not 404: the PROJECT is real and the caller may manage it — what is
    // missing is a precondition they can create, which is a different
    // instruction to render than "no such thing".
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  if (err instanceof MonitorConnectionAlreadyExistsError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 409 });
  }
  if (err instanceof MonitorProviderCallError) {
    // 502: the failure is UPSTREAM, and the body carries the provider's OWN
    // reason so the room can show a person what the provider actually said.
    return NextResponse.json(
      { code: err.code, error: err.message, providerReason: err.providerReason },
      { status: 502 },
    );
  }
  if (err instanceof UnknownMonitorProviderError) {
    return NextResponse.json({ code: err.code, error: err.message }, { status: 500 });
  }
  return null;
}
