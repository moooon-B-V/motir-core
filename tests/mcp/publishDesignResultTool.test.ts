import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

// The blob STORE is the only thing faked, and it is faked as a STORE rather than
// as two independent stubs: `recordFromPathnames` HEADs every object it is asked
// to register, precisely so a lying, absent or cross-tenant pathname cannot be
// recorded. A `headPrivateBlob` that answered a fixed shape would make that
// check vacuous and quietly un-test the one guarantee the register half exists
// for. So `put` writes into a map and `head` reads out of it, and the size and
// media type the service acts on are the ones the bytes actually had.
const store = new Map<string, { size: number; contentType: string }>();

// ⚠️ AND THE MINT IS FAKED AS A GRANT, NOT AS A STRING (bug MOTIR-4750). The
// real `mintPrivateUploadToken` returns a presigned PUT bound to one exact key
// and one content type, and the new door's whole contract is that the agent
// uploads to the URL it was handed and publishes the pathname it was handed. So
// the fake derives the URL FROM the pathname, and `putUploaded` below refuses a
// pathname nobody granted — otherwise a test that publishes an ungranted
// pathname would pass here while the real service refused it.
const minted = new Map<string, { contentType: string; maxBytes: number }>();

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
  mintPrivateUploadToken: vi.fn(
    async (pathname: string, opts: { contentType: string; maxBytes: number }) => {
      minted.set(pathname, { contentType: opts.contentType, maxBytes: opts.maxBytes });
      return `https://store.example/signed/${encodeURIComponent(pathname)}`;
    },
  ),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  deleteAttachmentBlob: vi.fn(async () => {}),
}));

const {
  runPublishDesignResult,
  runCreateDesignUpload,
  PUBLISH_DESIGN_RESULT_TOOL_NAME,
  CREATE_DESIGN_UPLOAD_TOOL_NAME,
} = await import('@/lib/mcp/tools/publishDesignResult');
const { runAttachFile } = await import('@/lib/mcp/tools/attachFile');
const { CLI_TOKEN_GRANT, TOOL_PERMISSIONS } = await import('@/lib/mcp/toolPermissions');
const { TOOL_SCOPES } = await import('@/lib/mcp/scopes');
const { MCP_TOOL_NAMES } = await import('@/lib/mcp/registry');
const { NOTE_MD_CAP_BYTES } = await import('@/lib/services/designEvidenceService');
const { MAX_UPLOAD_BYTES } = await import('@/lib/blob/allowlist');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { makeWorkItemFixture } = await import('../fixtures');
const { truncateAuthTables } = await import('../helpers/db');
const { adminDb } = await import('../helpers/adminDb');

// `publish_design_result` (Story MOTIR-3780 · Subtask MOTIR-3782) against real
// Postgres, with only the blob store faked.
//
// ⚠️ THE PERMISSION ASSERTION IS THE POINT OF THIS FILE, exactly as it is in
// `attachFileTool.test.ts`. A tool that publishes perfectly for an interactive
// operator and refuses the dispatched agent it was built for is an outage that
// ships green — MOTIR-3051's shape — and this whole story exists because the
// previous publisher failed in that same silent direction.

let fx: Awaited<ReturnType<typeof makeWorkItemFixture>>;

beforeEach(async () => {
  store.clear();
  minted.clear();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "design_asset", "design_evidence", "attachment", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

async function makeItem(
  title: string,
  kind: 'task' | 'story' = 'task',
): Promise<{ key: string; id: string }> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title },
    fx.ctx,
  );
  return { key: item.identifier, id: item.id };
}

/** A container with one real child — the shape both container gates need. */
async function makeContainerWithChild(title: string): Promise<{ key: string; id: string }> {
  const container = await makeItem(title, 'story');
  await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', title: 'a child', parentId: container.id },
    fx.ctx,
  );
  return container;
}

const b64 = (s: string) => Buffer.from(s).toString('base64');

/** Simulate the agent's own PUT: it may only write to a pathname that was
 *  actually granted, and the object it leaves is what `head` will report. */
