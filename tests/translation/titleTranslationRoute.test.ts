import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { db } from '@/lib/db';
import type { TitlesTranslateResponseDTO } from '@/lib/dto/workItemTranslation';
import type { Locale } from '@/lib/i18n/locales';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { usersService } from '@/lib/services/usersService';
import { workItemTranslationService } from '@/lib/services/workItemTranslationService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { WorkspaceContext } from '@/lib/workspaces';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `POST /api/projects/[key]/translate-titles` (Story MOTIR-7738 · Subtask
// MOTIR-8831) — the transport over `workItemTranslationService.translateTitlesForReader`.
// The door's own behaviour (switch, bound, store, lock) is
// `tests/integration/translation/titleTranslationDoor.test.ts`; this file pins what
// the route owns: who may ask, which language, the body's shape, and that nothing
// but the DTO reaches the wire.
//
// Real database for the key resolution and browse gate. Stubbed: the workspace
// context (the test env has no cookies), the request's locale (next-intl's request
// scope is not there either), and the door (no motir-ai call).

const ctxRef = { current: null as WorkspaceContext | null };
const localeRef = { current: 'fr' as Locale };

vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});
vi.mock('next-intl/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next-intl/server')>();
  return { ...actual, getLocale: async () => localeRef.current };
});

const { POST } = await import('@/app/api/projects/[key]/translate-titles/route');

const BASE = 'http://localhost:3000';
let fx: WorkItemFixture;
let door: MockInstance<(typeof workItemTranslationService)['translateTitlesForReader']>;

const answer = (over: Partial<TitlesTranslateResponseDTO> = {}): TitlesTranslateResponseDTO => ({
  targetLanguage: 'fr',
  enabled: true,
  truncated: false,
  titles: [
    {
      workItemId: 'a',
      fieldRef: 'title:a',
      status: 'ready',
      text: 'Construire',
      sourceLanguage: 'en',
    },
  ],
  ...over,
});

beforeEach(async () => {
  await truncateAuthTables();
  ctxRef.current = null;
  localeRef.current = 'fr';
  fx = await makeWorkItemFixture({ identifier: 'TTR' });
  door = vi
    .spyOn(workItemTranslationService, 'translateTitlesForReader')
    .mockResolvedValue(answer());
});

