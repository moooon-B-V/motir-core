import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { shaFor } from '../helpers/commitShaFixtures';
import { db } from '@/lib/db';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// A DONE DESIGN CARD IS CLOSED (Story MOTIR-5552 · Subtask MOTIR-5556;
// `docs/decisions/approval-gates.md` §6c SECOND AMENDMENT). All four acts that can
// change a card's design result — publish by pathnames, publish from bytes, the
// upload-grant mint, the withdrawal — are refused with `DesignCardClosedError`
// on a card in the `done` status CATEGORY, write nothing, and behave exactly as
// before once the card is reopened.
//
// Real Postgres. The object store is the one mocked external, as in
// `design-evidence-service.test.ts`, whose shape this mirrors.

const store = new Map<string, { contentType: string; size: number }>();

vi.mock('@/lib/blob/uploader', () => ({
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  putPrivateAttachment: vi.fn(async (pathname: string, bytes: Buffer, contentType: string) => {
    store.set(pathname, { contentType, size: bytes.byteLength });
    return { pathname };
  }),
  signedDownloadUrl: vi.fn(async (pathname: string) => `https://blob.example/signed/${pathname}`),
  deleteAttachmentBlob: vi.fn(async () => {}),
  mintPrivateUploadToken: vi.fn(async () => 'test-token'),
}));

const uploader = await import('@/lib/blob/uploader');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { DesignCardClosedError } = await import('@/lib/designEvidence/errors');
const { makeWorkWaitOn } = await import('../helpers/designWaits');

async function makeDesignCard(fx: WorkItemFixture) {
  const story = await createTestWorkItem(fx, { kind: 'story', title: 'Parent story' });
  const card = await createTestWorkItem(fx, {
    kind: 'subtask',
    title: 'Design — the result panel',
    parentId: story.id,
  });
  // Something waits on the design, so every refusal below is the CLOSED one and
  // never `DESIGN_EVIDENCE_NOTHING_WAITS`.
  await makeWorkWaitOn(card.id, fx);
  return card;
}

function pathnameAssets(fx: WorkItemFixture, workItemId: string, name: string) {
  const prefix = designPrefix(fx.ctx.workspaceId, workItemId);
  store.set(`${prefix}${name}`, { contentType: 'text/html', size: 2048 });
  store.set(`${prefix}${name}.notes.md`, { contentType: 'text/markdown', size: 512 });
  return [
    { kind: 'mock' as const, sourcePath: `design/x/${name}`, pathname: `${prefix}${name}` },
    {
      kind: 'note_file' as const,
      sourcePath: 'design/x/design-notes.md',
      pathname: `${prefix}${name}.notes.md`,
    },
  ];
}

function publishPathnames(fx: WorkItemFixture, workItemId: string, name: string) {
  return designEvidenceService.recordFromPathnames(
    { workItemId, assets: pathnameAssets(fx, workItemId, name), commitSha: shaFor(name) },
    fx.ctx,
  );
}

function publishBytes(fx: WorkItemFixture, workItemId: string, name: string) {
  return designEvidenceService.recordFromBytes(
    {
      workItemId,
      commitSha: shaFor(name),
      assets: [
        {
          kind: 'mock',
          sourcePath: `design/x/${name}`,
          contentType: 'text/html',
          bytes: Buffer.from('<p>mock</p>'),
        },
        {
          kind: 'note_file',
          sourcePath: 'design/x/design-notes.md',
          contentType: 'text/markdown',
          bytes: Buffer.from('# notes'),
        },
      ],
    },
    fx.ctx,
  );
}

function mint(fx: WorkItemFixture, workItemId: string) {
  return designEvidenceService.createUploadTokens(
    {
      workItemId,
      files: [{ kind: 'mock', sourcePath: 'design/x/m.mock.html', contentType: 'text/html' }],
    },
    fx.ctx,
  );
}

async function setStatus(workItemId: string, status: string) {
  await adminDb.workItem.update({ where: { id: workItemId }, data: { status } });
}

/** Everything a refused act must have left untouched, as one comparable value. */
async function footprint(workItemId: string) {
  const [evidence, current, assets, attachments, gates, withdrawn] = await Promise.all([
    adminDb.designEvidence.count({ where: { workItemId } }),
    adminDb.designEvidence.findFirst({ where: { workItemId, isCurrent: true } }),
    adminDb.designAsset.count({ where: { designEvidence: { workItemId } } }),
    adminDb.attachment.count({ where: { workItemId } }),
    adminDb.approvalGate.findMany({ where: { workItemId }, select: { id: true, state: true } }),
    adminDb.designEvidence.count({ where: { workItemId, withdrawnAt: { not: null } } }),
  ]);
  return { evidence, currentId: current?.id ?? null, assets, attachments, gates, withdrawn };
}

