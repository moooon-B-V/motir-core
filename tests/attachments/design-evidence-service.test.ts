import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// designEvidenceService (Story MOTIR-2664 · Subtask MOTIR-2666) against a REAL
// Postgres. The Blob adapter is the ONE mocked external (no network); every
// gate + the supersede/RLS write go through the real path. Under test the `db`
// role bypasses RLS, so direct reads assert committed state.
//
// `headPrivateBlob` is the load-bearing mock: the service reads each artifact's
// AUTHORITATIVE size + contentType from the store rather than trusting the
// caller, so the fake store is what lets us prove a lying pathname is rejected.

const store = new Map<string, { contentType: string; size: number }>();

vi.mock('@/lib/blob/uploader', () => ({
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  putPrivateAttachment: vi.fn(async (pathname: string) => ({ pathname })),
  signedDownloadUrl: vi.fn(async (pathname: string) => `https://blob.example/signed/${pathname}`),
  deleteAttachmentBlob: vi.fn(async () => {}),
  mintPrivateUploadToken: vi.fn(async () => 'test-token'),
}));

const {
  designEvidenceService,
  designPrefix,
  capNoteMd,
  translateSupersedeConflict,
  NOTE_MD_CAP_BYTES,
} = await import('@/lib/services/designEvidenceService');
const { attachmentsService } = await import('@/lib/services/attachmentsService');
const { designEvidenceRepository } = await import('@/lib/repositories/designEvidenceRepository');
const {
  DesignEvidenceEmptyError,
  DesignEvidenceNotALeafError,
  DesignEvidencePathnameError,
  DesignEvidenceBlobMissingError,
  DesignEvidenceSupersedeConflictError,
  DesignEvidenceNotFoundError,
  DesignEvidenceNoCurrentResultError,
} = await import('@/lib/designEvidence/errors');
const { UnsupportedFileTypeError, FileTooLargeError } = await import('@/lib/blob/errors');
const { isAllowedUploadType, isAllowedDesignAssetType } = await import('@/lib/blob/allowlist');

/**
 * A design subtask under a story. The subtask needs a real parent — the
 * kind-parent matrix is enforced by a DB TRIGGER (`WI_SUBTASK_NEEDS_PARENT`),
 * not just by the service — so the fixture builds the pair.
 */
async function makeSubtask(fx: WorkItemFixture) {
  const story = await createTestWorkItem(fx, { kind: 'story', title: 'Parent story' });
  return createTestWorkItem(fx, {
    kind: 'subtask',
    title: 'Design — the result panel',
    parentId: story.id,
  });
}

/** Put a fake object in the store and return the asset input pointing at it. */
function seedAsset(
  fx: WorkItemFixture,
  workItemId: string,
  opts: {
    kind: 'mock' | 'image' | 'note_file';
    name: string;
    contentType: string;
    size?: number;
    sourcePath?: string;
  },
) {
  const pathname = `${designPrefix(fx.ctx.workspaceId, workItemId)}${opts.name}`;
  store.set(pathname, { contentType: opts.contentType, size: opts.size ?? 2048 });
  return {
    kind: opts.kind,
    sourcePath: opts.sourcePath ?? `design/work-items/${opts.name}`,
    pathname,
  };
}

