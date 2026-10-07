import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The blob STORE is mocked; nothing else is. The service-bearer auth, the
// system principal, every upload gate and the link/revision transaction run for
// real against real Postgres (the same posture as the v1 door's test).
vi.mock('@/lib/blob/uploader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/blob/uploader')>()),
  putPrivateAttachment: vi.fn(async (pathname: string) => ({ pathname })),
  deleteAttachmentBlob: vi.fn(async () => {}),
}));

const { db } = await import('@/lib/db');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { seedSystemPrincipal } = await import('@/scripts/plan-seed/systemPrincipal');
const { POST } = await import('@/app/api/internal/ai/work-items/[key]/attachments/route');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');

// MOTIR-7723 — `POST /api/internal/ai/work-items/{key}/attachments`, the
// service-authenticated attachment door motir-ai uses to put
// `planning-record.json` on the planning bug it files. Real Postgres.

const SECRET = 'core-callback-secret-test';
const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
  process.env['CORE_CALLBACK_SECRET'] = SECRET;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A META workspace + `MOTIR` project + the system principal + one bug. */
async function makeMetaTenant() {
  const owner = await usersService.createUser({
    email: 'owner@example.com',
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'moooon',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'motir',
    identifier: 'MOTIR',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  const { userId: systemUserId } = await seedSystemPrincipal({
    workspaceId: workspace.id,
    projectId: project.id,
  });
  const bug = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'bug', title: 'A planning alarm' },
    { userId: owner.id, workspaceId: workspace.id },
  );
  return { bug, systemUserId };
}

function upload(
  key: string,
  opts: {
    headers?: Record<string, string>;
    filename?: string;
    type?: string;
    bytes?: string;
    omitFile?: boolean;
  } = {},
): Promise<Response> {
  const form = new FormData();
  if (!opts.omitFile) {
    form.set(
      'file',
      new File([opts.bytes ?? '{"sessions":[]}'], opts.filename ?? 'planning-record.json', {
        type: opts.type ?? 'application/json',
      }),
    );
  }
  return POST(
    new Request(`http://internal/api/internal/ai/work-items/${key}/attachments`, {
      method: 'POST',
      headers: opts.headers ?? { authorization: `Bearer ${SECRET}` },
      body: form,
    }),
    { params: Promise.resolve({ key }) },
  );
}

describe('POST /api/internal/ai/work-items/{key}/attachments — success', () => {
  it('attaches a JSON file to the named item AS the system principal → 201', async () => {
    const { bug, systemUserId } = await makeMetaTenant();

    const res = await upload(bug.identifier.toLowerCase());
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['workItemKey']).toBe(bug.identifier);
    expect(body['filename']).toBe('planning-record.json');
    expect(body['mimeType']).toBe('application/json');

    const rows = await adminDb.attachment.findMany({ where: { workItemId: bug.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.uploaderUserId).toBe(systemUserId);
    expect(rows[0]?.source).toBe('api');
    expect(rows[0]?.originalFilename).toBe('planning-record.json');
  });
});

describe('POST /api/internal/ai/work-items/{key}/attachments — refusals (typed, never 500)', () => {
  it('rejects a missing or wrong bearer → 401', async () => {
    const { bug } = await makeMetaTenant();
    expect((await upload(bug.identifier, { headers: {} })).status).toBe(401);
    expect(
      (await upload(bug.identifier, { headers: { authorization: 'Bearer nope' } })).status,
    ).toBe(401);
  });

  it('rejects a malformed key → 400 before any read', async () => {
    await makeMetaTenant();
    const res = await upload('not-a-key');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('ATTACHMENTS_INVALID');
  });

  it('rejects a missing or empty file → 400', async () => {
    const { bug } = await makeMetaTenant();
    expect((await upload(bug.identifier, { omitFile: true })).status).toBe(400);
    expect((await upload(bug.identifier, { bytes: '' })).status).toBe(400);
  });

  it('answers 404 for an unknown project or item (no existence leak)', async () => {
    await makeMetaTenant();
    expect((await upload('NOPE-1')).status).toBe(404);
    expect((await upload('MOTIR-99999')).status).toBe(404);
  });

  it('keeps the shared MIME allowlist — a type it refuses is 415, not a 500', async () => {
    const { bug } = await makeMetaTenant();
    const res = await upload(bug.identifier, {
      filename: 'x.bin',
      type: 'application/octet-stream',
    });
    expect(res.status).toBe(415);
    expect((await res.json()).code).toBe('UNSUPPORTED_FILE_TYPE');
  });
});
