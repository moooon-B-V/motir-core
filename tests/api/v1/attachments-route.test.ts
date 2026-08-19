import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { V1ProjectCaller } from '../../fixtures/apiV1Fixtures';

// The blob STORE is mocked; nothing else is. The gates, the entitlement lookup,
// the row write and the link/revision transaction all run for real against real
// Postgres — mocking `attachmentsService` would prove the route calls a stub,
// which is the one thing this file exists to disprove.
vi.mock('@/lib/blob/uploader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/blob/uploader')>()),
  putPrivateAttachment: vi.fn(async (pathname: string) => ({ pathname })),
  deleteAttachmentBlob: vi.fn(async () => {}),
}));

const session = vi.hoisted(() => ({ current: null as { user: { id: string } } | null }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => session.current),
}));
const activeProject = vi.hoisted(() => ({
  current: null as { userId: string; workspaceId: string; projectId: string } | null,
}));
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: vi.fn(async () => activeProject.current),
}));

const { POST } = await import('@/app/api/v1/work-items/[key]/attachments/route');
const { POST: BROWSER_POST } = await import('@/app/api/upload/issue-attachment/route');
const { attachmentRepository } = await import('@/lib/repositories/attachmentRepository');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { withWorkspaceServiceContext } = await import('@/lib/workspaces/context');
const { createV1ProjectCaller } = await import('../../fixtures/apiV1Fixtures');
const { truncateAuthTables } = await import('../../helpers/db');
const { adminDb } = await import('../../helpers/adminDb');

// POST /api/v1/work-items/{key}/attachments (Story MOTIR-3000 · Subtask
// MOTIR-3057) — the general attachment door, against real Postgres.
//
// ⚠️ THE CENTRAL CLAIM IS A NEGATIVE: no gate is re-implemented here. That is
// not checkable by reading the route — a copy of a rule looks like a rule — so
// every gate is tripped through BOTH entrances IN THIS FILE and the two statuses
// compared. If they ever disagree, a gate was copied. (`attachment-api-door.md`
// §1: a second copy of a MIME allowlist is a security control that will drift.)

const BASE = 'http://localhost:3000/api/v1';

/** A multipart request carrying one file part, authenticated by bearer token. */
function upload(
  caller: V1ProjectCaller,
  key: string,
  opts: { filename?: string; type?: string; bytes?: string | Uint8Array } = {},
): Promise<Response> {
  const form = new FormData();
  const bytes = opts.bytes ?? 'FINDINGS';
  form.set(
    'file',
    new File([bytes as BlobPart], opts.filename ?? 'findings.png', {
      type: opts.type ?? 'image/png',
    }),
  );
  // The content-type header is NOT set by hand: `FormData` makes the runtime
  // write it with its own boundary, and a hand-written one would not match.
  return POST(
    new Request(`${BASE}/work-items/${key}/attachments`, {
      method: 'POST',
      headers: caller.headers,
      body: form,
    }),
    { params: Promise.resolve({ key }) },
  );
}

/** The SAME upload through the shipped browser route — session + cookie bound. */
function browserUpload(
  opts: { filename?: string; type?: string; bytes?: string | Uint8Array } = {},
): Promise<Response> {
  const form = new FormData();
  form.set(
    'file',
    new File([(opts.bytes ?? 'FINDINGS') as BlobPart], opts.filename ?? 'findings.png', {
      type: opts.type ?? 'image/png',
    }),
  );
  return BROWSER_POST(
    new Request('http://localhost:3000/api/upload/issue-attachment', {
      method: 'POST',
      body: form,
    }),
  );
}

/** Point the BROWSER route's session + active project at this caller's tenant. */
function signInAs(caller: V1ProjectCaller): void {
  session.current = { user: { id: caller.fixture.ownerId } };
  activeProject.current = {
    userId: caller.fixture.ownerId,
    workspaceId: caller.fixture.workspaceId,
    projectId: caller.fixture.projectId,
  };
}

async function makeItem(caller: V1ProjectCaller, title: string): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind: 'task', title },
    caller.ctx,
  );
  return item.identifier;
}

let caller: V1ProjectCaller;

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
  activeProject.current = null;
  // `work_item:edit` is the permission the door asserts. Named explicitly
  // rather than taken from the default grant, so the suite states what it is
  // exercising — and so the negative case below is a real contrast.
  caller = await createV1ProjectCaller({
    permissions: ['project:browse', 'work_item:edit'],
  });
  signInAs(caller);
});