beforeEach(async () => {
  store.clear();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "design_asset", "design_evidence", "attachment" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('designEvidenceService.recordFromPathnames', () => {
  it('records the three-file result → evidence + ordered assets + linked design_asset attachments', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);

    const dto = await designEvidenceService.recordFromPathnames(
      {
        workItemId: card.id,
        assets: [
          seedAsset(fx, card.id, {
            kind: 'mock',
            name: 'design-result.mock.html',
            contentType: 'text/html',
          }),
          seedAsset(fx, card.id, {
            kind: 'image',
            name: 'design-result.png',
            contentType: 'image/png',
          }),
          seedAsset(fx, card.id, {
            kind: 'note_file',
            name: 'design-notes.md',
            contentType: 'text/markdown',
          }),
        ],
        noteMd: '## The Design result panel\n\nProse.',
        commitSha: 'abc1234',
        ciRunUrl: 'https://ci.example/run/1',
        producedByKey: 'MOTIR-2669',
      },
      fx.ctx,
    );

    expect(dto.workItemId).toBe(card.id);
    expect(dto.noteMd).toContain('## The Design result panel');
    expect(dto.noteTruncated).toBe(false);
    expect(dto.commitSha).toBe('abc1234');
    expect(dto.producedByKey).toBe('MOTIR-2669');

    // Assets come back in render order, each with an authenticated content path.
    expect(dto.assets.map((a) => a.kind)).toEqual(['mock', 'image', 'note_file']);
    expect(dto.assets.map((a) => a.position)).toEqual([0, 1, 2]);
    for (const asset of dto.assets) {
      expect(asset.url).toContain('/api/attachments/');
      expect(asset.url).toContain('/content');
    }
    expect(dto.assets[0]!.mimeType).toBe('text/html');
    expect(dto.assets[0]!.sourcePath).toBe('design/work-items/design-result.mock.html');

    // Attachments are source design_asset and LINKED to the item, so the
    // orphan-GC leaves the current set alone.
    const atts = await adminDb.attachment.findMany({ where: { workItemId: card.id } });
    expect(atts).toHaveLength(3);
    expect(new Set(atts.map((a) => a.source))).toEqual(new Set(['design_asset']));

    // Exactly one current evidence row.
    expect(
      await adminDb.designEvidence.count({ where: { workItemId: card.id, isCurrent: true } }),
    ).toBe(1);
  });

  it('a design result is a SET — a PR with two mocks and no PNG records both, no placeholder', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);

    const dto = await designEvidenceService.recordFromPathnames(
      {
        workItemId: card.id,
        assets: [
          seedAsset(fx, card.id, { kind: 'mock', name: 'a.mock.html', contentType: 'text/html' }),
          seedAsset(fx, card.id, { kind: 'mock', name: 'b.mock.html', contentType: 'text/html' }),
        ],
      },
      fx.ctx,
    );

    expect(dto.assets).toHaveLength(2);
    expect(dto.assets.every((a) => a.kind === 'mock')).toBe(true);
  });

  it('records a MINIMAL publish — no note, no provenance — without inventing values', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);

    const dto = await designEvidenceService.recordFromPathnames(
      {
        workItemId: card.id,
        assets: [
          seedAsset(fx, card.id, { kind: 'mock', name: 'm.mock.html', contentType: 'text/html' }),
        ],
      },
      fx.ctx,
    );

    // A PR that changed only a mock publishes exactly that: the note is ABSENT,
    // not an empty string, and the provenance fields stay null rather than
    // being back-filled with something plausible.
    expect(dto.noteMd).toBeNull();
    expect(dto.noteTruncated).toBe(false);
    expect(dto.commitSha).toBeNull();
    expect(dto.ciRunUrl).toBeNull();
    expect(dto.producedByKey).toBeNull();
    expect(dto.assets).toHaveLength(1);
  });

  it('a publish with no commit sha is NOT idempotent — there is nothing to match on', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);
    const publish = () =>
      designEvidenceService.recordFromPathnames(
        {
          workItemId: card.id,
          assets: [
            seedAsset(fx, card.id, { kind: 'mock', name: 'q.mock.html', contentType: 'text/html' }),
          ],
        },
        fx.ctx,
      );

    const first = await publish();
    const second = await publish();

    expect(second.id).not.toBe(first.id);
    const designEvidenceCount = await adminDb.designEvidence.count({
      where: { workItemId: card.id },
    });
    expect(designEvidenceCount).toBe(2);
  });

  it('a second publish SUPERSEDES the prior — one current, old assets unlinked (GC-eligible), history kept', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);

    const first = await designEvidenceService.recordFromPathnames(
      {
        workItemId: card.id,
        assets: [
          seedAsset(fx, card.id, { kind: 'mock', name: 'v1.mock.html', contentType: 'text/html' }),
        ],
        commitSha: 'sha-1',
      },
      fx.ctx,
    );
    const second = await designEvidenceService.recordFromPathnames(
      {
        workItemId: card.id,
        assets: [
          seedAsset(fx, card.id, { kind: 'mock', name: 'v2.mock.html', contentType: 'text/html' }),
        ],
        commitSha: 'sha-2',
      },
      fx.ctx,
    );

    expect(second.id).not.toBe(first.id);

    const currents = await adminDb.designEvidence.findMany({
      where: { workItemId: card.id, isCurrent: true },
    });
    expect(currents).toHaveLength(1);
    expect(currents[0]!.id).toBe(second.id);

    // History retained.
    const designEvidenceCount = await adminDb.designEvidence.count({
      where: { workItemId: card.id },
    });
    expect(designEvidenceCount).toBe(2);

    // The superseded asset's attachment is unlinked → GC-eligible; the current
    // one is still linked.
    const linked = await adminDb.attachment.findMany({ where: { workItemId: card.id } });
    expect(linked).toHaveLength(1);
    expect(linked[0]!.blobPathname).toContain('v2.mock.html');
  });

  it('is IDEMPOTENT for the same commit + producer — a CI redelivery records nothing new', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);
    const input = {
      workItemId: card.id,
      assets: [
        seedAsset(fx, card.id, { kind: 'mock', name: 'one.mock.html', contentType: 'text/html' }),
      ],
      commitSha: 'same-sha',
      producedByKey: 'MOTIR-2669',
    };

    const first = await designEvidenceService.recordFromPathnames(input, fx.ctx);
    const again = await designEvidenceService.recordFromPathnames(input, fx.ctx);

    expect(again.id).toBe(first.id);
    const designEvidenceCount = await adminDb.designEvidence.count({
      where: { workItemId: card.id },
    });
    expect(designEvidenceCount).toBe(1);
    const designAssetCount = await adminDb.designAsset.count({
      where: { designEvidenceId: first.id },
    });
    expect(designAssetCount).toBe(1);
  });

  it('never advances the item status — publishing is evidence, not a workflow decision', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);
    const before = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });

    await designEvidenceService.recordFromPathnames(
      {
        workItemId: card.id,
        assets: [
          seedAsset(fx, card.id, { kind: 'mock', name: 'x.mock.html', contentType: 'text/html' }),
        ],
      },
      fx.ctx,
    );

    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.status).toBe(before.status);
    expect(after.status).toBeTruthy();
  });
});