function putUploaded(pathname: string, size: number): void {
  const grant = minted.get(pathname);
  if (!grant) throw new Error(`no grant was minted for ${pathname}`);
  store.set(pathname, { contentType: grant.contentType, size });
}

/** The structured payload of a successful tool result. */
function payload(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

/** The grants a `create_design_upload` result carries, in the order asked for. */
function targets(result: { structuredContent?: unknown }): Array<Record<string, unknown>> {
  return payload(result).targets as Array<Record<string, unknown>>;
}

/** What the STORE actually holds for an asset, reached the way the panel is —
 *  through the asset's `Attachment` row, which is where the pathname lives. */
async function storedSizeOf(attachmentId: string | null): Promise<number | undefined> {
  if (attachmentId === null) return undefined;
  const attachment = await adminDb.attachment.findFirstOrThrow({ where: { id: attachmentId } });
  return store.get(attachment.blobPathname)?.size;
}

const MOCK = {
  kind: 'mock' as const,
  sourcePath: 'design/work-items/detail.mock.html',
  contentType: 'text/html',
  contentBase64: b64('<p>detail</p>'),
};
const IMAGE = {
  kind: 'image' as const,
  sourcePath: 'design/work-items/detail.png',
  contentType: 'image/png',
  contentBase64: b64('PNG\r\n'),
};
const NOTE = {
  kind: 'note_file' as const,
  sourcePath: 'design/work-items/design-notes.md',
  contentType: 'text/markdown',
  contentBase64: b64('## Detail\n\nThe whole note.\n'),
};

describe('the tool is reachable by the caller it was built for', () => {
  it('asserts its permission is one CLI_TOKEN_GRANT actually carries', () => {
    const permission = TOOL_PERMISSIONS[PUBLISH_DESIGN_RESULT_TOOL_NAME];
    expect(permission).toBe('work_item:edit');
    expect(
      CLI_TOKEN_GRANT,
      `publish_design_result requires "${permission}", which a dispatched run's token does not ` +
        'hold — the MOTIR-3051 shape, and the one this story cannot afford: the agent that just ' +
        'drew the asset is the only actor standing where the publish is possible.',
    ).toContain(permission);
  });

  it('needs NO widening of the grant — the key was already there', () => {
    // The whole argument for moving the publish out of CI rests on this: the
    // design-publish route has asserted `work_item:edit` since MOTIR-2667 and
    // the grant has carried it the whole time, so this tool adds no credential
    // and no trust. If a later diff has to widen `CLI_TOKEN_GRANT` to make this
    // tool reachable, that argument was wrong and the change deserves its own
    // justification rather than arriving inside an unrelated edit.
    expect([...CLI_TOKEN_GRANT]).toEqual([
      'project:browse',
      'lesson:view',
      'lesson:reinforce',
      'work_item:edit',
      'comment:add',
      'ai:plan',
    ]);
  });

  it('is registered, and carries a WRITE scope', () => {
    expect(MCP_TOOL_NAMES).toContain(PUBLISH_DESIGN_RESULT_TOOL_NAME);
    expect(TOOL_SCOPES[PUBLISH_DESIGN_RESULT_TOOL_NAME]).toBe('work_items:write');
  });

  it('the MINT half asks for the same key and is registered too', () => {
    // ⚠️ The mint is a WRITE even though it persists no row: it hands back a
    // presigned PUT into the workspace's own object store, under this item's
    // design prefix. Declaring it a read would give out store grants on a
    // browse permission.
    expect(MCP_TOOL_NAMES).toContain(CREATE_DESIGN_UPLOAD_TOOL_NAME);
    expect(TOOL_SCOPES[CREATE_DESIGN_UPLOAD_TOOL_NAME]).toBe('work_items:write');
    expect(TOOL_PERMISSIONS[CREATE_DESIGN_UPLOAD_TOOL_NAME]).toBe(
      TOOL_PERMISSIONS[PUBLISH_DESIGN_RESULT_TOOL_NAME],
    );
    expect(
      CLI_TOKEN_GRANT,
      'the door added for the assets an agent cannot emit must be reachable by that agent',
    ).toContain(TOOL_PERMISSIONS[CREATE_DESIGN_UPLOAD_TOOL_NAME]);
  });
});

describe('one call publishes a complete result', () => {
  it('note, mock and .png land as the item’s current design result', async () => {
    const { key } = await makeItem('Design the detail page');

    const result = await runPublishDesignResult(
      {
        key,
        assets: [MOCK, IMAGE, NOTE],
        noteMd: '## Detail\n\nWhat changed.\n',
        commitSha: 'abc123',
        producedByKey: key,
      },
      fx.ctx,
    );

    expect(result.isError, JSON.stringify(result)).toBeFalsy();

    const evidence = await adminDb.designEvidence.findFirstOrThrow({
      include: { assets: true },
    });
    expect(evidence.noteMd).toBe('## Detail\n\nWhat changed.\n');
    expect(evidence.noteTruncated).toBe(false);
    expect(evidence.commitSha).toBe('abc123');
    expect(evidence.assets.map((a) => a.kind).sort()).toEqual(['image', 'mock', 'note_file']);

    // The bytes reached the store under THIS item's design prefix — the
    // property `recordFromPathnames` refuses a publish without.
    expect(store.size).toBe(3);
    for (const pathname of store.keys()) {
      expect(pathname).toContain(`/${evidence.workItemId}/`);
      expect(pathname.startsWith('design/')).toBe(true);
    }
  });

  it('accepts a lower-cased key, like every other work-item tool', async () => {
    const { key } = await makeItem('Design');
    const result = await runPublishDesignResult(
      { key: key.toLowerCase(), assets: [IMAGE] },
      fx.ctx,
    );
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    expect(await adminDb.designEvidence.count()).toBe(1);
  });

  it('a second publish SUPERSEDES rather than accumulating a second current row', async () => {
    const { key } = await makeItem('Design');
    await runPublishDesignResult({ key, assets: [IMAGE], commitSha: 'one' }, fx.ctx);
    await runPublishDesignResult({ key, assets: [IMAGE], commitSha: 'two' }, fx.ctx);

    const rows = await adminDb.designEvidence.findMany();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.isCurrent)).toHaveLength(1);
    expect(rows.find((r) => r.isCurrent)!.commitSha).toBe('two');
  });

  it('is idempotent on the commit — a retry returns the existing result', async () => {
    const { key } = await makeItem('Design');
    await runPublishDesignResult(
      { key, assets: [IMAGE], commitSha: 'same', producedByKey: key },
      fx.ctx,
    );
    await runPublishDesignResult(
      { key, assets: [IMAGE], commitSha: 'same', producedByKey: key },
      fx.ctx,
    );
    expect(await adminDb.designEvidence.count()).toBe(1);
  });
});

