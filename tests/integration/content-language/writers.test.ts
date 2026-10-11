import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as aiFileBug } from '@/app/api/internal/ai/work-items/route';
import { POST as v1Create } from '@/app/api/v1/projects/[projectKey]/work-items/route';
import { GET as v1Read } from '@/app/api/v1/work-items/[key]/route';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';
import { createV1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { callMcp, mcpOk, orgIn, setOrgLanguage, storedLanguages } from './_fixtures';

// Story MOTIR-7731 (MOTIR-8099) — EVERY writer records the organisation's
// content language when no language is named: the work item service, a to-do,
// plan approval (its own hand-built inserts), the AI bug filer, the MCP tools
// and the REST door. The organisation is in Japanese throughout, so a recorded
// `ja` can only have come from the organisation. Real Postgres.

const SECRET = 'core-callback-secret-test';

beforeEach(async () => {
  await truncateAuthTables();
  resetRateLimitStore();
  process.env['CORE_CALLBACK_SECRET'] = SECRET;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Languages = { title: string | null; description: string | null; explanation: string | null };
type Todo = { id: string; textLanguage: string | null; notesLanguage: string | null };

describe('the work item service', () => {
  it('records ja on all three fields, and null on an explanation it was not given', async () => {
    const fx = await orgIn('ja');
    const full = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'タイトル',
        descriptionMd: '本文',
        explanationMd: '理由',
      },
      fx.ctx,
    );
    expect(await storedLanguages(full.id)).toEqual(['ja', 'ja', 'ja']);

    const bare = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: '短い', descriptionMd: '本文' },
      fx.ctx,
    );
    expect(await storedLanguages(bare.id)).toEqual(['ja', 'ja', null]);
  });

  it('records ja on a to-do’s text and notes, and null on notes it was not given', async () => {
    const fx = await orgIn('ja');
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'T' },
      fx.ctx,
    );
    const withNotes = await workItemTodosService.addTodo(
      item.id,
      { text: '手順', notesMd: 'メモ' },
      fx.ctx,
    );
    const bare = await workItemTodosService.addTodo(item.id, { text: '手順二' }, fx.ctx);
    expect([withNotes.todo.textLanguage, withNotes.todo.notesLanguage]).toEqual(['ja', 'ja']);
    expect([bare.todo.textLanguage, bare.todo.notesLanguage]).toEqual(['ja', null]);
  });
});

describe('plan approval', () => {
  it('records ja on what it materialises, and the temp-ref rewrite changes no language', async () => {
    const fx = await orgIn('ja');
    const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);
    const afterB = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: '兄弟', kind: 'task' } }],
      fx.ctx,
    );
    const bId = afterB.items[0]!.id;
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: '本体',
            kind: 'task',
            descriptionMd: `[兄弟](motir-ref:planItem:${bId}) を待つ。`,
            explanationMd: '理由',
            todos: [{ text: '手順', notesMd: 'メモ' }, { text: '告知' }],
          },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    const a = await adminDb.workItem.findFirstOrThrow({ where: { title: '本体' } });
    const b = await adminDb.workItem.findFirstOrThrow({ where: { title: '兄弟' } });
    expect(a.descriptionMd).toBe(`[兄弟](motir:${b.id}) を待つ。`);
    expect(await storedLanguages(a.id)).toEqual(['ja', 'ja', 'ja']);
    expect(await storedLanguages(b.id)).toEqual(['ja', null, null]);
    const todos = await adminDb.workItemTodo.findMany({
      where: { workItemId: a.id },
      orderBy: { position: 'asc' },
    });
    expect(todos.map((t) => [t.textLanguage, t.notesLanguage])).toEqual([
      ['ja', 'ja'],
      ['ja', null],
    ]);
  });
});

describe('the AI bug filer', () => {
  async function metaTenant() {
    const owner = await usersService.createUser({
      email: 'owner@example.com',
      password: 'hunter2hunter2',
      name: 'Owner',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'moooon',
      ownerUserId: owner.id,
    });
    const project = await projectsService.createProject({
      name: 'motir',
      identifier: 'MOTIR',
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });
    await seedSystemPrincipal({ workspaceId: workspace.id, projectId: project.id });
    await setOrgLanguage(workspace.organizationId, 'ja');
  }

  async function fileBug(body: Record<string, unknown>): Promise<string> {
    const res = await aiFileBug(
      new Request('http://internal/api/internal/ai/work-items', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({ projectKey: 'MOTIR', kind: 'bug', ...body }),
      }),
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  it('records ja with no language, and de when told de', async () => {
    await metaTenant();
    const plain = await fileBug({ title: 'バグ', descriptionMd: '再現' });
    const told = await fileBug({ title: 'Fehler', descriptionMd: 'Schritte', language: 'de' });
    expect((await storedLanguages(plain)).slice(0, 2)).toEqual(['ja', 'ja']);
    expect((await storedLanguages(told)).slice(0, 2)).toEqual(['de', 'de']);
  });
});

describe('the MCP tools, read back through MCP', () => {
  it('create_work_item and add_work_item_todo record ja; get_work_item and list_work_item_todos return it', async () => {
    const fx = await orgIn('ja');
    const { identifier: key } = mcpOk<{ identifier: string }>(
      await callMcp(fx.ctx, 'create_work_item', {
        projectKey: 'PROD',
        kind: 'task',
        title: 'タイトル',
        descriptionMd: '本文',
      }),
    );
    const got = mcpOk<{ item: { languages: Languages } }>(
      await callMcp(fx.ctx, 'get_work_item', { key }),
    );
    expect(got.item.languages).toEqual({ title: 'ja', description: 'ja', explanation: null });

    mcpOk(await callMcp(fx.ctx, 'add_work_item_todo', { key, text: '手順', notesMd: 'メモ' }));
    const list = mcpOk<{ items: Todo[] }>(await callMcp(fx.ctx, 'list_work_item_todos', { key }));
    expect(list.items.map((t) => [t.textLanguage, t.notesLanguage])).toEqual([['ja', 'ja']]);
  });
});

describe('the REST door, read back through REST', () => {
  it('POST records ja; GET returns it', async () => {
    const caller = await createV1ProjectCaller({
      permissions: ['project:browse', 'work_item:edit'],
    });
    await setOrgLanguage(caller.fixture.workspace.organizationId, 'ja');
    const created = await v1Create(
      new Request(`http://localhost:3000/api/v1/projects/${caller.projectKey}/work-items`, {
        method: 'POST',
        headers: { ...caller.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'task', title: 'タイトル', descriptionMd: '本文' }),
      }),
      { params: Promise.resolve({ projectKey: caller.projectKey }) },
    );
    expect(created.status).toBe(201);
    const { key } = (await created.json()) as { key: string };

    const read = await v1Read(
      new Request(`http://localhost:3000/api/v1/work-items/${key}`, { headers: caller.headers }),
      { params: Promise.resolve({ key }) },
    );
    expect(read.status).toBe(200);
    expect(((await read.json()) as { languages: Languages }).languages).toEqual({
      title: 'ja',
      description: 'ja',
      explanation: null,
    });
  });
});