describe('designEvidenceService — the gates', () => {
  it('REFUSES a container target — a story has many designs, one per design subtask', async () => {
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'A story' });

    await expect(
      designEvidenceService.recordFromPathnames(
        {
          workItemId: story.id,
          assets: [
            seedAsset(fx, story.id, {
              kind: 'mock',
              name: 's.mock.html',
              contentType: 'text/html',
            }),
          ],
        },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(DesignEvidenceNotALeafError);
  });

  it('REFUSES a `bug` that HAS CHILDREN — leaf is a POSITION, not a kind (MOTIR-3146)', async () => {
    // The parent-run form the runbook endorses: `motir run <bug>` on a bug whose
    // children are leaves, whose branch carries the CONTAINER's key by design.
    // Reading `kind` alone let it through and the publish 500'd instead of
    // no-opping, which is the outcome MOTIR-3124 exists to prevent.
    const fx = await makeWorkItemFixture();
    const container = await createTestWorkItem(fx, { kind: 'bug', title: 'A bug with children' });
    await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'Its child',
      parentId: container.id,
    });

    await expect(
      designEvidenceService.recordFromPathnames(
        {
          workItemId: container.id,
          assets: [
            seedAsset(fx, container.id, {
              kind: 'mock',
              name: 'b.mock.html',
              contentType: 'text/html',
            }),
          ],
        },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(DesignEvidenceNotALeafError);
  });

  it('PUBLISHES to a CHILDLESS `bug` — the ordinary case must not regress (MOTIR-3146)', async () => {
    // The other half, and the one a children-based check could plausibly break:
    // a logged bug that produced a design asset is a perfectly good target.
    const fx = await makeWorkItemFixture();
    const leafBug = await createTestWorkItem(fx, { kind: 'bug', title: 'A childless bug' });

    const evidence = await designEvidenceService.recordFromPathnames(
      {
        workItemId: leafBug.id,
        assets: [
          seedAsset(fx, leafBug.id, {
            kind: 'mock',
            name: 'ok.mock.html',
            contentType: 'text/html',
          }),
        ],
      },
      fx.ctx,
    );
    expect(evidence.id).toBeTruthy();
  });

  it('rejects a pathname OUTSIDE this item’s design prefix before any DB write', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);
    const foreign = `design/${fx.ctx.workspaceId}/some-other-item/evil.mock.html`;
    store.set(foreign, { contentType: 'text/html', size: 10 });

    await expect(
      designEvidenceService.recordFromPathnames(
        {
          workItemId: card.id,
          assets: [{ kind: 'mock', sourcePath: 'design/x/evil.mock.html', pathname: foreign }],
        },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(DesignEvidencePathnameError);

    const designEvidenceCount = await adminDb.designEvidence.count();
    expect(designEvidenceCount).toBe(0);
    const attachmentCount = await adminDb.attachment.count();
    expect(attachmentCount).toBe(0);
  });

  it('rejects a pathname whose blob does not exist — the client upload never completed', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);
    const pathname = `${designPrefix(fx.ctx.workspaceId, card.id)}ghost.mock.html`;

    await expect(
      designEvidenceService.recordFromPathnames(
        {
          workItemId: card.id,
          assets: [{ kind: 'mock', sourcePath: 'design/x/ghost.mock.html', pathname }],
        },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(DesignEvidenceBlobMissingError);
  });

  it('rejects on the ACTUAL content type, not the declared one — a mock that uploaded a script', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);
    // Declared as an image; the store holds something else entirely.
    const asset = seedAsset(fx, card.id, {
      kind: 'image',
      name: 'lie.png',
      contentType: 'application/javascript',
    });

    await expect(
      designEvidenceService.recordFromPathnames({ workItemId: card.id, assets: [asset] }, fx.ctx),
    ).rejects.toBeInstanceOf(UnsupportedFileTypeError);

    const designEvidenceCount = await adminDb.designEvidence.count();
    expect(designEvidenceCount).toBe(0);
  });

  it('reads a missing target as NOT FOUND, never as forbidden', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      designEvidenceService.recordFromPathnames(
        {
          workItemId: 'does-not-exist',
          assets: [
            { kind: 'mock', sourcePath: 'design/x/a.mock.html', pathname: 'design/x/a.mock.html' },
          ],
        },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(DesignEvidenceNotFoundError);
  });

  it('rejects an artifact whose ACTUAL size exceeds the per-file cap', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);
    // A presigned PUT can carry no size ceiling, so the cap is enforced HERE,
    // after the write, on what the store actually holds.
    const asset = seedAsset(fx, card.id, {
      kind: 'mock',
      name: 'huge.mock.html',
      contentType: 'text/html',
      size: 64 * 1024 * 1024,
    });

    await expect(
      designEvidenceService.recordFromPathnames({ workItemId: card.id, assets: [asset] }, fx.ctx),
    ).rejects.toBeInstanceOf(FileTooLargeError);

    const designEvidenceCount = await adminDb.designEvidence.count();
    expect(designEvidenceCount).toBe(0);
  });

  it('rejects an unknown asset KIND before touching the store', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);
    const asset = seedAsset(fx, card.id, {
      kind: 'mock',
      name: 'k.mock.html',
      contentType: 'text/html',
    });

    await expect(
      designEvidenceService.recordFromPathnames(
        {
          workItemId: card.id,
          // A kind outside the enum — a caller (or a drifted publisher) sending
          // something the schema cannot store.
          assets: [{ ...asset, kind: 'screenshot' as unknown as 'mock' }],
        },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(UnsupportedFileTypeError);

    const designEvidenceCount = await adminDb.designEvidence.count();
    expect(designEvidenceCount).toBe(0);
  });

  it('rejects an EMPTY publish — it would supersede a real result with nothing', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);

    await expect(
      designEvidenceService.recordFromPathnames({ workItemId: card.id, assets: [] }, fx.ctx),
    ).rejects.toBeInstanceOf(DesignEvidenceEmptyError);
  });
});