beforeEach(async () => {
  store.clear();
  vi.mocked(uploader.putPrivateAttachment).mockClear();
  vi.mocked(uploader.mintPrivateUploadToken).mockClear();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "design_asset", "design_evidence", "attachment" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe.each(['done', 'cancelled'])('a design card at `%s` is CLOSED', (closedStatus) => {
  it('refuses a publish by pathnames and writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeDesignCard(fx);
    await publishPathnames(fx, card.id, 'v1.mock.html');
    await setStatus(card.id, closedStatus);
    const before = await footprint(card.id);

    const err = await publishPathnames(fx, card.id, 'v2.mock.html').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DesignCardClosedError);
    expect(err).toMatchObject({ code: 'DESIGN_CARD_CLOSED', status: 409 });
    expect(await footprint(card.id)).toEqual(before);
  });

  it('refuses a publish from bytes BEFORE anything is uploaded', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeDesignCard(fx);
    await setStatus(card.id, closedStatus);
    const before = await footprint(card.id);

    await expect(publishBytes(fx, card.id, 'v1.mock.html')).rejects.toBeInstanceOf(
      DesignCardClosedError,
    );
    expect(uploader.putPrivateAttachment).not.toHaveBeenCalled();
    expect(await footprint(card.id)).toEqual(before);
  });

  it('refuses the upload-grant mint and returns no grant', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeDesignCard(fx);
    await setStatus(card.id, closedStatus);

    await expect(mint(fx, card.id)).rejects.toBeInstanceOf(DesignCardClosedError);
    expect(uploader.mintPrivateUploadToken).not.toHaveBeenCalled();
  });

  it('refuses a withdrawal and leaves the current result current', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeDesignCard(fx);
    const published = await publishPathnames(fx, card.id, 'v1.mock.html');
    await setStatus(card.id, closedStatus);
    const before = await footprint(card.id);

    await expect(
      designEvidenceService.withdrawCurrentForWorkItem({ workItemId: card.id }, fx.ctx),
    ).rejects.toBeInstanceOf(DesignCardClosedError);
    expect(await footprint(card.id)).toEqual(before);
    expect(before.currentId).toBe(published.id);
  });
});

describe('the refusal message', () => {
  it('names the card, its status and BOTH ways forward', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeDesignCard(fx);
    await setStatus(card.id, 'done');

    const err = (await mint(fx, card.id).catch((e: unknown) => e)) as Error;

    expect(err.message).toContain(card.identifier);
    expect(err.message).toMatch(/reopen the card by hand/);
    expect(err.message).toMatch(/propose a new design card beside the card that needs it/);
    expect(err.message).toMatch(new RegExp(`relates_to ${card.identifier}`));
  });
});

describe('a REOPENED card behaves exactly as before', () => {
  it('publishes (both forms), mints and withdraws once moved done → in_progress', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeDesignCard(fx);
    const v1 = await publishPathnames(fx, card.id, 'v1.mock.html');
    await setStatus(card.id, 'done');
    await expect(publishPathnames(fx, card.id, 'v2.mock.html')).rejects.toBeInstanceOf(
      DesignCardClosedError,
    );

    await setStatus(card.id, 'in_progress');

    const v2 = await publishPathnames(fx, card.id, 'v2.mock.html');
    expect(v2.id).not.toBe(v1.id);
    const v3 = await publishBytes(fx, card.id, 'v3.mock.html');
    expect(v3.id).not.toBe(v2.id);
    expect((await mint(fx, card.id)).targets).toHaveLength(1);
    const withdrawn = await designEvidenceService.withdrawCurrentForWorkItem(
      { workItemId: card.id },
      fx.ctx,
    );
    expect(withdrawn.id).toBe(v3.id);
  });
});

describe('the done test is the status CATEGORY, resolved through the project workflow', () => {
  it('closes a card whose project renamed its done status', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeDesignCard(fx);
    await adminDb.workflowStatus.updateMany({
      where: { projectId: fx.projectId, key: 'done' },
      data: { key: 'shipped' },
    });
    await setStatus(card.id, 'shipped');

    await expect(publishPathnames(fx, card.id, 'v1.mock.html')).rejects.toBeInstanceOf(
      DesignCardClosedError,
    );
  });

  it('does NOT close a card at a status merely KEYED like a terminal one but in another category', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeDesignCard(fx);
    await adminDb.workflowStatus.updateMany({
      where: { projectId: fx.projectId, key: 'done' },
      data: { key: 'shipped' },
    });
    await adminDb.workflowStatus.updateMany({
      where: { projectId: fx.projectId, key: 'in_review' },
      data: { key: 'done' },
    });
    await setStatus(card.id, 'done');

    const published = await publishPathnames(fx, card.id, 'v1.mock.html');
    expect((await footprint(card.id)).currentId).toBe(published.id);
  });
});
