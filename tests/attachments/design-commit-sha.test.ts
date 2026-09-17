import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// A DESIGN RESULT'S `commitSha` IS VALIDATED AND STORED CANONICAL (MOTIR-5620) —
// the same guard MOTIR-5619 put on the acceptance-receipt path, on the sibling
// design-result publish.
//
// The value does two jobs at once: it is the CITATION a reviewer is shown, and
// it is the IDEMPOTENCY KEY that decides whether a redelivery supersedes the
// record somebody is mid-review on. Both jobs need it canonical BEFORE either
// runs, which is why the guard sits on the service rather than on either door.
//
// Real Postgres, with the object store the one mocked external — the shape
// `design-evidence-service.test.ts` and `design-card-closed.test.ts` share.

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

const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { DesignEvidenceCommitShaError } = await import('@/lib/designEvidence/errors');
const { makeWorkWaitOn } = await import('../helpers/designWaits');

/** A real 40-character object id, and the same id spelled three other ways. */
const SHA = '832026b77b2b276ae9ba028b47e603274a4072cd';

async function makeDesignCard(fx: WorkItemFixture) {
  const story = await createTestWorkItem(fx, { kind: 'story', title: 'Parent story' });
  const card = await createTestWorkItem(fx, {
    kind: 'subtask',
    title: 'Design — the result panel',
    parentId: story.id,
  });
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

function publish(fx: WorkItemFixture, workItemId: string, name: string, commitSha?: string | null) {
  return designEvidenceService.recordFromPathnames(
    { workItemId, assets: pathnameAssets(fx, workItemId, name), commitSha },
    fx.ctx,
  );
}

function publishBytes(fx: WorkItemFixture, workItemId: string, commitSha: string) {
  return designEvidenceService.recordFromBytes(
    {
      workItemId,
      commitSha,
      assets: [
        {
          kind: 'mock',
          sourcePath: 'design/x/panel.mock.html',
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

beforeEach(async () => {
  store.clear();
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('a design result’s commitSha is REFUSED when it is not a commit id', () => {
  it.each([
    ['a placeholder', 'not-a-commit'],
    ['a branch name', 'main'],
    ['the literal HEAD', 'HEAD'],
    ['hex too short', 'abc123'],
    ['hex too long', 'a'.repeat(65)],
    ['non-hex characters', 'zzzzzzz'],
    ['an empty string', ''],
  ])('refuses %s', async (_label, bad) => {
    const fx = await makeWorkItemFixture();
    const card = await makeDesignCard(fx);

    await expect(publish(fx, card.id, 'panel.mock.html', bad)).rejects.toBeInstanceOf(
      DesignEvidenceCommitShaError,
    );

    // Nothing was written — the refusal is before the record.
    expect(await adminDb.designEvidence.count({ where: { workItemId: card.id } })).toBe(0);
  });

  it('names the FIELD, so a caller knows which argument to fix', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeDesignCard(fx);

    await expect(publish(fx, card.id, 'panel.mock.html', 'not-a-commit')).rejects.toThrow(
      /commitSha/,
    );
  });

  it('refuses on the BYTES door too, before any blob is written', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeDesignCard(fx);

    await expect(publishBytes(fx, card.id, 'not-a-commit')).rejects.toBeInstanceOf(
      DesignEvidenceCommitShaError,
    );
    // The bytes door uploads before delegating, so a late refusal would leave
    // orphan objects behind. It refuses first.
    expect(store.size).toBe(0);
  });

  it('leaves an ABSENT citation absent — the field is optional', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeDesignCard(fx);

    const dto = await publish(fx, card.id, 'panel.mock.html', null);
    expect(dto.commitSha).toBeNull();
  });
});

describe('a design result’s commitSha is STORED CANONICAL', () => {
  it.each([
    ['a trailing newline', `${SHA}\n`],
    ['surrounding whitespace', `   ${SHA}   `],
    ['upper-case hex', SHA.toUpperCase()],
  ])('accepts and normalises %s', async (_label, spelling) => {
    const fx = await makeWorkItemFixture();
    const card = await makeDesignCard(fx);

    const dto = await publish(fx, card.id, 'panel.mock.html', spelling);
    expect(dto.commitSha).toBe(SHA);
  });

  it('is the IDEMPOTENCY KEY: one commit spelled two ways is ONE key', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeDesignCard(fx);

    const first = await publish(fx, card.id, 'panel.mock.html', SHA);
    const second = await publish(fx, card.id, 'panel.mock.html', `${SHA.toUpperCase()}\n`);

    // The redelivery is a NO-OP: the same record comes back...
    expect(second.id).toBe(first.id);
    // ...and no history row was written, so nothing was superseded.
    expect(await adminDb.designEvidence.count({ where: { workItemId: card.id } })).toBe(1);
  });

  it('leaves the pending approval gate AWAITING, not superseded', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeDesignCard(fx);

    await publish(fx, card.id, 'panel.mock.html', SHA);
    await publish(fx, card.id, 'panel.mock.html', `${SHA.toUpperCase()}\n`);

    const gates = await adminDb.approvalGate.findMany({ where: { workItemId: card.id } });
    // A reviewer mid-review keeps the question they were answering.
    expect(gates.every((g) => g.state !== 'superseded')).toBe(true);
  });
});