describe('translateSupersedeConflict', () => {
  it('turns a lost partial-unique race into a typed conflict, and passes anything else through', async () => {
    const { Prisma } = await import('@/generated/prisma/client');

    const p2002 = new Prisma.PrismaClientKnownRequestError('unique violation', {
      code: 'P2002',
      clientVersion: 'test',
    });
    expect(translateSupersedeConflict(p2002, 'wi-1')).toBeInstanceOf(
      DesignEvidenceSupersedeConflictError,
    );

    // A different Prisma error is NOT a lost race — re-thrown untouched, so a
    // real fault never gets reported to CI as "retry, someone beat you".
    const p2003 = new Prisma.PrismaClientKnownRequestError('fk violation', {
      code: 'P2003',
      clientVersion: 'test',
    });
    expect(translateSupersedeConflict(p2003, 'wi-1')).toBe(p2003);

    const boom = new Error('boom');
    expect(translateSupersedeConflict(boom, 'wi-1')).toBe(boom);
  });
});

describe('designEvidenceService.createUploadTokens', () => {
  it('binds each grant to one exact key and one exact content type', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);

    const { targets } = await designEvidenceService.createUploadTokens(
      {
        workItemId: card.id,
        files: [
          { kind: 'mock', sourcePath: 'design/work-items/t.mock.html', contentType: 'text/html' },
          {
            kind: 'note_file',
            sourcePath: 'design/work-items/design-notes.md',
            contentType: 'text/markdown',
          },
        ],
      },
      fx.ctx,
    );

    expect(targets).toHaveLength(2);
    for (const t of targets) {
      expect(t.pathname.startsWith(designPrefix(fx.ctx.workspaceId, card.id))).toBe(true);
      expect(t.maxBytes).toBeGreaterThan(0);
    }
    expect(targets[0]!.contentType).toBe('text/html');
    expect(targets[1]!.contentType).toBe('text/markdown');
  });

  it('refuses an unknown KIND and a disallowed content type before minting anything', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);

    await expect(
      designEvidenceService.createUploadTokens(
        {
          workItemId: card.id,
          files: [
            {
              kind: 'screenshot' as unknown as 'mock',
              sourcePath: 'design/x/a.png',
              contentType: 'image/png',
            },
          ],
        },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(UnsupportedFileTypeError);

    await expect(
      designEvidenceService.createUploadTokens(
        {
          workItemId: card.id,
          files: [{ kind: 'image', sourcePath: 'design/x/a.svg', contentType: 'image/svg+xml' }],
        },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(UnsupportedFileTypeError);
  });

  it('refuses to mint for an empty file list, or for a container target', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Container' });

    await expect(
      designEvidenceService.createUploadTokens({ workItemId: card.id, files: [] }, fx.ctx),
    ).rejects.toBeInstanceOf(DesignEvidenceEmptyError);

    await expect(
      designEvidenceService.createUploadTokens(
        {
          workItemId: story.id,
          files: [{ kind: 'mock', sourcePath: 'design/x/s.mock.html', contentType: 'text/html' }],
        },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(DesignEvidenceNotALeafError);
  });
});

describe('the design allowlist is ONE-DIRECTIONAL', () => {
  it('accepts text/html on the design path and REFUSES it on the generic upload path', () => {
    // The whole safety of publishing a mock rests on `text/html` being reachable
    // through exactly one path. Asserted in both directions, in one place, so
    // the asymmetry reads as a rule rather than two unrelated facts.
    expect(isAllowedDesignAssetType('text/html')).toBe(true);
    expect(isAllowedUploadType('text/html')).toBe(false);

    // The shared types stay allowed on both.
    expect(isAllowedDesignAssetType('image/png')).toBe(true);
    expect(isAllowedUploadType('image/png')).toBe(true);

    // And nothing else sneaks in on the design path.
    expect(isAllowedDesignAssetType('application/javascript')).toBe(false);
    expect(isAllowedDesignAssetType('image/svg+xml')).toBe(false);
    expect(isAllowedDesignAssetType('video/webm')).toBe(false);
  });
});

describe('the attachments panel excludes design assets', () => {
  it('a published design result contributes NO row to the panel list or count', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);

    await designEvidenceService.recordFromPathnames(
      {
        workItemId: card.id,
        assets: [
          seedAsset(fx, card.id, { kind: 'mock', name: 'p.mock.html', contentType: 'text/html' }),
          seedAsset(fx, card.id, { kind: 'image', name: 'p.png', contentType: 'image/png' }),
        ],
      },
      fx.ctx,
    );

    // The rows exist and are linked...
    const attachmentCount = await adminDb.attachment.count({ where: { workItemId: card.id } });
    expect(attachmentCount).toBe(2);

    // ...but the panel does not show them: they are owned by the DesignEvidence
    // lifecycle and rendered in the Design result panel.
    const page = await attachmentsService.listForWorkItem(card.id, {}, fx.ctx);
    expect(page.attachments).toHaveLength(0);
    expect(page.totalCount).toBe(0);
  });
});

