import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// A HUMAN DECISION'S RECORD IS A PAGE (Story MOTIR-5761 · MOTIR-7435). Real
// Postgres, through the real publish service and the real decide door: a
// `human` decision card with a published page reports a `page` record (over any
// markdown attachment); Confirm stamps it and FREEZES that version in the
// deciding write; Overturn freezes nothing; a republish while awaiting moves the
// record shown without re-asking. Attachment-only cards keep their record, as
// `decisionConfirmationGate.test.ts` (MOTIR-5954) asserts unchanged.

vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));

const { workItemsService } = await import('@/lib/services/workItemsService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { decisionConfirmationGateService } =
  await import('@/lib/services/decisionConfirmationGateService');
const { decisionPageService } = await import('@/lib/services/decisionPageService');
const { pagesService } = await import('@/lib/services/pagesService');

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const COMPLETE = [
  '## Decision',
  'Exports move to managed object storage.',
  '## What changed',
  '**Change:** workflow',
  'The approved plan kept exports in Postgres.',
  '## Supersedes',
  'MOTIR-6',
  '## Resulting direction',
  'Every export is written to the bucket.',
].join('\n');

async function createDecision() {
  seq += 1;
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title: `Decide ${seq}`,
      type: 'decision',
      executor: 'human',
      descriptionMd: COMPLETE,
    },
    fx.ctx,
  );
}

async function publishPage(workItemId: string, markdown = '# Long form\n\nThe whole story.') {
  const page = await pagesService.createPageFromMarkdown(fx.ctx, {
    projectId: fx.projectId,
    title: 'Exports direction',
    markdown,
  });
  const publication = await decisionPageService.publish({ workItemId, pageId: page.id }, fx.ctx);
  return { page, publication };
}

async function attachMarkdown(workItemId: string) {
  return adminDb.attachment.create({
    data: {
      workspaceId: fx.workspaceId,
      uploaderUserId: fx.ownerId,
      workItemId,
      source: 'panel',
      blobPathname: `attachments/notes-${seq}`,
      mimeType: 'text/markdown',
      sizeBytes: 1234,
      originalFilename: 'notes.md',
      // Newer than the page: precedence is by kind, not by age.
      createdAt: new Date(Date.now() + 60_000),
    },
  });
}

async function waiting(workItemId: string) {
  const read = await approvalGatesService.getForWorkItem(
    { workItemId, kind: 'decision_confirmation' },
    fx.ctx,
  );
  expect(read.gate?.state).toBe('awaiting');
  return { gateId: read.gate!.id, stamp: read.stamp! };
}

const versionRow = (id: string) => adminDb.pageVersion.findUniqueOrThrow({ where: { id } });

describe('a human decision card with a published page', () => {
  it('reports the page as its record, over a newer markdown attachment', async () => {
    const item = await createDecision();
    await attachMarkdown(item.id);
    const { page, publication } = await publishPage(item.id);

    const body = await decisionConfirmationGateService.readBody(item.id, fx.ctx);
    expect(body).not.toBeNull();
    expect(body!.ok ? body!.port.record : null).toEqual({
      kind: 'page',
      pageId: page.id,
      versionId: publication.versionId,
      versionNumber: publication.versionNumber,
      title: 'Exports direction',
    });
  });

  it('Confirm stamps the page record and FREEZES that version under the gate', async () => {
    const item = await createDecision();
    const { page, publication } = await publishPage(item.id);
    const { gateId, stamp } = await waiting(item.id);

    const result = await approvalGatesService.decide(
      { gateId, decision: 'approve', source: 'ui', stamp },
      fx.ctx,
    );

    const record = {
      kind: 'page',
      pageId: page.id,
      versionId: publication.versionId,
      versionNumber: publication.versionNumber,
      title: 'Exports direction',
    };
    expect(result.effect).toEqual({ statusWritten: 'done', confirmedRecord: record });
    const gate = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gateId } });
    expect(gate.confirmedRecord).toEqual(record);
    const version = await versionRow(publication.versionId);
    expect(version.frozenAt).toBeInstanceOf(Date);
    expect(version.frozenByGateId).toBe(gateId);
  });

  it('Overturn freezes nothing: the version stays sealed, not frozen', async () => {
    const item = await createDecision();
    const { publication } = await publishPage(item.id);
    const { gateId, stamp } = await waiting(item.id);

    await approvalGatesService.decide(
      { gateId, decision: 'overturn', source: 'ui', stamp, noteMd: 'Not what we discussed.' },
      fx.ctx,
    );

    const version = await versionRow(publication.versionId);
    expect(version.sealedAt).toBeInstanceOf(Date);
    expect(version.frozenAt).toBeNull();
  });

  it('a republish while awaiting moves the record to the new version without re-asking', async () => {
    const item = await createDecision();
    const { page, publication: first } = await publishPage(item.id);
    const before = await waiting(item.id);

    const current = await pagesService.getPageMarkdown(fx.ctx, {
      projectId: fx.projectId,
      pageId: page.id,
    });
    await pagesService.savePageMarkdown(fx.ctx, {
      projectId: fx.projectId,
      pageId: page.id,
      markdown: '# Long form\n\nThe whole story, revised.',
      expectedRevision: current.revision,
    });
    const second = await decisionPageService.publish(
      { workItemId: item.id, pageId: page.id },
      fx.ctx,
    );
    expect(second.versionNumber).toBe(first.versionNumber + 1);

    const after = await waiting(item.id);
    expect(after.gateId).toBe(before.gateId);
    const body = await decisionConfirmationGateService.readBody(item.id, fx.ctx);
    expect(body!.ok ? body!.port.record : null).toMatchObject({
      kind: 'page',
      versionId: second.versionId,
    });

    await approvalGatesService.decide(
      { gateId: after.gateId, decision: 'approve', source: 'ui', stamp: after.stamp },
      fx.ctx,
    );
    expect((await versionRow(second.versionId)).frozenByGateId).toBe(after.gateId);
    expect((await versionRow(first.versionId)).frozenAt).toBeNull();
  });
});
