// Shared typed-error → HTTP-status mapping for the import API routes (Story 7.16
// · MOTIR-941). Kept out of the route files so both `preview` and `run` reuse ONE
// mapping (a route module should export only its HTTP handlers). An unrecognised
// error is re-thrown for the framework's 500 path.

import { NextResponse } from 'next/server';
import {
  ImportAlreadyRunningError,
  ImportConnectionConfigError,
  ImportNotFoundError,
  ImportSourceNotConnectedError,
} from '@/lib/import/errors';
import { ConnectorAuthError, ConnectorError } from '@/lib/import/connectors';
import {
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';

export function importErrorResponse(err: unknown): Response {
  if (err instanceof ImportNotFoundError || err instanceof ProjectNotFoundError) {
    return NextResponse.json({ code: err.code }, { status: 404 });
  }
  if (err instanceof ProjectAccessDeniedError) {
    return NextResponse.json({ code: err.code }, { status: 403 });
  }
  // MOTIR-2353 — the `import:run` refusal. It carries the key it asked for, so a
  // project MEMBER who could run an import yesterday is told exactly which
  // permission they now lack rather than getting an opaque 403. A NON-browser
  // never reaches here: `assertPermission` raises `ProjectNotFoundError` first,
  // which the 404 arm above maps.
  if (err instanceof PermissionDeniedError) {
    return NextResponse.json({ code: err.code, permission: err.permission }, { status: 403 });
  }
  if (err instanceof ImportAlreadyRunningError) {
    return NextResponse.json({ code: err.code }, { status: 409 });
  }
  if (err instanceof ImportSourceNotConnectedError || err instanceof ImportConnectionConfigError) {
    return NextResponse.json({ code: err.code }, { status: 422 });
  }
  if (err instanceof ConnectorAuthError) {
    return NextResponse.json({ code: err.code }, { status: 401 });
  }
  if (err instanceof ConnectorError) {
    return NextResponse.json({ code: err.code }, { status: 502 });
  }
  throw err;
}