describe('capNoteMd', () => {
  it('leaves a note under the cap untouched', () => {
    const note = '## A surface\n\nSome prose.';
    expect(capNoteMd(note)).toEqual({ noteMd: note, noteTruncated: false });
  });

  it('treats an absent note as absent, not as empty text', () => {
    expect(capNoteMd(null)).toEqual({ noteMd: null, noteTruncated: false });
    expect(capNoteMd(undefined)).toEqual({ noteMd: null, noteTruncated: false });
    expect(capNoteMd('')).toEqual({ noteMd: null, noteTruncated: false });
  });

  it('truncates at a ## BOUNDARY and names how many sections were dropped', () => {
    // Three sections, each ~30 KB: two fit under 64 KiB, the third does not.
    const body = 'x'.repeat(30 * 1024);
    const note = ['## One', body, '## Two', body, '## Three', body].join('\n');
    expect(Buffer.byteLength(note, 'utf8')).toBeGreaterThan(NOTE_MD_CAP_BYTES);

    const { noteMd, noteTruncated } = capNoteMd(note);

    expect(noteTruncated).toBe(true);
    expect(noteMd).toContain('## One');
    expect(noteMd).toContain('## Two');
    // The dropped section is gone WHOLE — never half a section.
    expect(noteMd).not.toContain('## Three');
    expect(noteMd).toContain('1 of 3 section(s) omitted');
    expect(noteMd).toContain('note_file');
    expect(Buffer.byteLength(noteMd!, 'utf8')).toBeLessThan(NOTE_MD_CAP_BYTES + 512);
  });

  it('keeps a prefix when a SINGLE section is larger than the whole cap', () => {
    const note = `## Huge\n${'y'.repeat(80 * 1024)}`;
    const { noteMd, noteTruncated } = capNoteMd(note);

    expect(noteTruncated).toBe(true);
    expect(noteMd).toContain('## Huge');
    expect(noteMd).toContain('note_file');
  });
});

