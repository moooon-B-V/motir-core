import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// The design-result INTEGRATION gate (Story MOTIR-2664 · Subtask MOTIR-2671).
//
// ⚠️ WHAT THIS FILE IS FOR, AND WHY IT IS NOT `design-evidence-service.test.ts`.
// That file is MOTIR-2666's unit suite and already proves the service's own
// behaviour — supersede, idempotency, every gate, the concurrency race. Three
// things it CANNOT prove are the reason this file exists, and each is a property
// of two components rather than of one:
//
//   1. **The allowlist asymmetry, at the shipped ROUTE.** The unit suite asserts
//      it at the CONSTANT (`isAllowedUploadType` vs `isAllowedDesignAssetType`).
//      A constant agreeing with itself is not the guarantee — the guarantee is
//      that the deployed generic-upload endpoint answers 415 for `text/html`.
//      Between the constant and that answer sit the service, the error class and
//      the route's own catch, none of which the constant test exercises.
//
//   2. **Tenant isolation, under a role that CANNOT bypass RLS.** Every other
//      test in this area runs as the migration-owner role, which is BYPASSRLS —
//      so a passing cross-workspace assertion there proves the service filtered,
//      and says nothing about the policy. Only `SET LOCAL ROLE motir_app`
//      (NOSUPERUSER, NOBYPASSRLS) puts the actual policy on trial.
//
//   3. **The publish→read seam.** Register through the real service, read back
//      through the real DTO, and assert the exact keys the panel consumes. This
//      is where names drift while both sides keep passing their own tests.
//
// Real Postgres throughout. The object store is the ONE mocked external.

const store = new Map<string, { contentType: string; size: number }>();

vi.mock('@/lib/blob/uploader', () => ({
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  putAttachment: vi.fn(async (pathname: string) => ({ pathname, url: `https://blob/${pathname}` })),
  putPrivateAttachment: vi.fn(async (pathname: string) => ({ pathname })),
  signedDownloadUrl: vi.fn(async (pathname: string) => `https://blob.example/signed/${pathname}`),
  deleteAttachmentBlob: vi.fn(async () => {}),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

// The generic-upload route's two ambient reads. Both are request-scoped in
// production; under test they are the only things standing between the test and
// the real service, so they are the only things faked.
const activeCtx = vi.hoisted(() => ({
  current: null as null | { userId: string; workspaceId: string; projectId: string },
}));
const session = vi.hoisted(() => ({ current: null as null | { user: { id: string } } }));
vi.mock('@/lib/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/projects')>();
  return { ...actual, getActiveProject: async () => activeCtx.current };
});
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getSession: async () => session.current };
});

const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { designAssetContentPath } = await import('@/lib/mappers/designEvidenceMappers');
const { headPrivateBlob } = await import('@/lib/blob/uploader');
const { POST: uploadIssueAttachment } = await import('@/app/api/upload/issue-attachment/route');

/** A design subtask under a story — the kind-parent matrix is a DB trigger. */
async function makeSubtask(fx: WorkItemFixture) {
  const story = await createTestWorkItem(fx, { kind: 'story', title: 'Parent story' });
  return createTestWorkItem(fx, {
    kind: 'subtask',
    title: 'Design — the result panel',
    parentId: story.id,
  });
}

function seedAsset(
  fx: WorkItemFixture,
  workItemId: string,
  opts: { kind: 'mock' | 'image' | 'note_file'; name: string; contentType: string; size?: number },
) {
  const pathname = `${designPrefix(fx.ctx.workspaceId, workItemId)}${opts.name}`;
  store.set(pathname, { contentType: opts.contentType, size: opts.size ?? 2048 });
  return { kind: opts.kind, sourcePath: `design/work-items/${opts.name}`, pathname };
}

function fileOf(name: string, type: string, body = 'x'): File {
  return new File([body], name, { type });
}

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  store.clear();
  vi.mocked(headPrivateBlob).mockClear();
  fx = await makeWorkItemFixture();
  activeCtx.current = {
    userId: fx.ctx.userId,
    workspaceId: fx.ctx.workspaceId,
    // `projectId` sits on the fixture ROOT, not on its `ctx` — `ServiceContext`
    // is (userId, workspaceId) only, because the project is resolved per call.
    projectId: fx.projectId,
  };
  session.current = { user: { id: fx.ctx.userId } };
});

