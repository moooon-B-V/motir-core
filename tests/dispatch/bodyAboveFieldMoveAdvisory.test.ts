import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { buildDispatchProseAdvisories } from '@/lib/services/proseGraphAdvisoryService';
import { workItemsService } from '@/lib/services/workItemsService';
import { plansService } from '@/lib/services/plansService';
import { planValidityService } from '@/lib/services/planValidityService';
import { sprintsService } from '@/lib/services/sprintsService';
import { runDispatchPrompt } from '@/lib/mcp/tools/dispatchPrompt';
import { runClaimNextReady } from '@/lib/mcp/tools/claimNextReady';
import { runValidateWorkItem } from '@/lib/mcp/tools/validateWorkItem';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { dispatchPromptSchema, presentDispatchPrompt } from '@/lib/api/v1/workLoop/schema';
import {
  isBodyAboveFieldMoveAdvisory,
  type WorkItemDto,
  type WorkItemValidityAdvisoryDto,
  type WorkItemValidityDto,
} from '@/lib/dto/workItems';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE BODY-EDIT-ABOVE-FIELD-MOVE advisory (MOTIR-5399) — over REAL Postgres,
// through the revision trail the real write paths record. The pure predicate and
// the MOTIR-4513 specimen trail are pinned in
// `tests/workItems/bodyAboveFieldMove.test.ts`; this suite pins that the trail is
// READ, and that the finding reaches every surface a card is judged on:
// `validate_work_item`, `dispatch_prompt` (DTO, prompt and summary),
// `claim_next_ready`, and the public `/api/v1` wire shape.
//
// ⚠️ AND the family's invariant: NEVER A GATE. Every readiness assertion below
// exists to fail loudly if this is "improved" into a blocker — its false-positive
// class is the ordinary correction (re-type, then rewrite the body to match),
// which a gate would hold out of the ready set with no override.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A card whose body names nothing, is sized well and draws nothing — every OTHER
 *  check in the family is silent on it, which is the MOTIR-4513 shape. */
async function makeCard(fx: WorkItemFixture, title = 'Record the sourcing position') {
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title,
      descriptionMd: 'Decide the sourcing position.\n\n## Acceptance criteria\n\n- It is decided.',
      type: 'decision',
      storyPoints: 3,
      estimateMinutes: 45,
    },
    fx.ctx,
  );
}

/** The specimen's two writes: a FIELD MOVE, then a BODY-ONLY edit on top of it. */
async function moveThenRevertBody(card: WorkItemDto, fx: WorkItemFixture): Promise<void> {
  await workItemsService.updateWorkItem(
    card.id,
    { type: 'content', title: 'RECORD the sourcing position' },
    fx.ctx,
  );
  await workItemsService.updateWorkItem(
    card.id,
    { descriptionMd: 'Decide — as a decision — the sourcing position.' },
    fx.ctx,
  );
}

const onlyThis = (advisories: readonly WorkItemValidityAdvisoryDto[]) =>
  advisories.filter(isBodyAboveFieldMoveAdvisory);

async function validate(card: WorkItemDto, fx: WorkItemFixture) {
  const res = await runValidateWorkItem({ key: card.identifier }, fx.ctx);
  expect(res.isError).toBeFalsy();
  return {
    result: res.structuredContent as unknown as WorkItemValidityDto,
    text: (res.content as { text: string }[])[0]!.text,
  };
}

describe('the finding — read off the trail the write paths record', () => {
  it('FIRES on a body-only edit sitting directly above a field move, naming both writes', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    await moveThenRevertBody(card, fx);

    const found = onlyThis(await buildDispatchProseAdvisories(card, fx.ctx));
    expect(found).toHaveLength(1);
    const [a] = found;
    expect(a!.item).toBe(card.identifier);
    expect(a!.bodyEdit.fields).toEqual(['descriptionMd']);
    expect(a!.fieldMove.fields).toEqual(['title', 'type']);
    // Both instants are real ISO stamps, in the right order.
    expect(Date.parse(a!.bodyEdit.at)).toBeGreaterThanOrEqual(Date.parse(a!.fieldMove.at));
  });

  it('says NOTHING about a card created and then finished with a body-only write', async () => {
    // The shape of nearly every planned card: create_work_item takes no
    // explanationMd, so an update writes it straight after.
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    await workItemsService.updateWorkItem(card.id, { explanationMd: 'Why it matters.' }, fx.ctx);

    expect(onlyThis(await buildDispatchProseAdvisories(card, fx.ctx))).toEqual([]);
  });

  it('says NOTHING when the fields have the last word — body first, then the move', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    await workItemsService.updateWorkItem(card.id, { descriptionMd: 'Rewritten.' }, fx.ctx);
    await workItemsService.updateWorkItem(card.id, { type: 'content' }, fx.ctx);

    expect(onlyThis(await buildDispatchProseAdvisories(card, fx.ctx))).toEqual([]);
  });

  it('a status move on top does not hide it — the run picking the card up is not a correction', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    await moveThenRevertBody(card, fx);
    await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);

    expect(onlyThis(await buildDispatchProseAdvisories(card, fx.ctx))).toHaveLength(1);
  });

  it('goes quiet once a later body pass sits on top — the corrective re-authoring', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    await moveThenRevertBody(card, fx);
    await workItemsService.updateWorkItem(
      card.id,
      { explanationMd: 'Written against the content type.' },
      fx.ctx,
    );

    expect(onlyThis(await buildDispatchProseAdvisories(card, fx.ctx))).toEqual([]);
  });
});