describe('the one-current invariant is enforced by the DATABASE', () => {
  it('a second is_current row for the same item violates the partial unique index', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);

    await designEvidenceService.recordFromPathnames(
      {
        workItemId: card.id,
        assets: [
          seedAsset(fx, card.id, { kind: 'mock', name: 'i.mock.html', contentType: 'text/html' }),
        ],
      },
      fx.ctx,
    );

    // Bypass the service entirely: the constraint, not the code, is what makes
    // two current rows unrepresentable.
    await expect(
      adminDb.designEvidence.create({
        data: {
          workspaceId: fx.ctx.workspaceId,
          workItemId: card.id,
          isCurrent: true,
        },
      }),
    ).rejects.toThrow();

    expect(
      await adminDb.designEvidence.count({ where: { workItemId: card.id, isCurrent: true } }),
    ).toBe(1);
  });

  it('survives GENUINE concurrency — two publishes race, exactly one current row survives', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);

    const publish = (sha: string) =>
      designEvidenceService.recordFromPathnames(
        {
          workItemId: card.id,
          assets: [
            seedAsset(fx, card.id, {
              kind: 'mock',
              name: `${sha}.mock.html`,
              contentType: 'text/html',
            }),
          ],
          commitSha: sha,
        },
        fx.ctx,
      );

    // Both outcomes are legal: the loser either waits on the row lock and
    // supersedes cleanly, or loses the partial-unique slot and surfaces the
    // typed conflict. What is NOT legal is two current rows.
    const results = await Promise.allSettled([publish('race-a'), publish('race-b')]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(DesignEvidenceSupersedeConflictError);
      }
    }

    expect(
      await adminDb.designEvidence.count({ where: { workItemId: card.id, isCurrent: true } }),
    ).toBe(1);
  });

  it('a superseded row is unconstrained — many history rows coexist', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);

    for (const sha of ['s1', 's2', 's3']) {
      await designEvidenceService.recordFromPathnames(
        {
          workItemId: card.id,
          assets: [
            seedAsset(fx, card.id, {
              kind: 'mock',
              name: `${sha}.mock.html`,
              contentType: 'text/html',
            }),
          ],
          commitSha: sha,
        },
        fx.ctx,
      );
    }

    const designEvidenceCount = await adminDb.designEvidence.count({
      where: { workItemId: card.id },
    });
    expect(designEvidenceCount).toBe(3);
    expect(
      await adminDb.designEvidence.count({ where: { workItemId: card.id, isCurrent: true } }),
    ).toBe(1);
  });
});

describe('designEvidenceService.getCurrentForWorkItem', () => {
  it('returns null when nothing is published — the panel’s empty state', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);
    expect(await designEvidenceService.getCurrentForWorkItem(card.id, fx.ctx)).toBeNull();
  });

  it('reports a GC-reclaimed artifact as having no content — the row survives, the bytes do not', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);
    await designEvidenceService.recordFromPathnames(
      {
        workItemId: card.id,
        assets: [
          seedAsset(fx, card.id, { kind: 'mock', name: 'g.mock.html', contentType: 'text/html' }),
        ],
      },
      fx.ctx,
    );

    // The orphan-GC removes the Attachment; the SetNull FK leaves the asset row
    // standing, so the record of WHAT was published outlives its bytes.
    await adminDb.attachment.deleteMany({ where: { workItemId: card.id } });

    const dto = await designEvidenceService.getCurrentForWorkItem(card.id, fx.ctx);
    expect(dto!.assets).toHaveLength(1);
    expect(dto!.assets[0]!.url).toBeNull();
    expect(dto!.assets[0]!.mimeType).toBeNull();
    expect(dto!.assets[0]!.sizeBytes).toBeNull();
    // …and the provenance of the artifact is still readable.
    expect(dto!.assets[0]!.sourcePath).toBe('design/work-items/g.mock.html');
  });

  it('reads through the repository WITHOUT a transaction (the pure-read panel path)', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);
    const created = await designEvidenceService.recordFromPathnames(
      {
        workItemId: card.id,
        assets: [
          seedAsset(fx, card.id, { kind: 'mock', name: 'n.mock.html', contentType: 'text/html' }),
        ],
      },
      fx.ctx,
    );

    // The repository's `tx ?? db` fallback: the panel read runs under an
    // already-bound workspace context, not inside the supersede transaction.
    const current = await withWorkspaceServiceContext(fx.ctx.workspaceId, (tx) =>
      designEvidenceRepository.findCurrentByWorkItem(card.id, tx),
    );
    expect(current!.id).toBe(created.id);
    expect(current!.assets).toHaveLength(1);

    const byId = await withWorkspaceServiceContext(fx.ctx.workspaceId, (tx) =>
      designEvidenceRepository.findById(created.id, tx),
    );
    expect(byId!.workItemId).toBe(card.id);
  });

  it('returns the current result with its assets in render order', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);
    await designEvidenceService.recordFromPathnames(
      {
        workItemId: card.id,
        assets: [
          seedAsset(fx, card.id, { kind: 'mock', name: 'r.mock.html', contentType: 'text/html' }),
          seedAsset(fx, card.id, { kind: 'image', name: 'r.png', contentType: 'image/png' }),
        ],
        noteMd: '## R\n\nprose',
      },
      fx.ctx,
    );

    const dto = await designEvidenceService.getCurrentForWorkItem(card.id, fx.ctx);
    expect(dto).not.toBeNull();
    expect(dto!.assets.map((a) => a.kind)).toEqual(['mock', 'image']);
    expect(dto!.noteMd).toContain('## R');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WITHDRAW (MOTIR-3215)
