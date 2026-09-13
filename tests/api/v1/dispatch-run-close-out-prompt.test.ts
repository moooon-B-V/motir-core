import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { findV1Operation } from '@/lib/api/v1/openapi/registry';
import { dispatchRunCloseOutPromptSchema } from '@/lib/api/v1/workLoop/schema';
import { HOW_TO_TEST_TOOL_NAME, RENDERED_SURFACE_TRIGGER } from '@/lib/dispatch/promptTemplate';
import { assembleRunCloseOutPrompt } from '@/lib/dispatch/runCloseOutPrompt';
import { workItemsService } from '@/lib/services/workItemsService';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { MCP_TOOL_NAMES } from '@/lib/mcp/registry';

// The run CLOSE-OUT prompt (Story MOTIR-4906 · MOTIR-5357). Two halves:
//
//   - the PURE prompt, where every sentence the close-out agent is held to is a
//     substring — ONE publish on the run target, a repos entry per repository,
//     the shared trigger, and nothing committed, pushed, transitioned or opened;
//   - the ROUTE on real Postgres, where the target and the landed cards must
//     come from the run's own record, a run with no scope must be refused, and a
//     run in another workspace must be a 404.

const BASE = 'http://localhost:3000/api/v1';

async function getCloseOut(caller: V1ProjectCaller, id: string): Promise<Response> {
  const { GET } = await import('@/app/api/v1/dispatch-runs/[id]/close-out-prompt/route');
  return GET(
    new Request(`${BASE}/dispatch-runs/${id}/close-out-prompt`, { headers: caller.headers }),
    { params: Promise.resolve({ id }) },
  );
}

const flat = (text: string) => text.replace(/\n\s+/g, ' ');

describe('assembleRunCloseOutPrompt — what the close-out agent is told', () => {
  const prompt = assembleRunCloseOutPrompt({
    runId: 'run-1',
    target: { key: 'ACME-1', kind: 'story', title: 'A story', descriptionMd: 'The story body.' },
    cards: [
      { key: 'ACME-2', title: 'Web half', type: 'code', sessionBranch: 'motir/run-web' },
      { key: 'ACME-3', title: 'API half', type: 'code', sessionBranch: 'motir/run-api' },
    ],
  });

  it('names the run target and every landed card with its session branch', () => {
    expect(prompt).toContain('- ACME-1 (story): A story');
    expect(prompt).toContain('- ACME-2 [code] Web half — on motir/run-web');
    expect(prompt).toContain('- ACME-3 [code] API half — on motir/run-api');
    expect(prompt).toContain('Session branches: motir/run-web, motir/run-api.');
  });

  it('instructs exactly ONE publish on the run target, with a repos entry per repository', () => {
    const text = flat(prompt);
    expect(text).toContain(`Call the ${HOW_TO_TEST_TOOL_NAME} tool ONCE, with key ACME-1`);
    expect(text).toContain('"repos": one entry per repository the run pushed to');
    expect(text).toContain('do not include it');
    expect(MCP_TOOL_NAMES).toContain(HOW_TO_TEST_TOOL_NAME);
  });

  it('interpolates the shared rendered-surface trigger', () => {
    expect(flat(prompt)).toContain(`If any card in this run ${RENDERED_SURFACE_TRIGGER}`);
  });

  it('forbids committing, pushing, touching a pull request, transitioning, and a second publish', () => {
    const text = flat(prompt);
    expect(text).toContain('- commit, push, or open, edit or mark ready any pull request');
    expect(text).toContain('- transition any work item’s status;');
    expect(text).toContain('- publish more than once, or on any key other than ACME-1.');
    expect(text).toContain('If the publish is refused, report the refusal and exit.');
  });
});

describe('GET /api/v1/dispatch-runs/{id}/close-out-prompt', () => {
  let caller: V1ProjectCaller;

  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
    caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
  });

  async function scopedRun(opts: { scope: boolean }) {
    const ctx = caller.fixture.ctx;
    const projectId = caller.fixture.projectId;
    const story = await workItemsService.createWorkItem(
      { projectId, kind: 'story', title: 'Story run', descriptionMd: 'The story.' },
      ctx,
    );
    const mk = (title: string) =>
      workItemsService.createWorkItem(
        { projectId, kind: 'subtask', type: 'code', title, parentId: story.id },
        ctx,
      );
    const [web, api, failed] = [await mk('Web'), await mk('API'), await mk('Failed')];
    const run = await adminDb.dispatchRun.create({
      data: {
        workspaceId: caller.fixture.workspaceId,
        projectId,
        command: opts.scope ? 'run_scope' : 'auto',
        status: 'running',
        ...(opts.scope ? { scopeWorkItemId: story.id } : {}),
        cards: {
          create: [
            {
              workspaceId: caller.fixture.workspaceId,
              workItemId: web.id,
              workItemKey: web.identifier,
              position: 0,
              disposition: 'integrated',
              sessionBranch: 'motir/run-web',
            },
            {
              workspaceId: caller.fixture.workspaceId,
              workItemId: failed.id,
              workItemKey: failed.identifier,
              position: 1,
              disposition: 'failed',
            },
            {
              workspaceId: caller.fixture.workspaceId,
              workItemId: api.id,
              workItemKey: api.identifier,
              position: 2,
              disposition: 'implemented',
              sessionBranch: 'motir/run-api',
            },
          ],
        },
      },
    });
    return { run, story, web, api, failed };
  }

  it('resolves the target and the LANDED cards from the run record, and the body parses', async () => {
    const { run, story, web, api, failed } = await scopedRun({ scope: true });
    const res = await getCloseOut(caller, run.id);
    expect(res.status).toBe(200);
    const body = dispatchRunCloseOutPromptSchema.parse(await res.json());
    expect(body).toMatchObject({
      runId: run.id,
      targetKey: story.identifier,
      landedKeys: [web.identifier, api.identifier],
    });
    expect(body.prompt).toContain(`with key ${story.identifier}`);
    expect(body.prompt).not.toContain(failed.identifier);
  });

  it('422 — NO_RUN_TARGET for a run that was not launched against a work item', async () => {
    const { run } = await scopedRun({ scope: false });
    const res = await getCloseOut(caller, run.id);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'NO_RUN_TARGET' });
  });

  it('404 for an unknown run, and for a run in ANOTHER workspace', async () => {
    const { run } = await scopedRun({ scope: true });
    expect((await getCloseOut(caller, 'no-such-run')).status).toBe(404);

    const stranger = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const res = await getCloseOut(stranger, run.id);
    expect(res.status).toBe(404);
  });

  it('declares work_item:edit, matching its route', () => {
    const op = findV1Operation('GET', '/api/v1/dispatch-runs/{id}/close-out-prompt');
    expect(op?.permission).toBe('work_item:edit');
  });
});