describe('the general door writes a real, visible attachment', () => {
  it('201s, stamps the TOKEN OWNER as uploader and `api` as the source, and links it to the named item', async () => {
    const key = await makeItem(caller, 'Research');

    const res = await upload(caller, key);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;

    // The wire shape addresses the item by KEY, never the internal cuid — a
    // response carrying an id no other v1 route accepts would be a dead end.
    expect(body['workItemKey']).toBe(key);
    expect(body['source']).toBe('api');
    expect(body['filename']).toBe('findings.png');
    expect((body['uploader'] as { id: string }).id).toBe(caller.fixture.ownerId);

    const rows = await adminDb.attachment.findMany({
      where: { workspaceId: caller.fixture.workspaceId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('api');
    expect(rows[0]!.uploaderUserId).toBe(caller.fixture.ownerId);
    expect(rows[0]!.workItemId).not.toBeNull();
  });

  it('the row comes back from the PANEL’s own listing — the point of the story', async () => {
    const key = await makeItem(caller, 'Research');
    const res = await upload(caller, key);
    const created = (await res.json()) as { id: string };

    const item = await workItemsService.getWorkItemByIdentifier(
      caller.fixture.projectId,
      key,
      caller.ctx,
    );
    const [listed, count] = await withWorkspaceServiceContext(
      caller.fixture.workspaceId,
      async (tx) => [
        await attachmentRepository.listByWorkItem(item.id, {}, tx),
        await attachmentRepository.countByWorkItem(item.id, tx),
      ],
    );

    expect(listed.map((a) => a.id)).toContain(created.id);
    expect(count).toBe(1);
  });
});

describe('the workspace comes from the TOKEN, never a cookie', () => {
  it('IGNORES an active-project context pointing at a DIFFERENT workspace', async () => {
    const key = await makeItem(caller, 'Research');
    const foreign = await createV1ProjectCaller({
      workspaceName: 'Other Co',
      permissions: ['project:browse', 'work_item:edit'],
    });

    // The browser route would resolve THIS. The v1 route must not see it.
    activeProject.current = {
      userId: foreign.fixture.ownerId,
      workspaceId: foreign.fixture.workspaceId,
      projectId: foreign.fixture.projectId,
    };
    session.current = { user: { id: foreign.fixture.ownerId } };

    const res = await upload(caller, key);
    expect(res.status).toBe(201);

    // The row landed in the TOKEN's workspace, attributed to the TOKEN's owner.
    const rows = await adminDb.attachment.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workspaceId).toBe(caller.fixture.workspaceId);
    expect(rows[0]!.uploaderUserId).toBe(caller.fixture.ownerId);
  });

  it('cannot tell an item in ANOTHER workspace from one that does not exist', async () => {
    // ⚠️ The oracle test has to hold the KEY constant, not just compare two
    // 404s. Both projects use the `PROD` prefix, so `PROD-1` is one string the
    // foreign caller can ask about in both worlds — and the message echoes the
    // caller's own input, so two DIFFERENT keys would differ for a reason that
    // leaks nothing. What must not vary is the answer to ONE key.
    const foreign = await createV1ProjectCaller({
      workspaceName: 'Other Co',
      permissions: ['project:browse', 'work_item:edit'],
    });

    // World A: `PROD-1` exists — in a workspace this token cannot see.
    const key = await makeItem(caller, 'Research');
    expect(key).toBe('PROD-1');
    const whenItExistsElsewhere = await upload(foreign, 'PROD-1');
    const bodyA = await whenItExistsElsewhere.text();

    // World B: nothing named `PROD-1` exists anywhere this token could reach.
    // (Its own project is empty; the other workspace's row is invisible either
    // way — which is exactly the claim.)
    const whenItExistsNowhere = await upload(foreign, 'PROD-999');
    const bodyB = (await whenItExistsNowhere.text()).replace('PROD-999', 'PROD-1');

    expect(whenItExistsElsewhere.status).toBe(404);
    expect(whenItExistsNowhere.status).toBe(whenItExistsElsewhere.status);
    // Identical once the echoed key is normalised — same code, same wording,
    // same shape. Nothing about the other workspace's item survives into it.
    expect(bodyA).toBe(bodyB);
    expect(bodyA).not.toContain('Research');
    expect(bodyA).not.toContain(caller.fixture.workspaceId);

    // …and the refusal wrote nothing: the row from world A is the only one.
    expect(await adminDb.attachment.count()).toBe(0);
  });
});

describe('every gate answers the SAME status through both entrances', () => {
  // The comparison IS the assertion. Hard-coding 415 here would pass just as
  // happily if the route grew its own allowlist that agreed today and drifted
  // next quarter.
  it('a disallowed media type', async () => {
    const key = await makeItem(caller, 'Research');
    const viaApi = await upload(caller, key, {
      filename: 'x.exe',
      type: 'application/x-msdownload',
    });
    const viaBrowser = await browserUpload({ filename: 'x.exe', type: 'application/x-msdownload' });

    expect(viaApi.status).toBe(415);
    expect(((await viaApi.json()) as { code: string }).code).toBe('UNSUPPORTED_FILE_TYPE');
    expect(viaBrowser.status).toBe(viaApi.status);
    expect(await adminDb.attachment.count()).toBe(0);
  });

  it('a file over the per-file limit', async () => {
    const key = await makeItem(caller, 'Research');
    // One byte past the off-cloud baseline the service resolves.
    const { MAX_UPLOAD_BYTES } = await import('@/lib/blob/allowlist');
    const tooBig = new Uint8Array(MAX_UPLOAD_BYTES + 1);

    const viaApi = await upload(caller, key, { bytes: tooBig });
    const viaBrowser = await browserUpload({ bytes: tooBig });

    expect(viaApi.status).toBe(413);
    expect(((await viaApi.json()) as { code: string }).code).toBe('FILE_TOO_LARGE');
    expect(viaBrowser.status).toBe(viaApi.status);
    expect(await adminDb.attachment.count()).toBe(0);
  });

  it('leaves NO row behind when a gate refuses', async () => {
    const key = await makeItem(caller, 'Research');
    await upload(caller, key, { filename: 'x.exe', type: 'application/x-msdownload' });
    await upload(caller, key, { bytes: new Uint8Array(11 * 1024 * 1024) });
    expect(await adminDb.attachment.count()).toBe(0);
  });
});

describe('a malformed request is a 422, never a 500', () => {
  it('no `file` part', async () => {
    const key = await makeItem(caller, 'Research');
    const form = new FormData();
    form.set('notafile', 'hello');
    const res = await POST(
      new Request(`${BASE}/work-items/${key}/attachments`, {
        method: 'POST',
        headers: caller.headers,
        body: form,
      }),
      { params: Promise.resolve({ key }) },
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_MULTIPART_BODY');
  });

  it('an EMPTY file', async () => {
    const key = await makeItem(caller, 'Research');
    const res = await upload(caller, key, { bytes: '' });
    expect(res.status).toBe(422);
    expect(await adminDb.attachment.count()).toBe(0);
  });

  it('a body that is not multipart at all', async () => {
    const key = await makeItem(caller, 'Research');
    const res = await POST(
      new Request(`${BASE}/work-items/${key}/attachments`, {
        method: 'POST',
        headers: { ...caller.headers, 'content-type': 'application/json' },
        body: '{"file":"nope"}',
      }),
      { params: Promise.resolve({ key }) },
    );
    expect(res.status).toBe(422);
  });

  it('a MALFORMED key is a 422 before any read', async () => {
    const res = await upload(caller, 'not-a-key');
    expect(res.status).toBe(422);
  });
});

describe('the browser route is untouched', () => {
  it('still uploads, and still stamps `panel` rather than `api`', async () => {
    const key = await makeItem(caller, 'Research');
    const item = await workItemsService.getWorkItemByIdentifier(
      caller.fixture.projectId,
      key,
      caller.ctx,
    );
    const { attachmentsService } = await import('@/lib/services/attachmentsService');

    // The panel path, with no source argument — the default this card added must
    // not have moved it.
    const dto = await attachmentsService.attachToWorkItem(
      item.id,
      new File(['X'], 'panel.png', { type: 'image/png' }),
      caller.ctx,
    );
    expect(dto.source).toBe('panel');

    const res = await browserUpload();
    expect(res.status).toBe(200);
  });
});