// ─────────────────────────────────────────────────────────────────────────────
// The table shipped with two mutations — create, and supersede-by-publish — and
// both need a REPLACEMENT. A result published onto a card that will never have a
// design of its own was therefore permanent, which is why MOTIR-3213's stray
// rows were still standing in production after the publisher was fixed. These
// pin the third mutation and, just as much, what it deliberately does NOT do.

describe('designEvidenceService.withdrawCurrentForWorkItem', () => {
  /**
   * Publish a one-asset result and return its DTO. The commit sha is derived
   * from the asset name so two publishes are two publishes: an identical
   * `commitSha` + `producedByKey` pair is a CI redelivery, which
   * `findIdempotentExisting` correctly answers with the existing row rather
   * than superseding it.
   */
  async function publish(fx: WorkItemFixture, workItemId: string, name = 'a.mock.html') {
    return designEvidenceService.recordFromPathnames(
      {
        workItemId,
        assets: [seedAsset(fx, workItemId, { kind: 'mock', name, contentType: 'text/html' })],
        commitSha: `sha-${name}`,
        producedByKey: 'MOTIR-2669',
      },
      fx.ctx,
    );
  }

  it('clears the current result with no replacement — the panel read then returns null', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);
    const published = await publish(fx, card.id);

    const withdrawn = await designEvidenceService.withdrawCurrentForWorkItem(
      { workItemId: card.id, reason: 'Published by a PR that changed no design file.' },
      fx.ctx,
    );

    expect(withdrawn.id).toBe(published.id);
    expect(withdrawn.withdrawnAt).not.toBeNull();
    expect(withdrawn.withdrawnById).toBe(fx.ctx.userId);
    expect(withdrawn.withdrawnReason).toBe('Published by a PR that changed no design file.');

    // The panel's own read — AC 1's "reads as having none". Nothing is current,
    // so `DesignResultPanel` takes its existing empty branch; no new UI state.
    expect(await designEvidenceService.getCurrentForWorkItem(card.id, fx.ctx)).toBeNull();
    expect(
      await adminDb.designEvidence.count({ where: { workItemId: card.id, isCurrent: true } }),
    ).toBe(0);
  });

  it('is AUDITABLE, not destructive — the row, its assets and their attachments all survive', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);
    const published = await publish(fx, card.id);

    await designEvidenceService.withdrawCurrentForWorkItem({ workItemId: card.id }, fx.ctx);

    const row = await adminDb.designEvidence.findUnique({ where: { id: published.id } });
    expect(row).not.toBeNull();
    expect(row!.isCurrent).toBe(false);
    expect(row!.withdrawnAt).toBeInstanceOf(Date);
    expect(await adminDb.designAsset.count({ where: { designEvidenceId: published.id } })).toBe(1);

    // ⚠️ The attachments stay LINKED, unlike a supersede — which unlinks them so
    // the orphan-GC reclaims the blobs, because a correct replacement has taken
    // over the record. Here the record IS the point: unlinking would destroy the
    // only evidence of what was wrongly published.
    const atts = await adminDb.attachment.findMany({ where: { workItemId: card.id } });
    expect(atts).toHaveLength(1);
    expect(atts[0]!.workItemId).toBe(card.id);
  });

  it('distinguishes the three histories — never designed vs superseded vs withdrawn', async () => {
    const fx = await makeWorkItemFixture();

    // (a) never designed — no row at all.
    const untouched = await makeSubtask(fx);
    expect(await adminDb.designEvidence.count({ where: { workItemId: untouched.id } })).toBe(0);

    // (b) superseded by a later publish — is_current false, withdrawnAt NULL.
    const republished = await makeSubtask(fx);
    const first = await publish(fx, republished.id, 'one.mock.html');
    await publish(fx, republished.id, 'two.mock.html');
    const superseded = await adminDb.designEvidence.findUnique({ where: { id: first.id } });
    expect(superseded!.isCurrent).toBe(false);
    expect(superseded!.withdrawnAt).toBeNull();

    // (c) withdrawn — is_current false AND withdrawnAt set.
    const takenBack = await makeSubtask(fx);
    const only = await publish(fx, takenBack.id);
    await designEvidenceService.withdrawCurrentForWorkItem({ workItemId: takenBack.id }, fx.ctx);
    const row = await adminDb.designEvidence.findUnique({ where: { id: only.id } });
    expect(row!.isCurrent).toBe(false);
    expect(row!.withdrawnAt).not.toBeNull();

    // Which is the whole point: `is_current = false` alone cannot tell (b) from
    // (c), and the design gate reads the same absence for both.
    expect(superseded!.isCurrent).toBe(row!.isCurrent);
    expect(superseded!.withdrawnAt).not.toEqual(row!.withdrawnAt);
  });

  it('refuses a work item with no current result — and refuses a SECOND withdrawal the same way', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);

    await expect(
      designEvidenceService.withdrawCurrentForWorkItem({ workItemId: card.id }, fx.ctx),
    ).rejects.toBeInstanceOf(DesignEvidenceNoCurrentResultError);

    await publish(fx, card.id);
    await designEvidenceService.withdrawCurrentForWorkItem({ workItemId: card.id }, fx.ctx);
    await expect(
      designEvidenceService.withdrawCurrentForWorkItem({ workItemId: card.id }, fx.ctx),
    ).rejects.toBeInstanceOf(DesignEvidenceNoCurrentResultError);
  });

  it('refuses an unknown / cross-workspace work item as NOT FOUND', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      designEvidenceService.withdrawCurrentForWorkItem({ workItemId: 'nope' }, fx.ctx),
    ).rejects.toBeInstanceOf(DesignEvidenceNotFoundError);
  });

  it('⚠️ withdraws from a card that has since GAINED a child — the leaf gate is PUBLISH-only', async () => {
    // The trap this test exists for: `resolveTarget` refuses a non-leaf, and a
    // `task` / `bug` is leaf-CAPABLE, not leaf-BY-KIND (MOTIR-3146). If the
    // withdraw path reused that gate, an ordinary re-plan that parents a subtask
    // under the card would strand its wrong result forever — re-creating the
    // exact permanence this whole path removes. MOTIR-2902, one of the four
    // production victims, is a `task`.
    const fx = await makeWorkItemFixture();
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Parent story' });
    const task = await createTestWorkItem(fx, {
      kind: 'task',
      title: 'A leaf, for now',
      parentId: story.id,
    });
    await publish(fx, task.id);

    await createTestWorkItem(fx, { kind: 'subtask', title: 'A child arrives', parentId: task.id });

    // Publishing to it is now refused — the container rule, working correctly.
    await expect(publish(fx, task.id, 'later.mock.html')).rejects.toBeInstanceOf(
      DesignEvidenceNotALeafError,
    );

    // Withdrawing is not.
    const withdrawn = await designEvidenceService.withdrawCurrentForWorkItem(
      { workItemId: task.id },
      fx.ctx,
    );
    expect(withdrawn.withdrawnAt).not.toBeNull();
    expect(await designEvidenceService.getCurrentForWorkItem(task.id, fx.ctx)).toBeNull();
  });

  it('a blank reason is stored as NULL, not as an empty string', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);
    await publish(fx, card.id);

    const withdrawn = await designEvidenceService.withdrawCurrentForWorkItem(
      { workItemId: card.id, reason: '   ' },
      fx.ctx,
    );
    expect(withdrawn.withdrawnReason).toBeNull();
  });

  it('a later publish can still take the current slot after a withdrawal', async () => {
    // Withdrawal must CLEAR the partial-unique slot, not occupy it: a card whose
    // stray result was taken back may later produce a real design.
    const fx = await makeWorkItemFixture();
    const card = await makeSubtask(fx);
    await publish(fx, card.id, 'stray.mock.html');
    await designEvidenceService.withdrawCurrentForWorkItem({ workItemId: card.id }, fx.ctx);

    const real = await publish(fx, card.id, 'real.mock.html');
    expect(real.withdrawnAt).toBeNull();
    const current = await designEvidenceService.getCurrentForWorkItem(card.id, fx.ctx);
    expect(current!.id).toBe(real.id);
    expect(await adminDb.designEvidence.count({ where: { workItemId: card.id } })).toBe(2);
  });
});
