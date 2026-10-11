import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as v1Create } from '@/app/api/v1/projects/[projectKey]/work-items/route';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { InvalidWorkItemLanguageError } from '@/lib/workItems/errors';
import { createV1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { callMcp, mcpOk, orgIn, setOrgLanguage, storedLanguages } from './_fixtures';

// Story MOTIR-7731 (MOTIR-8099) — a language the WRITER names beats the
// organisation's, field by field: `languages` beats `language`, which beats the
// organisation; and a code outside the eleven is refused on every door before
// anything is written. Organisation in Japanese throughout. Real Postgres.

beforeEach(async () => {
  await truncateAuthTables();
  resetRateLimitStore();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Languages = { title: string | null; description: string | null; explanation: string | null };

async function restCaller() {
  const caller = await createV1ProjectCaller({ permissions: ['project:browse', 'work_item:edit'] });
  await setOrgLanguage(caller.fixture.workspace.organizationId, 'ja');
  return caller;
}

function restCreate(caller: Awaited<ReturnType<typeof restCaller>>, body: unknown) {
  return v1Create(
    new Request(`http://localhost:3000/api/v1/projects/${caller.projectKey}/work-items`, {
      method: 'POST',
      headers: { ...caller.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ projectKey: caller.projectKey }) },
  );
}

describe('an explicit language wins', () => {
  it('MCP update with languages.explanation records ko there and leaves the title ja', async () => {
    const fx = await orgIn('ja');
    const { identifier: key } = mcpOk<{ identifier: string }>(
      await callMcp(fx.ctx, 'create_work_item', { projectKey: 'PROD', kind: 'task', title: 'T' }),
    );
    const updated = mcpOk<{ languages: Languages }>(
      await callMcp(fx.ctx, 'update_work_item', {
        key,
        explanationMd: '이유',
        languages: { explanation: 'ko' },
      }),
    );
    expect(updated.languages).toEqual({ title: 'ja', description: null, explanation: 'ko' });
  });

  it('MCP and REST create with language ko record ko', async () => {
    const fx = await orgIn('ja');
    const viaMcp = mcpOk<{ languages: Languages }>(
      await callMcp(fx.ctx, 'create_work_item', {
        projectKey: 'PROD',
        kind: 'task',
        title: '제목',
        descriptionMd: '본문',
        language: 'ko',
      }),
    );
    expect(viaMcp.languages).toEqual({ title: 'ko', description: 'ko', explanation: null });

    const caller = await restCaller();
    const res = await restCreate(caller, {
      kind: 'task',
      title: '제목',
      descriptionMd: '본문',
      language: 'ko',
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { languages: Languages }).languages).toEqual({
      title: 'ko',
      description: 'ko',
      explanation: null,
    });
  });

  it('a per-field languages entry beats language for its field only', async () => {
    const fx = await orgIn('ja');
    const dto = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Titre',
        descriptionMd: 'Text',
        explanationMd: 'Pourquoi',
        language: 'fr',
        languages: { description: 'de' },
      },
      fx.ctx,
    );
    expect(await storedLanguages(dto.id)).toEqual(['fr', 'de', 'fr']);
  });
});

describe('a code outside the eleven is refused, and nothing is written', () => {
  it('on MCP', async () => {
    const fx = await orgIn('ja');
    const res = await callMcp(fx.ctx, 'create_work_item', {
      projectKey: 'PROD',
      kind: 'task',
      title: 'Svenska MCP',
      language: 'sv',
    });
    expect(res.isError).toBe(true);
    expect(await adminDb.workItem.count({ where: { title: 'Svenska MCP' } })).toBe(0);
  });

  it('on REST', async () => {
    const caller = await restCaller();
    const res = await restCreate(caller, { kind: 'task', title: 'Svenska REST', language: 'sv' });
    expect(res.status).toBe(422);
    expect(await adminDb.workItem.count({ where: { title: 'Svenska REST' } })).toBe(0);
  });

  it('on the service', async () => {
    const fx = await orgIn('ja');
    await expect(
      workItemsService.createWorkItem(
        // A caller past the type checker — the value is checked at run time.
        { projectId: fx.projectId, kind: 'task', title: 'Svenska', language: 'sv' as 'en' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidWorkItemLanguageError);
    expect(await adminDb.workItem.count({ where: { title: 'Svenska' } })).toBe(0);
  });
});