afterEach(() => door.mockRestore());

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function post(
  key: string,
  init: { query?: string; body?: unknown; rawBody?: string } = {},
): Promise<Response> {
  const body = init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  return POST(
    new Request(`${BASE}/api/projects/${key}/translate-titles${init.query ?? ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }),
    { params: Promise.resolve({ key }) },
  );
}

const ids = { workItemIds: ['a', 'b'] };

describe('POST /api/projects/[key]/translate-titles — who may ask', () => {
  it('401s with no session, and the door is not called', async () => {
    expect((await post(fx.projectIdentifier, { body: ids })).status).toBe(401);
    expect(door).not.toHaveBeenCalled();
  });

  it('a member gets the door’s answer, called once with the project id, the ids as sent and their locale', async () => {
    ctxRef.current = fx.ctx;
    const res = await post(fx.projectIdentifier, { body: { workItemIds: ['b', 'a', 'b'] } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answer());
    expect(door).toHaveBeenCalledTimes(1);
    expect(door.mock.calls[0]![0]).toEqual({
      projectId: fx.projectId,
      workItemIds: ['b', 'a', 'b'],
      targetLanguage: 'fr',
      actor: fx.ctx,
    });
  });

  it('404s an unknown key and a project in another workspace, with no door call', async () => {
    ctxRef.current = fx.ctx;
    expect((await post('NOPE', { body: ids })).status).toBe(404);

    const stranger = await usersService.createUser({
      email: 'stranger@example.com',
      password: 'hunter2hunter2',
      name: 'Stranger',
    });
    const other = await workspacesService.createWorkspace({
      name: 'Elsewhere',
      ownerUserId: stranger.id,
    });
    ctxRef.current = { userId: stranger.id, workspaceId: other.workspace.id };
    const res = await post(fx.projectIdentifier, { body: ids });
    expect(res.status).toBe(404);
    expect(door).not.toHaveBeenCalled();
  });

  it('404s a Limited member of the workspace who was not added to the project', async () => {
    const limited = await usersService.createUser({
      email: 'limited@example.com',
      password: 'hunter2hunter2',
      name: 'Limited',
    });
    await adminDb.workspaceMembership.create({
      data: {
        userId: limited.id,
        workspaceId: fx.workspaceId,
        workspaceRole: 'member',
        accessScope: 'limited',
      },
    });
    ctxRef.current = { userId: limited.id, workspaceId: fx.workspaceId };
    const res = await post(fx.projectIdentifier, { body: ids });
    expect(res.status).toBe(404);
    expect(door).not.toHaveBeenCalled();
  });
});

describe('POST /api/projects/[key]/translate-titles — a browse refusal inside the door', () => {
  it('is a 404 PROJECT_ACCESS_DENIED for browse and a 403 for another kind', async () => {
    ctxRef.current = fx.ctx;
    door.mockRejectedValueOnce(new ProjectAccessDeniedError(fx.projectId, 'browse'));
    const browse = await post(fx.projectIdentifier, { body: ids });
    expect(browse.status).toBe(404);
    expect(await browse.text()).toContain('PROJECT_ACCESS_DENIED');

    door.mockRejectedValueOnce(new ProjectAccessDeniedError(fx.projectId, 'edit'));
    expect((await post(fx.projectIdentifier, { body: ids })).status).toBe(403);
  });

  it('rethrows an error it does not map', async () => {
    ctxRef.current = fx.ctx;
    door.mockRejectedValueOnce(new Error('boom'));
    await expect(post(fx.projectIdentifier, { body: ids })).rejects.toThrow('boom');
  });
});

describe('POST /api/projects/[key]/translate-titles — the language is the request’s', () => {
  it('a body and a query naming another language, user, organisation and project change nothing', async () => {
    ctxRef.current = fx.ctx;
    localeRef.current = 'ja';
    const res = await post(fx.projectIdentifier, {
      query: '?targetLanguage=zh&language=ko&locale=es&userId=u-x&organizationId=org-x',
      body: {
        ...ids,
        targetLanguage: 'zh',
        language: 'ko',
        locale: 'es',
        userId: 'u-x',
        organizationId: 'org-x',
        projectId: 'p-x',
      },
    });
    expect(res.status).toBe(200);
    const input = door.mock.calls[0]![0];
    expect(input.targetLanguage).toBe('ja');
    expect(input.actor).toEqual(fx.ctx);
    expect(input.projectId).toBe(fx.projectId);
    expect(Object.keys(input).sort()).toEqual([
      'actor',
      'projectId',
      'targetLanguage',
      'workItemIds',
    ]);
  });
});

describe('POST /api/projects/[key]/translate-titles — the body’s shape', () => {
  it.each([
    ['not JSON', { rawBody: '{nope' }],
    ['no body at all', {}],
    ['not an object', { body: ['a'] }],
    ['null', { body: null }],
    ['no workItemIds', { body: { ids: ['a'] } }],
    ['workItemIds not an array', { body: { workItemIds: 'a' } }],
    ['a number entry', { body: { workItemIds: ['a', 3] } }],
    ['a null entry', { body: { workItemIds: [null] } }],
    ['an empty-string entry', { body: { workItemIds: [''] } }],
  ] as const)('400s %s, and the door is not called', async (_name, init) => {
    ctxRef.current = fx.ctx;
    const res = await post(fx.projectIdentifier, init);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('BAD_REQUEST');
    expect(door).not.toHaveBeenCalled();
  });

  it('an empty array is valid and reaches the door', async () => {
    ctxRef.current = fx.ctx;
    expect((await post(fx.projectIdentifier, { body: { workItemIds: [] } })).status).toBe(200);
    expect(door.mock.calls[0]![0].workItemIds).toEqual([]);
  });
});

describe('POST /api/projects/[key]/translate-titles — outcomes on the wire', () => {
  it('no_credit, failed and timeout are 200 entries beside ready ones, with no upstream detail', async () => {
    ctxRef.current = fx.ctx;
    door.mockResolvedValue(
      answer({
        titles: [
          {
            workItemId: 'a',
            fieldRef: 'title:a',
            status: 'ready',
            text: 'X',
            sourceLanguage: 'en',
          },
          { workItemId: 'b', fieldRef: 'title:b', status: 'no_credit' },
          { workItemId: 'c', fieldRef: 'title:c', status: 'failed' },
          { workItemId: 'd', fieldRef: 'title:d', status: 'timeout' },
        ],
      }),
    );
    const res = await post(fx.projectIdentifier, { body: ids });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect((JSON.parse(raw) as TitlesTranslateResponseDTO).titles.map((t) => t.status)).toEqual([
      'ready',
      'no_credit',
      'failed',
      'timeout',
    ]);
    for (const leak of ['reason', 'organizationId', 'model', 'motir-ai', 'unavailable']) {
      expect(raw).not.toContain(leak);
    }
  });

  it('enabled:false and truncated:true pass through unchanged, with one door call each', async () => {
    ctxRef.current = fx.ctx;
    door.mockResolvedValueOnce(answer({ enabled: false, titles: [] }));
    const off = await post(fx.projectIdentifier, { body: ids });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual(answer({ enabled: false, titles: [] }));
    expect(door).toHaveBeenCalledTimes(1);

    door.mockResolvedValueOnce(answer({ truncated: true }));
    const cut = await post(fx.projectIdentifier, { body: ids });
    expect(((await cut.json()) as TitlesTranslateResponseDTO).truncated).toBe(true);
    expect(door).toHaveBeenCalledTimes(2);
  });
});
