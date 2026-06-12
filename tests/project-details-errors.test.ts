import { describe, expect, it } from 'vitest';
import { projectErrorResponse } from '@/lib/projects/projectErrorResponse';
import {
  AliasNotFoundError,
  IdentifierReservedError,
  IdentifierTakenError,
  IdentifierUnchangedError,
  InvalidAvatarError,
  InvalidIdentifierError,
  InvalidProjectNameError,
  NotProjectAdminError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import {
  AVATAR_COLORS,
  AVATAR_ICONS,
  isValidAvatarColor,
  isValidAvatarIcon,
} from '@/lib/projects/avatar';

// Pure unit tests (no DB) for the Story 6.8 HTTP-mapping + avatar-registry
// contract: every typed error maps to its documented status, an unknown error
// returns null (the route rethrows → 500), and the registry guards accept only
// preset keys.

describe('projectErrorResponse', () => {
  const cases: [Error, number][] = [
    [new ProjectNotFoundError('p'), 404],
    [new AliasNotFoundError('OLD'), 404],
    [new ProjectAccessDeniedError('p', 'edit'), 403],
    [new NotProjectAdminError('p'), 403],
    [new InvalidProjectNameError(), 400],
    [new InvalidIdentifierError('a-b'), 400],
    [new IdentifierUnchangedError('PROD'), 400],
    [new InvalidAvatarError('icon', 'nope'), 400],
    [new IdentifierTakenError('LIVE'), 409],
    [new IdentifierReservedError('MOVE'), 409],
  ];

  it.each(cases)('maps %o to its status', async (err, status) => {
    const res = projectErrorResponse(err);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(status);
    const body = await res!.json();
    expect(body.code).toBe((err as unknown as { code: string }).code);
  });

  it('returns null for an unknown error (the route rethrows → 500)', () => {
    expect(projectErrorResponse(new Error('boom'))).toBeNull();
  });
});

describe('avatar registry', () => {
  it('accepts every preset key and rejects anything else', () => {
    for (const icon of AVATAR_ICONS) expect(isValidAvatarIcon(icon)).toBe(true);
    for (const color of AVATAR_COLORS) expect(isValidAvatarColor(color)).toBe(true);
    expect(isValidAvatarIcon('not-an-icon')).toBe(false);
    expect(isValidAvatarColor('chartreuse')).toBe(false);
  });
});
