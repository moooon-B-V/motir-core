import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { NotProjectAdminError, ProjectNotFoundError } from '@/lib/projects/errors';
import type { ProjectAutoTranslateSettingsDTO } from '@/lib/dto/projectAutoTranslateSettings';

// Transport tests for GET / PATCH /api/projects/[key]/auto-translate (Story
// MOTIR-7738 · Subtask MOTIR-8827). The service's own access, trail and rollback
// rules are proved over a real datastore in
// `settings/project-auto-translate-settings.test.ts`; this file proves what only
// the ROUTE owns: the session gate, the read's browse gate, the body-shape
// refusals (service never called), the typed-error → status mapping and the
// key-not-id handoff.
//
// There is no enumeration of route files to extend for the compliant-session gate:
// `tests/helpers/twoFactorGuardSweeps.ts` discovers routes by scanning
// `app/api/**`, so the new file is covered by that sweep without an edit.

const ctx = { userId: 'user_1', workspaceId: 'ws_1' };
const { requireCompliantWorkspaceContext } = vi.hoisted(() => ({
  requireCompliantWorkspaceContext: vi.fn(),
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantWorkspaceContext }));

const getByKey = vi.fn();
const assertCanBrowse = vi.fn();
const getSettings = vi.fn();
const updateSettings = vi.fn();
vi.mock('@/lib/services/projectsService', () => ({ projectsService: { getByKey } }));
vi.mock('@/lib/services/projectAccessService', () => ({
  projectAccessService: { assertCanBrowse },
}));
vi.mock('@/lib/services/projectAutoTranslateSettingsService', () => ({
  projectAutoTranslateSettingsService: { getSettings, updateSettings },
}));

const { GET, PATCH } = await import('@/app/api/projects/[key]/auto-translate/route');

const dto = (on: boolean): ProjectAutoTranslateSettingsDTO => ({
  autoTranslateWorkContent: on,
  changes: [],
  totalChanges: 0,
});
const params = { params: Promise.resolve({ key: 'MOTIR' }) };
const patch = (body: string) =>
  PATCH(
    new Request('http://x/api/projects/MOTIR/auto-translate', { method: 'PATCH', body }),
    params,
  );
const get = () => GET(new Request('http://x/api/projects/MOTIR/auto-translate'), params);

beforeEach(() => {
  vi.resetAllMocks();
  requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx });
  getByKey.mockResolvedValue({ id: 'proj_1' });
  assertCanBrowse.mockResolvedValue(undefined);
});

describe('session gate', () => {
  it('answers the gate response on both verbs and never reaches the service', async () => {
    requireCompliantWorkspaceContext.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 }),
    });
    expect((await get()).status).toBe(401);
    expect((await patch('{"autoTranslateWorkContent":true}')).status).toBe(401);
    expect(getByKey).not.toHaveBeenCalled();
    expect(getSettings).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
  });
});

describe('GET', () => {
  it('returns the service DTO unmodified, no-store, addressed by the resolved id', async () => {
    getSettings.mockResolvedValue(dto(true));
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual(dto(true));
    expect(getByKey).toHaveBeenCalledWith('MOTIR', ctx);
    expect(assertCanBrowse).toHaveBeenCalledWith('proj_1', ctx);
    expect(getSettings).toHaveBeenCalledWith('proj_1', ctx);
  });

  it('is a 404, never a 403, for a caller who cannot browse', async () => {
    assertCanBrowse.mockRejectedValue(new ProjectNotFoundError('proj_1'));
    const res = await get();
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('PROJECT_NOT_FOUND');
    expect(getSettings).not.toHaveBeenCalled();
  });

  it('is a 404 when the key does not resolve', async () => {
    getByKey.mockRejectedValue(new ProjectNotFoundError('MOTIR'));
    expect((await get()).status).toBe(404);
  });

  it('rethrows an error the mapper does not know', async () => {
    getSettings.mockRejectedValue(new Error('boom'));
    await expect(get()).rejects.toThrow('boom');
  });
});

describe('PATCH', () => {
  it.each([true, false])('flips to %s and returns the DTO', async (value) => {
    updateSettings.mockResolvedValue(dto(value));
    const res = await patch(JSON.stringify({ autoTranslateWorkContent: value }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(dto(value));
    expect(updateSettings).toHaveBeenCalledWith('proj_1', { autoTranslateWorkContent: value }, ctx);
  });

  it('maps a missing project:administer to 403 NOT_PROJECT_ADMIN', async () => {
    updateSettings.mockRejectedValue(new NotProjectAdminError('proj_1'));
    const res = await patch('{"autoTranslateWorkContent":true}');
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_PROJECT_ADMIN');
  });

  it('maps a non-browser to 404 PROJECT_NOT_FOUND', async () => {
    assertCanBrowse.mockRejectedValue(new ProjectNotFoundError('proj_1'));
    const res = await patch('{"autoTranslateWorkContent":true}');
    expect(res.status).toBe(404);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it.each([
    ['not JSON', 'nope'],
    ['not an object', '[true]'],
    ['null', 'null'],
    ['key absent', '{}'],
    ['a string', '{"autoTranslateWorkContent":"true"}'],
    ['a number', '{"autoTranslateWorkContent":1}'],
    ['null value', '{"autoTranslateWorkContent":null}'],
  ])('refuses %s with 400 BAD_REQUEST and no service call', async (_label, body) => {
    const res = await patch(body);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('BAD_REQUEST');
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('rethrows an error the mapper does not know', async () => {
    updateSettings.mockRejectedValue(new Error('boom'));
    await expect(patch('{"autoTranslateWorkContent":true}')).rejects.toThrow('boom');
  });
});
