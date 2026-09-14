import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The story's INTEGRATION gate for the AGENT publish path
// (Story MOTIR-3780 · Subtask MOTIR-3790).
//
// ⚠️ WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY LEAVES TO ITS SIBLINGS.
// `design-evidence-integration.test.ts` (MOTIR-2671) already drives the
// allowlist asymmetry at the shipped generic-upload ROUTE, tenant isolation
// under the NOBYPASSRLS `motir_app` role, and the publish→read seam — all
// through `recordFromPathnames`, the door CI came in by. Re-deriving any of it
// here would be the exact failure mode a story-level test card has: a second
// suite over the same machine.
//
// What NO existing suite can reach is the seam this story ADDED — bytes in a
// tool call, through `recordFromBytes`, out through the DTO the panel consumes.
// The unit suite (`tests/mcp/publishDesignResultTool.test.ts`) mocks the store
// and asserts the tool's own behaviour; the integration suite above never sees
// the tool at all. The middle is where key drift lives, and it is what this file
// is for.
//
// Real Postgres throughout. The object store is the ONE mocked external, and it
// is mocked as a STORE — `put` writes into a map, `head` reads out of it — so
// the authoritative size and content type the service acts on are the ones the
// bytes actually had. A `head` answering a fixed shape would make the register
// half's whole guarantee vacuous.

const store = new Map<string, { contentType: string; size: number }>();

// ⚠️ THE FAKE APPLIES THE SAME RANDOM SUFFIX THE REAL HELPER DOES, and that is
// not a detail. `putObject` calls `withRandomSuffix(pathname)` and
// `putPrivateAttachment` RETURNS the key it actually wrote, so a caller that
// registers the pathname it ASKED for names an object that does not exist. A
// fake returning `{ pathname }` unchanged reproduces the helper's contract
// WRONGLY and therefore agrees with that bug — which is exactly what happened
// here: these suites were green while the E2E failed on
// `DESIGN_EVIDENCE_BLOB_MISSING`. A fake that lies about a contract is worse
// than no fake.
vi.mock('@/lib/blob/uploader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/blob/uploader')>()),
  putPrivateAttachment: vi.fn(async (pathname: string, body: Buffer, contentType: string) => {
    const dot = pathname.lastIndexOf('.');
    const suffix = randomBytes(5).toString('hex');
    const written =
      dot <= pathname.lastIndexOf('/')
        ? `${pathname}-${suffix}`
        : `${pathname.slice(0, dot)}-${suffix}${pathname.slice(dot)}`;
    store.set(written, { contentType, size: body.byteLength });
    return { pathname: written };
  }),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  signedDownloadUrl: vi.fn(async (pathname: string) => `https://blob.example/signed/${pathname}`),
  deleteAttachmentBlob: vi.fn(async () => {}),
}));

const { runPublishDesignResult } = await import('@/lib/mcp/tools/publishDesignResult');
const { designEvidenceService } = await import('@/lib/services/designEvidenceService');
const { makeWorkWaitOn } = await import('../helpers/designWaits');
const {
  ALLOWED_DESIGN_ASSET_TYPES,
  ALLOWED_UPLOAD_TYPES,
  isAllowedDesignAssetType,
  isAllowedUploadType,
} = await import('@/lib/blob/allowlist');

let fx: WorkItemFixture;

