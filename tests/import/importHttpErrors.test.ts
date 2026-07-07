import { describe, expect, it } from 'vitest';
import { importErrorResponse } from '@/lib/import/httpErrors';
import {
  ImportAlreadyRunningError,
  ImportConnectionConfigError,
  ImportNotFoundError,
  ImportSourceNotConnectedError,
} from '@/lib/import/errors';
import { ConnectorAuthError, ConnectorHttpError } from '@/lib/import/connectors/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';

// Unit test for the import routes' typed-error → HTTP-status mapping (MOTIR-941).
// Pure, no DB — asserts every import-lifecycle error maps to the right status and
// that an unrecognised error is re-thrown (the framework 500 path).

describe('importErrorResponse', () => {
  const cases: Array<[Error, number]> = [
    [new ImportNotFoundError('x'), 404],
    [new ProjectNotFoundError('x'), 404],
    [new ProjectAccessDeniedError('x', 'edit'), 403],
    [new ImportAlreadyRunningError('x'), 409],
    [new ImportSourceNotConnectedError('jira'), 422],
    [new ImportConnectionConfigError('bad'), 422],
    [new ConnectorAuthError(401, 'bad creds', 'jira'), 401],
    [new ConnectorHttpError(500, 'https://x/api', 'boom', 'jira'), 502],
  ];

  it.each(cases)('maps %o to status %i', (err, status) => {
    expect(importErrorResponse(err).status).toBe(status);
  });

  it('re-throws an unrecognised error (the 500 path)', () => {
    const boom = new Error('unexpected');
    expect(() => importErrorResponse(boom)).toThrow(boom);
  });
});