// ── bug MOTIR-4750: the door for an asset an agent cannot emit ──────────────
//
// The inline form is fine for a note section and a small mock and stays the
// default. It is not reachable at all for a real design board: the MCP route is
// a serverless function capped around 4.5 MB, base64 is 1.37x the file, and —
// the limit no cap change can lift — the bytes have to be EMITTED by a model as
// a tool argument, at ~0.4 base64 characters per token. So this pair is the
// difference between a design result and an empty panel, for a whole population
// of assets.
describe('mint → upload → publish carries an asset the inline form cannot', () => {
  it('the two forms reach the SAME panel — one uploaded, one inline', async () => {
    const uploaded = await makeItem('Design, published from grants');
    const inline = await makeItem('Design, published inline');

    const grant = await runCreateDesignUpload(
      {
        key: uploaded.key,
        files: [
          {
            kind: 'mock',
            sourcePath: 'design/ai-chat/planning-workspace.mock.html',
            contentType: 'text/html',
          },
          {
            kind: 'image',
            sourcePath: 'design/ai-chat/planning-workspace.png',
            contentType: 'image/png',
          },
        ],
      },
      fx.ctx,
    );
    expect(grant.isError, JSON.stringify(grant)).toBeFalsy();
    const [mockTarget, imageTarget] = targets(grant);

    // One grant per file, in the order asked for, each bound to its own media
    // type and carrying the cap up front — the thing MOTIR-1911's lesson says
    // the caller should not have to discover by exceeding it.
    expect(targets(grant)).toHaveLength(2);
    expect(mockTarget!.contentType).toBe('text/html');
    expect(imageTarget!.contentType).toBe('image/png');
    expect(mockTarget!.uploadUrl).toContain('https://store.example/signed/');
    expect(mockTarget!.maxBytes).toBe(MAX_UPLOAD_BYTES);
    // Under THIS item's design prefix, which is what makes the register half's
    // prefix check meaningful rather than decorative.
    expect(mockTarget!.pathname as string).toContain(`/${uploaded.id}/`);

    // The agent's own PUT. Nothing about this step goes through Motir.
    putUploaded(mockTarget!.pathname as string, 48_120);
    putUploaded(imageTarget!.pathname as string, 3_929_899);

    const published = await runPublishDesignResult(
      {
        key: uploaded.key,
        assets: [
          {
            kind: 'mock',
            sourcePath: 'design/ai-chat/planning-workspace.mock.html',
            pathname: mockTarget!.pathname as string,
          },
          {
            kind: 'image',
            sourcePath: 'design/ai-chat/planning-workspace.png',
            pathname: imageTarget!.pathname as string,
          },
        ],
        noteMd: '## The planning workspace\n\nWhat changed.\n',
        commitSha: 'ba5eba11',
      },
      fx.ctx,
    );
    expect(published.isError, JSON.stringify(published)).toBeFalsy();

    // …and the inline form still publishes, unchanged. This card ADDS a door.
    const inlineResult = await runPublishDesignResult(
      { key: inline.key, assets: [MOCK, IMAGE, NOTE], noteMd: '## Detail\n\nWhat changed.\n' },
      fx.ctx,
    );
    expect(inlineResult.isError, JSON.stringify(inlineResult)).toBeFalsy();

    // BOTH reached the panel's read — the same current row, the same asset
    // kinds, the same note. A door that published somewhere else would satisfy
    // every assertion above and none of these.
    for (const item of [uploaded, inline]) {
      const evidence = await adminDb.designEvidence.findFirstOrThrow({
        where: { workItemId: item.id, isCurrent: true },
        include: { assets: true },
      });
      expect(evidence.noteMd).toContain('What changed.');
      expect(evidence.assets.map((a) => a.kind)).toContain('mock');
      expect(evidence.assets.map((a) => a.kind)).toContain('image');
    }

    // The store holds the mock as `text/html` on the UPLOADED path too — §5's
    // one-entrance guarantee is a property of the design path, not of the
    // inline form that happened to be the only way in.
    expect(store.get(mockTarget!.pathname as string)!.contentType).toBe('text/html');
  });

  it('publishes an asset whose INLINE argument would be larger than the per-file cap ITSELF', async () => {
    // ⚠️ ASSERTED BY SIZE, against the repository's own constant rather than a
    // number typed into this test. `MAX_UPLOAD_BYTES` is the only shipped size
    // policy there is, and base64 inflates by 4/3 — so an asset whose ENCODED
    // form exceeds that cap could not be sent as a tool argument under any
    // reading of the limits, before the agent's own output budget is even
    // considered. That is the case MOTIR-4750 was filed for, and it is the case
    // this test covers.
    const item = await makeItem('Design a multi-sheet board');
    const sizeBytes = Math.ceil((MAX_UPLOAD_BYTES * 3) / 4) + 1_024;
    expect(
      Math.ceil(sizeBytes / 3) * 4,
      'the fixture must be one the inline form genuinely cannot carry',
    ).toBeGreaterThan(MAX_UPLOAD_BYTES);

    const grant = await runCreateDesignUpload(
      {
        key: item.key,
        files: [
          { kind: 'image', sourcePath: 'design/ai-chat/board.png', contentType: 'image/png' },
        ],
      },
      fx.ctx,
    );
    const [target] = targets(grant);
    putUploaded(target!.pathname as string, sizeBytes);

    const published = await runPublishDesignResult(
      {
        key: item.key,
        assets: [
          {
            kind: 'image',
            sourcePath: 'design/ai-chat/board.png',
            pathname: target!.pathname as string,
          },
        ],
      },
      fx.ctx,
    );
    expect(published.isError, JSON.stringify(published)).toBeFalsy();

    // The size recorded is the STORE's, and nothing in either call reported it —
    // which is also what makes the per-file cap enforceable on this path.
    const asset = await adminDb.designAsset.findFirstOrThrow();
    const attachment = await adminDb.attachment.findFirstOrThrow({
      where: { id: asset.attachmentId! },
    });
    expect(attachment.sizeBytes).toBe(sizeBytes);
    expect(attachment.sizeBytes).toBeLessThanOrEqual(MAX_UPLOAD_BYTES);
  });

  it('refuses a pathname NOBODY granted — a lying key cannot be published', async () => {
    // The register half HEADs every object, so a pathname outside this item's
    // prefix (or naming nothing at all) is refused before any row is written.
    const item = await makeItem('Design');
    const result = await runPublishDesignResult(
      {
        key: item.key,
        assets: [
          {
            kind: 'image',
            sourcePath: 'design/x/x.png',
            pathname: 'design/some-other-workspace/some-other-item/stolen.png',
          },
        ],
      },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('DESIGN_EVIDENCE');
    expect(await adminDb.designEvidence.count()).toBe(0);
  });

  it('the mint re-uses the publish’s own gates — a CONTAINER target is refused', async () => {
    // It adds no policy: the same `resolveTarget` the publish runs, so a design
    // result cannot be minted onto a container any more than it can be
    // published onto one.
    const container = await makeContainerWithChild('A story');
    const result = await runCreateDesignUpload(
      {
        key: container.key,
        files: [{ kind: 'image', sourcePath: 'design/x/x.png', contentType: 'image/png' }],
      },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('DESIGN_EVIDENCE_NOT_A_LEAF');
    expect(minted.size, 'no grant may be minted for a target that cannot own a result').toBe(0);
  });

  it('the mint refuses a media type outside the design allowlist, granting nothing', async () => {
    const item = await makeItem('Design');
    const result = await runCreateDesignUpload(
      {
        key: item.key,
        files: [
          { kind: 'image', sourcePath: 'design/x/x.exe', contentType: 'application/x-msdownload' },
        ],
      },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('UNSUPPORTED_FILE_TYPE');
    expect(minted.size).toBe(0);
  });
});

describe('one publish uses ONE form for all of its assets', () => {
  // The two forms reach two different service methods, so reconciling them here
  // would make this adapter the one place that decides how a design result is
  // assembled — which is exactly what it is written not to own. Each refusal
  // names the asset and the fix, because an agent mid-run gets one hop.
  it('refuses a MIX of inline and uploaded assets, naming the counts', async () => {
    const item = await makeItem('Design');
    const grant = await runCreateDesignUpload(
      {
        key: item.key,
        files: [{ kind: 'image', sourcePath: 'design/x/x.png', contentType: 'image/png' }],
      },
      fx.ctx,
    );
    const [target] = targets(grant);
    putUploaded(target!.pathname as string, 2_000_000);

    const result = await runPublishDesignResult(
      {
        key: item.key,
        assets: [
          MOCK,
          { kind: 'image', sourcePath: 'design/x/x.png', pathname: target!.pathname as string },
        ],
      },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('MIXED_ASSET_SOURCES');
    expect(JSON.stringify(result), 'the refusal must name the fix').toContain(
      CREATE_DESIGN_UPLOAD_TOOL_NAME,
    );
    expect(await adminDb.designEvidence.count()).toBe(0);
  });

  it('refuses an asset carrying BOTH forms, naming which one', async () => {
    const item = await makeItem('Design');
    const result = await runPublishDesignResult(
      { key: item.key, assets: [{ ...IMAGE, pathname: 'design/a/b/c.png' }] },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result);
    expect(text).toContain('AMBIGUOUS_ASSET_SOURCE');
    expect(text).toContain('design/work-items/detail.png');
  });

  it('refuses an asset carrying NEITHER form, and points at the mint', async () => {
    const item = await makeItem('Design');
    const result = await runPublishDesignResult(
      {
        key: item.key,
        assets: [{ kind: 'image', sourcePath: 'design/x/x.png', contentType: 'image/png' }],
      },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result);
    expect(text).toContain('MISSING_ASSET_SOURCE');
    expect(text).toContain(CREATE_DESIGN_UPLOAD_TOOL_NAME);
  });

  it('refuses inline bytes with no declared media type — the store cannot be asked', async () => {
    const item = await makeItem('Design');
    const result = await runPublishDesignResult(
      {
        key: item.key,
        assets: [{ kind: 'image', sourcePath: 'design/x/x.png', contentBase64: b64('PNG\r\n') }],
      },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('MISSING_CONTENT_TYPE');
    expect(store.size).toBe(0);
  });
});

describe('`text/html` reaches the design path and ONLY the design path', () => {
  // §5 of `design-result.md`: a mock is HTML rendered to a signed-in user, so
  // the whole posture rests on that media type being reachable through exactly
  // one path. Both halves are asserted together, in one file, because the risk
  // is not that either changes — it is that they drift APART.
  it('the design publisher ACCEPTS it', async () => {
    const { key } = await makeItem('Design');
    const result = await runPublishDesignResult({ key, assets: [MOCK] }, fx.ctx);
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    expect(await adminDb.designAsset.count()).toBe(1);
  });

  it('`attach_file` STILL refuses it — this card did not widen the generic allowlist', async () => {
    const { key } = await makeItem('Research');
    const result = await runAttachFile(
      {
        key,
        filename: 'sneaky.mock.html',
        contentType: 'text/html',
        contentBase64: b64('<p>x</p>'),
      },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    expect(await adminDb.attachment.count()).toBe(0);
  });
});

describe('it re-implements no gate — the service refuses and the tool REPORTS', () => {
  it('a CONTAINER target is a typed refusal, not a 500', async () => {
    const parent = await makeContainerWithChild('A story');

    const result = await runPublishDesignResult({ key: parent.key, assets: [IMAGE] }, fx.ctx);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('DESIGN_EVIDENCE_NOT_A_LEAF');
    expect(await adminDb.designEvidence.count()).toBe(0);
  });

  it('a key that is not a CHILD of the declared container is refused', async () => {
    const container = await makeContainerWithChild('The parent run’s story');
    const stranger = await makeItem('Somebody else’s card');

    const result = await runPublishDesignResult(
      { key: stranger.key, assets: [IMAGE], withinParentKey: container.key },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('DESIGN_EVIDENCE_NOT_A_CHILD');
    expect(await adminDb.designEvidence.count()).toBe(0);
  });

  it('a media type outside the DESIGN allowlist is refused, having written nothing', async () => {
    const { key } = await makeItem('Design');
    const result = await runPublishDesignResult(
      {
        key,
        assets: [
          {
            kind: 'image',
            sourcePath: 'design/x/x.exe',
            contentType: 'application/x-msdownload',
            contentBase64: b64('MZ'),
          },
        ],
      },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('UNSUPPORTED_FILE_TYPE');
    // The refusal came BEFORE the upload — the property the minted path cannot
    // have, because a presigned PUT is bounded only after the object lands.
    expect(store.size).toBe(0);
  });

  it('an EMPTY asset list is a typed refusal', async () => {
    const { key } = await makeItem('Design');
    const result = await runPublishDesignResult({ key, assets: [] }, fx.ctx);
    expect(result.isError).toBe(true);
    expect(await adminDb.designEvidence.count()).toBe(0);
  });

  it('an unknown key reads not-found, and writes nothing anywhere', async () => {
    const result = await runPublishDesignResult({ key: 'PROD-99999', assets: [IMAGE] }, fx.ctx);
    expect(result.isError).toBe(true);
    expect(store.size).toBe(0);
    expect(await adminDb.designEvidence.count()).toBe(0);
  });
});

describe('the note cap is a RENDERING bound, never a data-loss bound', () => {
  it('truncates the inline note at a `##` boundary while the full text ships as note_file', async () => {
    const { key } = await makeItem('Design');
    // TWO sections, each comfortably under the cap and together over it, so the
    // cut lands on a `##` BOUNDARY — which is the behaviour the criterion names.
    // A single over-cap section takes `capNoteMd`'s other branch (a character
    // cut), and asserting that one instead would leave the boundary path
    // untested while looking identical from the outside.
    const filler = 'a'.repeat(Math.floor(NOTE_MD_CAP_BYTES * 0.6));
    const full = `## One\n\n${filler}\n\n## Two\n\n${filler}\n\nthe tail that must survive\n`;

    const result = await runPublishDesignResult(
      {
        key,
        assets: [
          {
            kind: 'note_file',
            sourcePath: 'design/work-items/design-notes.md',
            contentType: 'text/markdown',
            contentBase64: b64(full),
          },
        ],
        noteMd: full,
      },
      fx.ctx,
    );
    expect(result.isError, JSON.stringify(result)).toBeFalsy();

    const evidence = await adminDb.designEvidence.findFirstOrThrow({ include: { assets: true } });
    expect(evidence.noteTruncated).toBe(true);

    // The KEPT content is bounded by the cap; the marker is added on top of it,
    // deliberately, so the reader is told rather than left to notice. Asserting
    // the whole string against the cap would be asserting the marker away.
    const [keptText] = (evidence.noteMd ?? '').split('\n\n---\n\n');
    expect(Buffer.byteLength(keptText ?? '')).toBeLessThanOrEqual(NOTE_MD_CAP_BYTES);
    expect(evidence.noteMd).toContain('## One');
    expect(evidence.noteMd, 'the cut must land on a `##` boundary').not.toContain('## Two');
    expect(evidence.noteMd).not.toContain('the tail that must survive');
    expect(evidence.noteMd, 'the marker names where the complete text went').toContain('note_file');

    // …and the COMPLETE text is still on the card, as the companion asset. This
    // is the assertion that makes the cap a rendering bound: without it the
    // truncation is data loss with a flag on it.
    const noteAsset = evidence.assets.find((a) => a.kind === 'note_file');
    expect(noteAsset).toBeDefined();
    expect(await storedSizeOf(noteAsset!.attachmentId)).toBe(Buffer.byteLength(full));

    // And the TOOL tells the caller too, so an agent does not have to infer it
    // from a field it did not ask for.
    expect(JSON.stringify(result)).toContain('note_file');
  });
});

describe('the base64 argument is validated, not salvaged', () => {
  // ⚠️ `Buffer.from(s, 'base64')` never throws — it DISCARDS characters outside
  // the alphabet. Salvaging here is worse than on an attachment: the garbage
  // would publish as a real design result, with a real evidence id, under a
  // green check, and fail only when a reviewer opens the panel — which is the
  // exact failure shape this whole story exists to remove.
  it('refuses a payload that is not base64, naming WHICH asset', async () => {
    const { key } = await makeItem('Design');
    const result = await runPublishDesignResult(
      { key, assets: [IMAGE, { ...MOCK, contentBase64: '<p>not base64 !!' }] },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result);
    expect(text).toContain('INVALID_BASE64');
    expect(text, 'a three-asset publish should not have to be bisected').toContain(
      'design/work-items/detail.mock.html',
    );
    // Refused before ANY asset was written, including the valid one ahead of it.
    expect(store.size).toBe(0);
    expect(await adminDb.designEvidence.count()).toBe(0);
  });

  it('round-trips bytes EXACTLY — the stored size is the sent size', async () => {
    const { key } = await makeItem('Design');
    const payload = 'binary bytesÿ';
    await runPublishDesignResult(
      {
        key,
        assets: [
          {
            kind: 'image',
            sourcePath: 'design/x/x.png',
            contentType: 'image/png',
            contentBase64: Buffer.from(payload, 'binary').toString('base64'),
          },
        ],
      },
      fx.ctx,
    );
    const asset = await adminDb.designAsset.findFirstOrThrow();
    expect(await storedSizeOf(asset.attachmentId)).toBe(Buffer.from(payload, 'binary').length);
  });
});