beforeEach(async () => {
  store.clear();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "design_asset", "design_evidence", "attachment", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

/** A design subtask under a story — the kind-parent matrix is a DB trigger. */
async function makeSubtask(f: WorkItemFixture) {
  const story = await createTestWorkItem(f, { kind: 'story', title: 'Parent story' });
  const card = await createTestWorkItem(f, {
    kind: 'subtask',
    title: 'Design — the readiness rail',
    parentId: story.id,
  });
  // AMENDMENT 4 Q2: a result is published only while open work waits on it.
  await makeWorkWaitOn(card.id, f);
  return card;
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

const ASSETS = [
  {
    kind: 'mock' as const,
    sourcePath: 'design/work-items/rail.mock.html',
    contentType: 'text/html',
    contentBase64: b64('<!doctype html><title>rail</title><p>rail</p>'),
  },
  {
    kind: 'note_file' as const,
    sourcePath: 'design/work-items/design-notes.md',
    contentType: 'text/markdown',
    contentBase64: b64('## The rail\n\nThe note, published as a file.\n'),
  },
];

describe('the tool → service → row → panel seam', () => {
  it('drives real TOOL output through the real DTO the panel consumes', async () => {
    const item = await makeSubtask(fx);

    const result = await runPublishDesignResult(
      {
        key: item.identifier,
        assets: ASSETS,
        commitSha: 'c0389f2',
        producedByKey: item.identifier,
      },
      fx.ctx,
    );
    expect(result.isError, JSON.stringify(result)).toBeFalsy();

    // Read back through the SAME call the item page makes, and assert the exact
    // keys the panel destructures. Both sides pass their own suites while a name
    // drifts between them; this is the only place that shows.
    const dto = await designEvidenceService.getCurrentForWorkItem(item.id, fx.ctx);
    expect(dto, 'the panel reads nothing back from a tool publish').not.toBeNull();
    expect(dto!.workItemId).toBe(item.id);
    expect(dto!.noteMd, 'AMENDMENT 4: the note is a link, not inline').toBeNull();
    expect(dto!.noteTruncated).toBe(false);
    expect(dto!.commitSha).toBe('c0389f2');
    expect(dto!.withdrawnAt).toBeNull();

    // Render ORDER is the panel's contract, not the caller's argument order.
    expect(dto!.assets.map((a) => a.kind)).toEqual(['mock', 'note_file']);
    for (const asset of dto!.assets) {
      expect(asset.sourcePath).toMatch(/^design\/work-items\//);
      // ⚠️ Every url is the AUTHENTICATED content route, never a store URL — the
      // private posture, asserted on the shape a tool publish produces. The DTO
      // exposes no attachment id, deliberately, so the assertion is on the SHAPE
      // of the path rather than on a join the panel cannot make either.
      expect(asset.url).toMatch(/^\/api\/attachments\/[^/]+\/content$/);
      expect(asset.url).not.toContain('blob.example');
      expect(asset.url).not.toContain('e2e.s3');
    }
  });

  it('the size and type on the DTO are the STORE’s, not the caller’s claim', async () => {
    const item = await makeSubtask(fx);
    await runPublishDesignResult({ key: item.identifier, assets: ASSETS }, fx.ctx);

    const dto = await designEvidenceService.getCurrentForWorkItem(item.id, fx.ctx);
    const noteFile = dto!.assets.find((a) => a.kind === 'note_file')!;
    // The bytes the tool decoded, measured by the store's HEAD — the register
    // half never trusts what the caller reported.
    expect(noteFile.sizeBytes).toBe(Buffer.from(ASSETS[1]!.contentBase64, 'base64').byteLength);
    expect(noteFile.mimeType).toBe('text/markdown');
  });
});

describe('the note travels as ONE form — the file — and every byte of it is kept', () => {
  // AMENDMENT 4 retired the inline `noteMd`, so there is no longer a capped copy
  // to reconcile with the file: the `note_file` asset IS the note, and the panel
  // links to it. What a seam test still owes is that the file a reviewer follows
  // the link to is the whole document, as the store holds it.
  it('a large note publishes whole as the `note_file`, with nothing stored inline', async () => {
    const item = await makeSubtask(fx);

    const filler = 'a'.repeat(48 * 1024);
    const full = `## One\n\n${filler}\n\n## Two\n\n${filler}\n\nthe tail\n`;

    const result = await runPublishDesignResult(
      {
        key: item.identifier,
        assets: [
          ASSETS[0]!,
          {
            kind: 'note_file',
            sourcePath: 'design/work-items/design-notes.md',
            contentType: 'text/markdown',
            contentBase64: b64(full),
          },
        ],
      },
      fx.ctx,
    );
    expect(result.isError, JSON.stringify(result)).toBeFalsy();

    const dto = await designEvidenceService.getCurrentForWorkItem(item.id, fx.ctx);
    expect(dto!.noteMd).toBeNull();
    expect(dto!.noteTruncated).toBe(false);

    const companion = dto!.assets.find((a) => a.kind === 'note_file');
    expect(companion).toBeDefined();
    expect(companion!.sizeBytes).toBe(Buffer.byteLength(full));

    // …and the bytes really are in the store at the key the row points at —
    // reached through `design_asset` → `attachment`, because the DTO
    // deliberately exposes no pathname to anyone.
    const row = await adminDb.designAsset.findFirstOrThrow({ where: { kind: 'note_file' } });
    const attachment = await adminDb.attachment.findFirstOrThrow({
      where: { id: row.attachmentId! },
    });
    expect(store.get(attachment.blobPathname)!.size).toBe(Buffer.byteLength(full));
  });
});

describe('tenant isolation, through the TOOL’s own door', () => {
  it('a publish addressed at another workspace’s item reads NOT FOUND, never forbidden', async () => {
    // ⚠️ The rival gets a DIFFERENT project key on purpose: a work-item key
    // names its project by prefix, so two workspaces both keyed `ACME` each own
    // a real `ACME-1` and the probe would quietly resolve the CALLER's own item
    // and succeed. That is the key namespace working, and it makes the refusal
    // untestable.
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'ZZZ' });
    const rivalItem = await makeSubtask(rival);

    const result = await runPublishDesignResult(
      { key: rivalItem.identifier, assets: ASSETS },
      fx.ctx,
    );

    expect(result.isError).toBe(true);
    const text = JSON.stringify(result);
    // 404-not-403: the message must not distinguish "absent" from "someone
    // else's", or a cross-tenant probe learns the item exists.
    expect(text).toMatch(/NOT_FOUND/);
    expect(text).not.toMatch(/FORBIDDEN|PERMISSION_DENIED/);

    // …and nothing was written on either side, including the store: the target
    // is resolved before a byte is uploaded.
    expect(store.size).toBe(0);
    expect(await adminDb.designEvidence.count()).toBe(0);
  });
});

describe('architecture guards — what a coverage percentage cannot see', () => {
  // ⚠️ ASSERTED ON THE FACTS, NOT ON PROSE ABOUT THEM. The first draft of this
  // block grepped both source files for the strings `attachmentsService` and
  // `text/html` — and failed, correctly, on its own subject matter: the tool's
  // header says "routes to `designEvidenceService`, NEVER `attachmentsService`"
  // and the allowlist's doc comment explains why `text/html` is excluded from
  // the generic list. Both sentences are TRUE and both matched. A guard that
  // cannot tell a rule from a comment restating the rule punishes the file for
  // documenting itself, so these read the import STATEMENTS and the exported
  // CONSTANTS instead.
  it('the design-publish path imports NO attachmentsService', () => {
    // The two artifact CLASSES must not converge by accident. `attach_file`
    // routes to `attachmentsService` and refuses `text/html`; this path routes
    // to `designEvidenceService`, the only place that type is admitted. An
    // import here would be the first step toward one door.
    const importsOf = (file: string) =>
      [...readFileSync(file, 'utf8').matchAll(/^import[\s\S]*?from\s+'([^']+)';$/gm)].map(
        (m) => m[1]!,
      );

    const toolImports = importsOf('lib/mcp/tools/publishDesignResult.ts');
    expect(toolImports).not.toContain('@/lib/services/attachmentsService');
    expect(toolImports).toContain('@/lib/services/designEvidenceService');

    expect(importsOf('lib/services/designEvidenceService.ts')).not.toContain(
      '@/lib/services/attachmentsService',
    );
  });

  it('`text/html` is in the DESIGN allowlist and NOT in the generic one', () => {
    // The one-entrance guarantee, read off the shipped CONSTANTS — the level a
    // percentage can never express, and the level at which the two lists either
    // do or do not overlap. The shipped-ROUTE half (a real 415) is
    // `design-evidence-integration.test.ts`; the TOOL half is
    // `publishDesignResultTool.test.ts`. Three altitudes, no duplication.
    expect(ALLOWED_DESIGN_ASSET_TYPES).toContain('text/html');
    expect(ALLOWED_UPLOAD_TYPES).not.toContain('text/html');
    expect(isAllowedDesignAssetType('text/html')).toBe(true);
    expect(isAllowedUploadType('text/html')).toBe(false);

    // …and the design list is not simply a superset that happens to include it:
    // the two are separate lists with a deliberate asymmetry, so a future edit
    // that spreads one into the other fails here.
    expect(ALLOWED_UPLOAD_TYPES).not.toEqual(
      expect.arrayContaining([...ALLOWED_DESIGN_ASSET_TYPES]),
    );
  });
});
