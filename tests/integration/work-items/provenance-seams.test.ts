import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { WorkItemImplementationSource, WorkItemPlanningSource } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { plansService } from '@/lib/services/plansService';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import { makeWorkItemFixture as makeFixture, type WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// Story-level integration + coverage gate for work-item PROVENANCE (Story
// MOTIR-1685 · MOTIR-1694). The per-subtask floors already cover each write-seam
// in isolation (createIssueAction/manual, write-tools/mcp, plansService/native,
// integration-state/impl); this suite tops up the SEAMS BETWEEN them — every
// source driven through the ACTUAL detail read DTO (`getWorkItemByIdentifier`, the
// shape the UI renders), which is what catches DTO key drift a per-writer unit
// mock masks — plus the enum-totality + client-forge guards the story owns.
// Real Postgres (no mocks), per CLAUDE.md.

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Read a work item back through the detail DTO the UI reads. */
async function readDto(fx: WorkItemFixture, identifier: string) {
  return workItemsService.getWorkItemByIdentifier(fx.projectId, identifier, fx.ctx);
}

describe('provenance write → read-DTO seams (all sources through the detail read)', () => {
  it('MCP planning: source + reported harness/model survive to the DTO', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'mcp',
        provenance: {
          planning: { source: 'mcp', harness: 'Claude Code', model: 'claude-opus-4-8' },
        },
      },
      fx.ctx,
    );
    const dto = await readDto(fx, created.identifier);
    expect(dto.planningSource).toBe('mcp');
    expect(dto.planningHarness).toBe('Claude Code');
    expect(dto.planningModel).toBe('claude-opus-4-8'); // MCP model IS exposed
  });

  it('native planning (via materialize): DTO shows native · Motir with the model STRIPPED', async () => {
    const fx = await makeFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'native',
            kind: 'task',
            planningProvenance: { source: 'native', harness: 'Motir', model: 'deepseek-chat' },
          },
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.approvePlan(plan.id, fx.ctx);

    const row = await db.workItem.findFirstOrThrow({ where: { title: 'native' } });
    expect(row.planningModel).toBe('deepseek-chat'); // recorded for analysis
    const dto = await readDto(fx, row.identifier);
    expect(dto.planningSource).toBe('native');
    expect(dto.planningHarness).toBe('Motir');
    expect(dto.planningModel).toBeNull(); // stripped for the UI/API
  });

  it('BYOK implementation (via mark_integrated): the triple survives to the DTO', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'byok' },
      fx.ctx,
    );
    await workItemsService.updateStatus(created.id, 'in_progress', fx.ctx);
    await workItemsService.markIntegrated(created.id, 'session/x', fx.ctx, {
      source: 'byok',
      harness: 'opencode',
      model: 'deepseek',
    });
    const dto = await readDto(fx, created.identifier);
    expect(dto.implementationSource).toBe('byok');
    expect(dto.implementationHarness).toBe('opencode');
    expect(dto.implementationModel).toBe('deepseek');
    // Planning untouched — this item was never planned with a stamped source.
    expect(dto.planningSource).toBeNull();
  });

  // ── THE FULL CYCLE (MOTIR-2447) ───────────────────────────────────────────
  // The bug this replaces was invisible to a test of either write: both did
  // exactly what their caller asked. It only existed in the SEQUENCE — and the
  // sequence spans a human merging a pull request, which is why nothing crossed
  // it. These drive both writes in order, against the DTO the UI reads.

  it('a run then its CLOSE-OUT: the agent and model survive `complete_session`', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'full cycle' },
      fx.ctx,
    );
    await workItemsService.updateStatus(created.id, 'in_progress', fx.ctx);
    // 1. `motir auto` integrates: it knows the harness and the model.
    await workItemsService.markIntegrated(created.id, 'motir/auto-1', fx.ctx, {
      source: 'byok',
      harness: 'claude',
      model: 'claude-opus-5',
    });
    // 2. a human merges. 3. `motir done --session` closes out knowing ONLY that
    //    the work was BYOK — it ran days after the agent exited.
    await workItemsService.completeSession('motir/auto-1', fx.ctx, { source: 'byok' });

    const dto = await readDto(fx, created.identifier);
    expect(dto.status).toBe('done');
    expect(dto.implementationSource).toBe('byok');
    // Previously `motir-cli/<version>` / null — the close-out overwrote the run's
    // own record with what it happened to hold.
    expect(dto.implementationHarness).toBe('claude');
    expect(dto.implementationModel).toBe('claude-opus-5');
  });

  it('the close-out still STAMPS an item that never reported provenance', async () => {
    // The `--print` lane: a human pastes the prompt into their own agent, so
    // nothing ever calls `mark_integrated`. The close-out is the only thing that
    // knows the work was BYOK, and it must keep saying so.
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'print lane' },
      fx.ctx,
    );
    await workItemsService.updateStatus(created.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(created.id, 'in_review', fx.ctx);
    await db.workItem.update({
      where: { id: created.id },
      data: { sessionBranch: 'motir/auto-2' },
    });
    await workItemsService.completeSession('motir/auto-2', fx.ctx, { source: 'byok' });

    const dto = await readDto(fx, created.identifier);
    expect(dto.implementationSource).toBe('byok');
    // Honestly empty, not filled with the tool that happened to close it out.
    expect(dto.implementationHarness).toBeNull();
    expect(dto.implementationModel).toBeNull();
  });

  it('an OMITTED field is left alone; an explicit null CLEARS it', async () => {
    // The distinction the whole fix rests on, asserted directly at the write.
    // Without it every caller must either overwrite all three or say nothing,
    // and each of them holds a different subset of the answer.
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'partial' },
      fx.ctx,
    );
    await db.$transaction(async (tx) => {
      await workItemsService.recordImplementationProvenance(
        created.id,
        { source: 'byok', harness: 'codex', model: 'gpt-5-codex' },
        tx,
      );
      // Reports the source alone — knows nothing about the other two.
      await workItemsService.recordImplementationProvenance(created.id, { source: 'byok' }, tx);
    });
    let dto = await readDto(fx, created.identifier);
    expect(dto.implementationHarness).toBe('codex');
    expect(dto.implementationModel).toBe('gpt-5-codex');

    // An explicit null is a REPORT — "there is none" — and does clear it.
    await db.$transaction(async (tx) => {
      await workItemsService.recordImplementationProvenance(
        created.id,
        { source: 'byok', harness: null, model: null },
        tx,
      );
    });
    dto = await readDto(fx, created.identifier);
    expect(dto.implementationHarness).toBeNull();
    expect(dto.implementationModel).toBeNull();
  });

  it('the unknown state: an unstamped item reads all-null on both triples', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'blank' },
      fx.ctx,
    );
    const dto = await readDto(fx, created.identifier);
    expect(dto.planningSource).toBeNull();
    expect(dto.planningHarness).toBeNull();
    expect(dto.planningModel).toBeNull();
    expect(dto.implementationSource).toBeNull();
    expect(dto.implementationHarness).toBeNull();
    expect(dto.implementationModel).toBeNull();
  });

  it('client-forge guard: a service caller cannot set a native/hosted source via the create input body (source is explicit in the provenance param only)', async () => {
    const fx = await makeFixture();
    // The create input has no top-level provenance-source field; a forged
    // `planningSource` on the input object is not a typed field and is ignored.
    const created = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'forge',
        // @ts-expect-error — planningSource is NOT a CreateWorkItemInput field.
        planningSource: 'native',
      },
      fx.ctx,
    );
    const dto = await readDto(fx, created.identifier);
    expect(dto.planningSource).toBeNull(); // the forged top-level field never lands
  });
});

// Enum-totality guard (rung-2 total-over-enum rule): the display label lookup
// keyed off each source enum must be TOTAL — every enum value has a localized
// label in BOTH catalogs. An enum addition without a label trips this before it
// can render blank.
describe('provenance source-label totality over the enums', () => {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const en = enMessages.issueViews as unknown as Record<string, string>;
  const zh = zhMessages.issueViews as unknown as Record<string, string>;

  it('every WorkItemPlanningSource value has an en + zh label key', () => {
    for (const value of Object.values(WorkItemPlanningSource)) {
      const key = `provenanceSource${cap(value)}`;
      expect(en[key], `en.json issueViews.${key}`).toBeTruthy();
      expect(zh[key], `zh.json issueViews.${key}`).toBeTruthy();
    }
  });

  it('every WorkItemImplementationSource value has an en + zh label key', () => {
    for (const value of Object.values(WorkItemImplementationSource)) {
      const key = `provenanceSource${cap(value)}`;
      expect(en[key], `en.json issueViews.${key}`).toBeTruthy();
      expect(zh[key], `zh.json issueViews.${key}`).toBeTruthy();
    }
  });
});