describe('validate_work_item — the planner’s surface', () => {
  it('reports it in the structured verdict and the text, and the card stays VALID', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    await moveThenRevertBody(card, fx);

    const { result, text } = await validate(card, fx);
    expect(result.valid).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(onlyThis(result.advisories)).toHaveLength(1);
    expect(text).toContain('body-edit-above-field-move');
    expect(text).toContain('that moved title, type');
    expect(text).toContain('Re-read the body against the fields that write moved');
  });
});

describe('dispatch_prompt — the agent is the first party that can notice', () => {
  it('carries it in the DTO and renders it into the prompt and the summary', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    await moveThenRevertBody(card, fx);

    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(onlyThis(dto.advisories)).toHaveLength(1);
    expect(dto.prompt).toContain("THIS CARD'S BODY WAS WRITTEN AFTER ITS FIELDS LAST MOVED");
    expect(dto.prompt).toContain('build to the FIELDS');

    const res = await runDispatchPrompt({ key: card.identifier }, fx.ctx);
    const summary = (res.content as { text: string }[])[0]!.text;
    expect(summary).toContain(`Advisory (NOT a blocker — ${card.identifier} still dispatches)`);
    expect(summary).toContain('that moved title, type');
  });

  it('⚠️ NEVER A GATE — readiness is untouched and the card still reads To Do', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    await moveThenRevertBody(card, fx);

    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(onlyThis(dto.advisories)).toHaveLength(1);
    const { readiness } = await workItemsService.getIssueDetail(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(readiness.ready).toBe(true);
    expect(readiness.openBlockers).toEqual([]);
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(row.status).toBe('todo');
  });

  it('a clean card renders no section — the short-circuit still pays only the one trail read', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);

    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(dto.advisories).toEqual([]);
    expect(dto.prompt).not.toContain('WRITTEN AFTER ITS FIELDS LAST MOVED');
  });

  it('reaches the public /api/v1 wire field by field, and the schema accepts it', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    await moveThenRevertBody(card, fx);

    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    const wire = presentDispatchPrompt(dto);
    expect(dispatchPromptSchema.parse(wire)).toEqual(wire);
    const [a] = onlyThis(dto.advisories);
    expect(wire.advisories).toEqual([
      {
        kind: 'shape',
        item: card.identifier,
        severity: 'body-edit-above-field-move',
        bodyEdit: { at: a!.bodyEdit.at, fields: ['descriptionMd'] },
        fieldMove: { at: a!.fieldMove.at, fields: ['title', 'type'] },
      },
    ]);
  });
});

describe('claim_next_ready — the claimer is told, and the claim stands', () => {
  it('returns it in the payload and the summary, and still claims the card', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    await moveThenRevertBody(card, fx);
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Active' }, fx.ctx);
    await adminDb.workItem.update({ where: { id: card.id }, data: { sprintId: sprint.id } });
    await sprintsService.startSprint(sprint.id, {}, fx.ctx);

    const res = await runClaimNextReady({ projectKey: fx.projectIdentifier }, fx.ctx);
    const struct = res.structuredContent as {
      item: { key: string } | null;
      advisories: WorkItemValidityAdvisoryDto[];
    };
    expect(struct.item?.key).toBe(card.identifier);
    expect(onlyThis(struct.advisories)).toHaveLength(1);
    const text = (res.content as { text: string }[])[0]!.text;
    expect(text).toContain('Advisory (NOT a blocker — the claim stands)');
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(row.status).toBe('in_progress');
  });
});

describe('the PROJECTED path — a plan that rewrites the card supersedes its stored trail', () => {
  async function planWith(fx: WorkItemFixture, workItemId: string, patch: object) {
    const plan = await plansService.createPlan(fx.projectId, { title: 'Plan' }, fx.ctx);
    await plansService.addProposals(plan.id, [{ op: 'modify', workItemId, patch }], fx.ctx);
    await plansService.markPlanned(plan.id, fx.ctx);
    return plan.id;
  }

  it('is NOT reported for a card whose modify rewrites its body — approve writes on top', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    await moveThenRevertBody(card, fx);
    const planId = await planWith(fx, card.id, { descriptionMd: 'Rewritten as content.' });

    const projected = await planValidityService.validateProjectedWorkItem(
      planId,
      card.identifier,
      fx.ctx,
    );
    expect(onlyThis(projected.advisories)).toEqual([]);
  });

  it('IS still reported for a card the plan touches only elsewhere — the trail still stands', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    await moveThenRevertBody(card, fx);
    const planId = await planWith(fx, card.id, { priority: 'high' });

    const projected = await planValidityService.validateProjectedWorkItem(
      planId,
      card.identifier,
      fx.ctx,
    );
    expect(onlyThis(projected.advisories)).toHaveLength(1);
  });
});

describe('workItemRevisionRepository.listRecentKeysByWorkItemIds — the trail read', () => {
  it('returns KEYS only, newest first, bounded per item, and nothing for an empty batch', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeCard(fx);
    const other = await makeCard(fx, 'A second card');
    await moveThenRevertBody(card, fx);

    const read = (ids: string[], perItem: number) =>
      withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        workItemRevisionRepository.listRecentKeysByWorkItemIds(ids, perItem, tx),
      );
    expect(await read([], 20)).toEqual(new Map());

    // A bound of 2 on a 3-row trail: the create falls off the end.
    const byItem = await read([card.id, other.id], 2);
    const trail = byItem.get(card.id)!;
    expect(trail.map((r) => [r.changeKind, [...r.keys].sort()])).toEqual([
      ['updated', ['descriptionMd']],
      ['updated', ['title', 'type']],
    ]);
    expect(trail[0]!.changedAt.getTime()).toBeGreaterThanOrEqual(trail[1]!.changedAt.getTime());
    // The second card's one `created` row, in its own entry.
    expect(byItem.get(other.id)!.map((r) => r.changeKind)).toEqual(['created']);
  });
});