afterAll(async () => {
  await db.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the design allowlist is one-directional — proven at the SHIPPED ROUTE', () => {
  it('the generic upload endpoint answers 415 for text/html', async () => {
    const req = new Request('http://localhost/api/upload/issue-attachment', {
      method: 'POST',
      body: (() => {
        const form = new FormData();
        form.set('file', fileOf('design-result.mock.html', 'text/html', '<h1>mock</h1>'));
        return form;
      })(),
    });

    const res = await uploadIssueAttachment(req);

    expect(res.status).toBe(415);
    // The code travels with it — a bare 415 would leave the editor unable to
    // say WHY, which is the difference between a message and a shrug.
    await expect(res.json()).resolves.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' });
  });

  it('the same endpoint accepts an ordinary image, so 415 is about the TYPE and not the route', async () => {
    const form = new FormData();
    form.set('file', fileOf('screenshot.png', 'image/png'));
    const res = await uploadIssueAttachment(
      new Request('http://localhost/api/upload/issue-attachment', { method: 'POST', body: form }),
    );

    expect(res.status).toBe(200);
  });

  it('the DESIGN path mints for text/html — the same byte stream, the other door', async () => {
    const item = await makeSubtask(fx);

    const { targets } = await designEvidenceService.createUploadTokens(
      {
        workItemId: item.id,
        files: [
          { kind: 'mock', sourcePath: 'design/work-items/x.mock.html', contentType: 'text/html' },
        ],
      },
      fx.ctx,
    );

    expect(targets).toHaveLength(1);
    expect(targets[0]!.contentType).toBe('text/html');
    // Read the two assertions above together: `text/html` is refused by the
    // endpoint any authenticated user can reach, and minted by the one that
    // requires a CI identity. That asymmetry IS the safety of serving a mock.
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('tenant isolation is enforced by the RLS POLICY, not by the service', () => {
  /**
   * Run `fn` as `motir_app` (NOSUPERUSER, NOBYPASSRLS) with `app.workspace_id`
   * bound to `workspaceId` — i.e. exactly what a request connection looks like.
   * The role switch is LAST: once it is in effect the session cannot set the GUC
   * on some configurations, and the ordering is what the shipped RLS suites use.
   */
  async function asWorkspace<T>(
    workspaceId: string,
    fn: (tx: typeof db) => Promise<T>,
  ): Promise<T> {
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return fn(tx as unknown as typeof db);
    });
  }

  async function publishInto(fixture: WorkItemFixture) {
    const item = await makeSubtask(fixture);
    await designEvidenceService.recordFromPathnames(
      {
        workItemId: item.id,
        assets: [
          seedAsset(fixture, item.id, {
            kind: 'mock',
            name: 'panel.mock.html',
            contentType: 'text/html',
          }),
        ],
        noteMd: '## Panel\n\nThe note.',
        commitSha: 'abc1234',
      },
      fixture.ctx,
    );
    return item;
  }

  it('a design result in workspace A is invisible to a connection bound to workspace B', async () => {
    const item = await publishInto(fx);
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });

    const ownView = await asWorkspace(fx.ctx.workspaceId, (tx) =>
      tx.designEvidence.findMany({ where: { workItemId: item.id } }),
    );
    const foreignView = await asWorkspace(other.ctx.workspaceId, (tx) =>
      tx.designEvidence.findMany({ where: { workItemId: item.id } }),
    );

    expect(ownView).toHaveLength(1);
    // Not "filtered to nothing by a service" — the row is unreachable to the
    // query itself. Same statement, same id, different workspace GUC.
    expect(foreignView).toHaveLength(0);
  });

  it('the asset rows are policed independently — design_asset carries its OWN workspace_id', async () => {
    await publishInto(fx);
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });

    const own = await asWorkspace(fx.ctx.workspaceId, (tx) => tx.designAsset.findMany());
    const foreign = await asWorkspace(other.ctx.workspaceId, (tx) => tx.designAsset.findMany());

    expect(own.length).toBeGreaterThan(0);
    // The asset table denormalises `workspace_id` rather than reaching through
    // its evidence row precisely so this holds without a join — a policy that
    // has to traverse a FK is a policy that can be defeated by deleting one.
    expect(foreign).toHaveLength(0);
  });

  it('a WRITE naming a foreign workspace is refused by WITH CHECK, not silently rewritten', async () => {
    const item = await publishInto(fx);
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });

    await expect(
      asWorkspace(other.ctx.workspaceId, (tx) =>
        tx.designEvidence.create({
          data: {
            workspaceId: fx.ctx.workspaceId, // ← someone else's tenant
            workItemId: item.id,
            isCurrent: false,
            noteTruncated: false,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('an UNSET workspace GUC sees nothing at all — a connection that forgot context is not a superuser', async () => {
    await publishInto(fx);

    const rows = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return tx.designEvidence.findMany();
    });

    expect(rows).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the publish → read seam', () => {
  it('drives real service output through the real DTO the panel consumes', async () => {
    const item = await makeSubtask(fx);

    await designEvidenceService.recordFromPathnames(
      {
        workItemId: item.id,
        // Deliberately NOT in render order: the note file is published last by
        // the uploader, and the panel must still show mock → image → note.
        assets: [
          seedAsset(fx, item.id, {
            kind: 'mock',
            name: 'result.mock.html',
            contentType: 'text/html',
            size: 4096,
          }),
          seedAsset(fx, item.id, {
            kind: 'image',
            name: 'result.png',
            contentType: 'image/png',
            size: 8192,
          }),
          seedAsset(fx, item.id, {
            kind: 'note_file',
            name: 'design-notes.md',
            contentType: 'text/markdown',
            size: 512,
          }),
        ],
        noteMd: '## The panel\n\nRendered note.',
        commitSha: 'c0389f2',
        ciRunUrl: 'https://github.com/x/y/actions/runs/1',
        producedByKey: 'MOTIR-2669',
      },
      fx.ctx,
    );

    const read = await designEvidenceService.getCurrentForWorkItem(item.id, fx.ctx);

    expect(read).not.toBeNull();
    // Every key below is one the panel reads. Listed exhaustively and by name:
    // a renamed or dropped field must fail HERE, in a test that says what the
    // consumer wanted, rather than as an empty region of a rendered page.
    expect(read).toMatchObject({
      workItemId: item.id,
      noteMd: '## The panel\n\nRendered note.',
      noteTruncated: false,
      commitSha: 'c0389f2',
      ciRunUrl: 'https://github.com/x/y/actions/runs/1',
      producedByKey: 'MOTIR-2669',
    });

    expect(read!.assets.map((a) => a.kind)).toEqual(['mock', 'image', 'note_file']);
    expect(read!.assets.map((a) => a.position)).toEqual([0, 1, 2]);
    expect(read!.assets.map((a) => a.sourcePath)).toEqual([
      'design/work-items/result.mock.html',
      'design/work-items/result.png',
      'design/work-items/design-notes.md',
    ]);
    expect(read!.assets.map((a) => a.mimeType)).toEqual([
      'text/html',
      'image/png',
      'text/markdown',
    ]);
    expect(read!.assets.map((a) => a.sizeBytes)).toEqual([4096, 8192, 512]);
  });

  it('every asset url is the AUTHENTICATED content route — never a store URL', async () => {
    const item = await makeSubtask(fx);
    await designEvidenceService.recordFromPathnames(
      {
        workItemId: item.id,
        assets: [
          seedAsset(fx, item.id, {
            kind: 'mock',
            name: 'a.mock.html',
            contentType: 'text/html',
          }),
        ],
      },
      fx.ctx,
    );

    const read = await designEvidenceService.getCurrentForWorkItem(item.id, fx.ctx);
    const url = read!.assets[0]!.url!;

    // The panel puts this string in an <iframe src>. If it were ever a signed
    // store URL, the frame would load cross-origin content with no viewer check
    // and the link would keep working after the reader lost access.
    expect(url).toMatch(/^\/api\/attachments\/[^/]+\/content$/);
    expect(url).not.toMatch(/^https?:/);

    const rows = await db.attachment.findMany({ where: { workItemId: item.id } });
    expect(url).toBe(designAssetContentPath(rows[0]!.id));
  });

  it('heads the store once per asset — the size and type are read, never taken on trust', async () => {
    const item = await makeSubtask(fx);
    const assets = [
      seedAsset(fx, item.id, { kind: 'mock', name: 'm.mock.html', contentType: 'text/html' }),
      seedAsset(fx, item.id, { kind: 'image', name: 'm.png', contentType: 'image/png' }),
    ];

    await designEvidenceService.recordFromPathnames({ workItemId: item.id, assets }, fx.ctx);

    expect(vi.mocked(headPrivateBlob)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(headPrivateBlob).mock.calls.map((c) => c[0])).toEqual(
      assets.map((a) => a.pathname),
    );
  });

  it('a superseding publish is what the panel reads next — the seam survives a second run', async () => {
    const item = await makeSubtask(fx);
    for (const [i, name] of ['first.mock.html', 'second.mock.html'].entries()) {
      await designEvidenceService.recordFromPathnames(
        {
          workItemId: item.id,
          assets: [seedAsset(fx, item.id, { kind: 'mock', name, contentType: 'text/html' })],
          commitSha: `sha-${i}`,
        },
        fx.ctx,
      );
    }

    const read = await designEvidenceService.getCurrentForWorkItem(item.id, fx.ctx);

    expect(read!.commitSha).toBe('sha-1');
    expect(read!.assets).toHaveLength(1);
    expect(read!.assets[0]!.sourcePath).toBe('design/work-items/second.mock.html');
  });
});
