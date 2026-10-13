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
import type { Locale } from '@/lib/i18n/locales';
import {
  workItemTranslationService,
  type FieldTranslationResult,
} from '@/lib/services/workItemTranslationService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { WorkspaceContext } from '@/lib/workspaces';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `POST /api/work-items/[id]/translate` (Story MOTIR-7735 · Subtask MOTIR-8121) —
// the transport over `workItemTranslationService.translateForReader`. The door's
// own behaviour (kept vs fresh, single flight, keep-only-on-ok) is
// `tests/integration/translation/translationDoor.test.ts`; this file pins what
// the route owns: who may press, which language the press is for, and that a
// per-field failure is an ordinary 200 with no upstream detail in it.
//
// Real database for the access gate. Stubbed: the workspace context (the test
// env has no cookies), the request's locale (next-intl's request scope is not
// there either — it stands in for the session's saved language), and the door's
// `translateWorkItem` (no motir-ai call).

const ctxRef = { current: null as WorkspaceContext | null };
const localeRef = { current: 'de' as Locale };

vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});
vi.mock('next-intl/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next-intl/server')>();
  return { ...actual, getLocale: async () => localeRef.current };
});

const { POST } = await import('@/app/api/work-items/[id]/translate/route');

const BASE = 'http://localhost:3000';
let fx: WorkItemFixture;
let door: MockInstance<(typeof workItemTranslationService)['translateWorkItem']>;

const READY: FieldTranslationResult[] = [
  { fieldRef: 'title', status: 'ready', text: 'Build the export' },
  { fieldRef: 'description', status: 'ready', text: 'The description' },
];

beforeEach(async () => {
  await truncateAuthTables();
  ctxRef.current = null;
  localeRef.current = 'de';
  fx = await makeWorkItemFixture({ identifier: 'TRR' });
  door = vi.spyOn(workItemTranslationService, 'translateWorkItem').mockResolvedValue(READY);
});

afterEach(() => door.mockRestore());

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function post(id: string, init: { query?: string; body?: unknown } = {}): Promise<Response> {
  return POST(
    new Request(`${BASE}/api/work-items/${id}/translate${init.query ?? ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

/** A second person in the item's workspace, holding `role` in its organisation. */
async function personWithOrgRole(role: 'admin' | 'member', email: string) {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: email });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  await adminDb.organizationMembership.updateMany({
    where: { userId: user.id },
    data: { role },
  });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

describe('POST /api/work-items/[id]/translate — who may press', () => {
  it('401s with no session, and the door is not called', async () => {
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Den Export bauen' });
    expect((await post(item.id)).status).toBe(401);
    expect(door).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin', 'member'] as const)(
    'an organisation %s gets the door’s per-field results in their own language',
    async (role) => {
      const item = await createTestWorkItem(fx, { kind: 'task', title: 'Den Export bauen' });
      ctxRef.current =
        role === 'owner' ? fx.ctx : await personWithOrgRole(role, `${role}@example.com`);
      localeRef.current = role === 'member' ? 'fr' : 'en';

      const res = await post(item.id);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ targetLanguage: localeRef.current, fields: READY });
      expect(door).toHaveBeenCalledTimes(1);
      expect(door.mock.calls[0]![0]).toMatchObject({
        workItemId: item.id,
        targetLanguage: localeRef.current,
        actor: ctxRef.current,
      });
    },
  );

  it('404s an unknown item and an item in another workspace, without calling the door', async () => {
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Geheimer Titel' });
    ctxRef.current = fx.ctx;
    expect((await post('ckunknownworkitem0000000')).status).toBe(404);

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
    const res = await post(item.id);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('Geheimer Titel');
    expect(door).not.toHaveBeenCalled();
  });
});

describe('POST /api/work-items/[id]/translate — the language is the session’s, never the request’s', () => {
  it('a body and a query naming another language, user and organisation change nothing', async () => {
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Den Export bauen' });
    const other = await personWithOrgRole('member', 'other@example.com');
    ctxRef.current = fx.ctx;
    localeRef.current = 'ja';

    const res = await post(item.id, {
      query: '?targetLanguage=zh&lang=zh&userId=' + other.userId + '&organizationId=org-x',
      body: {
        targetLanguage: 'zh',
        language: 'ko',
        locale: 'es',
        userId: other.userId,
        organizationId: 'org-x',
      },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { targetLanguage: string }).targetLanguage).toBe('ja');
    const input = door.mock.calls[0]![0];
    expect(input.targetLanguage).toBe('ja');
    expect(input.actor).toEqual(fx.ctx);
    expect(Object.keys(input).sort()).toEqual(['actor', 'targetLanguage', 'workItemId']);
  });
});

describe('POST /api/work-items/[id]/translate — per-field outcomes', () => {
  it('no_credit, failed and timeout are 200 entries beside ready ones, with no upstream detail', async () => {
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Den Export bauen' });
    ctxRef.current = fx.ctx;
    door.mockResolvedValue([
      { fieldRef: 'title', status: 'ready', text: 'Build the export' },
      { fieldRef: 'description', status: 'no_credit' },
      { fieldRef: 'explanation', status: 'failed', reason: 'unavailable' },
      { fieldRef: 'todo:t1:text', status: 'timeout' },
    ]);

    const res = await post(item.id);
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(JSON.parse(raw)).toEqual({
      targetLanguage: 'de',
      fields: [
        { fieldRef: 'title', status: 'ready', text: 'Build the export' },
        { fieldRef: 'description', status: 'no_credit' },
        { fieldRef: 'explanation', status: 'failed' },
        { fieldRef: 'todo:t1:text', status: 'timeout' },
      ],
    });
    // The machine reason is the door's, for logs and tests — never the wire's.
    for (const leak of ['reason', 'unavailable', 'organizationId', 'model', 'motir-ai', 'http']) {
      expect(raw).not.toContain(leak);
    }
  });
});
