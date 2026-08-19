import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { V1ProjectCaller } from '../fixtures/apiV1Fixtures';
import {
  ALIGNED_WINDOW_MS,
  ALIGNED_HEADROOM_MS,
  waitForWindowHeadroom,
} from '../helpers/rateLimitWindow';
import { pinSharedRateLimitStoreDeadline } from '../helpers/rateLimitStore';

const putCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/lib/blob/uploader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/blob/uploader')>()),
  putPrivateAttachment: vi.fn(async (pathname: string) => {
    putCalls.count += 1;
    return { pathname };
  }),
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
const { runAttachFile } = await import('@/lib/mcp/tools/attachFile');
const { attachmentsService } = await import('@/lib/services/attachmentsService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { createV1ProjectCaller } = await import('../fixtures/apiV1Fixtures');
const { truncateAuthTables } = await import('../helpers/db');
const { adminDb } = await import('../helpers/adminDb');

// STORY-LEVEL INTEGRATION GATE (Story MOTIR-3000 · Subtask MOTIR-3060).
//
// The siblings each test their own half. This file tests what exists only when
// they are COMPOSED, and it deliberately owns three things no single card can:
//
//   1. TWO DOORS, ONE SERVICE. The v1 route and the MCP tool must produce rows
//      that differ only in what legitimately differs. Two entrances that drift
//      is the failure this story's whole shape is arranged to prevent, and
//      neither entrance's own suite can see it.
//   2. THE GATES THE ROUTE SUITE COULD NOT REACH — the org storage cap and the
//      per-user throttle, both of which need environment the route test does
//      not set up, and both compared against the BROWSER route's answer.
//   3. NOTHING STRANDED. A refusal must leave no row AND no blob, which is only
//      observable by counting the store's writes against the table's rows.
//
// Boundary: it re-tests no sibling's unit behaviour, drives no browser
// (MOTIR-3061), and asserts no prompt text (MOTIR-3059).

const BASE = 'http://localhost:3000/api/v1';

let caller: V1ProjectCaller;

function file(name = 'findings.md', type = 'text/markdown', bytes: string | Uint8Array = 'DATA') {
  return new File([bytes as BlobPart], name, { type });
}

function viaRoute(key: string, f = file()): Promise<Response> {
  const form = new FormData();
  form.set('file', f);
  return POST(
    new Request(`${BASE}/work-items/${key}/attachments`, {
      method: 'POST',
      headers: caller.headers,
      body: form,
    }),
    { params: Promise.resolve({ key }) },
  );
}

function viaBrowser(f = file()): Promise<Response> {
  const form = new FormData();
  form.set('file', f);
  return BROWSER_POST(
    new Request('http://localhost:3000/api/upload/issue-attachment', {
      method: 'POST',
      body: form,
    }),
  );
}

async function makeItem(title: string): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: caller.fixture.projectId, kind: 'task', title },
    caller.ctx,
  );
  return item.identifier;
}

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "attachment", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  putCalls.count = 0;
  // ⚠️ The throttle case below asserts a REFUSAL counted through the shared
  // Postgres store, and `consumeSharedRateLimit` FAILS OPEN when one increment
  // outlives the production 250 ms deadline. On a loaded runner the call this
  // suite expects refused would be SERVED, and the assertion would go red on a
  // diff that touched no rate-limiting code (MOTIR-3067). Pinning a test-time
  // deadline removes the class rather than lowering its odds.
  pinSharedRateLimitStoreDeadline();
  caller = await createV1ProjectCaller({ permissions: ['project:browse', 'work_item:edit'] });
  session.current = { user: { id: caller.fixture.ownerId } };
  activeProject.current = {
    userId: caller.fixture.ownerId,
    workspaceId: caller.fixture.workspaceId,
    projectId: caller.fixture.projectId,
  };
});

afterEach(() => {
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_UPLOAD_RATE_LIMIT'];
  delete process.env['MOTIR_UPLOAD_RATE_LIMIT_WINDOW_MS'];
});

describe('two doors, one service — the rows agree', () => {
  it('the SAME file through the route and through the MCP tool yields equivalent rows', async () => {
    const key = await makeItem('Research');

    await viaRoute(key, file('findings.md', 'text/markdown', 'SAME BYTES'));
    const toolResult = await runAttachFile(
      {
        key,
        filename: 'findings.md',
        contentType: 'text/markdown',
        contentBase64: Buffer.from('SAME BYTES').toString('base64'),
      },
      caller.ctx,
    );
    expect(toolResult.isError).toBeFalsy();

    const rows = await adminDb.attachment.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(2);
    const [viaHttp, viaMcp] = rows;

    // Everything that describes the FILE and its placement must match. What may
    // legitimately differ is only the row's own identity and the blob key it
    // was written under.
    for (const field of [
      'workspaceId',
      'workItemId',
      'uploaderUserId',
      'source',
      'mimeType',
      'sizeBytes',
      'originalFilename',
    ] as const) {
      expect(viaMcp![field], `\`${field}\` differs between the two doors`).toEqual(viaHttp![field]);
    }
    expect(viaMcp!.source).toBe('api');
  });
});

describe('the gates the route suite could not reach', () => {
  it('the ORG STORAGE CAP refuses through both entrances, with the same status', async () => {
    const key = await makeItem('Research');
    // Cloud-on makes the entitlement live; the free tier caps TOTAL storage at
    // 2 GiB, so filling it exactly is what puts the next byte over.
    //
    // ⚠️ TWO rows of 1 GiB, not one of 2 GiB. `sizeBytes` is an `int4` and 2 GiB
    // is one past its ceiling — so a single-row fixture does not fail the cap,
    // it fails the COLUMN, which would have been a green-looking test of
    // nothing. Summing two rows is also the truer fixture: the cap is a sum
    // across the organization, and this is the only place that is exercised.
    process.env['MOTIR_CLOUD'] = 'true';
    const GIB = 1024 * 1024 * 1024;
    for (const n of [1, 2]) {
      await adminDb.attachment.create({
        data: {
          workspaceId: caller.fixture.workspaceId,
          uploaderUserId: caller.fixture.ownerId,
          blobPathname: `attachments/pre-existing-${n}`,
          mimeType: 'application/pdf',
          sizeBytes: GIB,
          originalFilename: `huge-${n}.pdf`,
        },
      });
    }

    const before = await adminDb.attachment.count();
    const route = await viaRoute(key);
    const browser = await viaBrowser();

    expect(route.status).toBe(402);
    expect(((await route.json()) as { code: string }).code).toBe('ENTITLEMENT_EXCEEDED');
    // The comparison IS the assertion — hard-coding 402 on both sides would pass
    // just as happily if the route grew its own copy of the cap.
    expect(browser.status).toBe(route.status);
    expect(await adminDb.attachment.count()).toBe(before);
  });

  it('the PER-USER THROTTLE refuses through both entrances, with the same status', async () => {
    const key = await makeItem('Research');
    // A budget of one, so the second call in the window is refused.
    //
    // ⚠️ THE WINDOW IS EPOCH-ALIGNED, not opened by the first request — so this
    // case must own a whole window or the counter can reset between the two
    // uploads and serve the one it expects refused. That failure needs unlucky
    // PHASE rather than a slow runner: invisible locally, clears on every
    // rerun, and gets mis-read as CI load (MOTIR-3016). Aligning removes the
    // class; a wider window only lowers the odds.
    process.env['MOTIR_UPLOAD_RATE_LIMIT'] = '1';
    process.env['MOTIR_UPLOAD_RATE_LIMIT_WINDOW_MS'] = String(ALIGNED_WINDOW_MS);
    await waitForWindowHeadroom(ALIGNED_WINDOW_MS, ALIGNED_HEADROOM_MS);

    const first = await viaRoute(key);
    expect(first.status).toBe(201);

    const route = await viaRoute(key);
    const browser = await viaBrowser();

    expect(route.status).toBe(429);
    expect(((await route.json()) as { code: string }).code).toBe('RATE_LIMITED');
    expect(browser.status).toBe(route.status);
    // Only the first upload survived.
    expect(await adminDb.attachment.count()).toBe(1);
  });
});

describe('a refusal strands nothing', () => {
  it('leaves no row AND no blob when the media type is refused', async () => {
    const key = await makeItem('Research');
    const before = putCalls.count;

    const res = await viaRoute(key, file('x.exe', 'application/x-msdownload', 'MZ'));

    expect(res.status).toBe(415);
    expect(await adminDb.attachment.count()).toBe(0);
    // The gate runs BEFORE the store is touched — a row-only check would pass
    // even if the bytes had been written and then abandoned.
    expect(putCalls.count).toBe(before);
  });

  it('leaves no row AND no blob when the file is too large', async () => {
    const key = await makeItem('Research');
    const { MAX_UPLOAD_BYTES } = await import('@/lib/blob/allowlist');
    const before = putCalls.count;

    const res = await viaRoute(
      key,
      file('big.pdf', 'application/pdf', new Uint8Array(MAX_UPLOAD_BYTES + 1)),
    );

    expect(res.status).toBe(413);
    expect(await adminDb.attachment.count()).toBe(0);
    expect(putCalls.count).toBe(before);
  });
});

describe('the lifecycle sources stay invisible — visibility was WIDENED, not opened', () => {
  it('an `api` row is listed while `design_asset` and `acceptance_video` on the SAME item are not', async () => {
    const key = await makeItem('Research');
    await viaRoute(key);
    const item = await workItemsService.getWorkItemByIdentifier(
      caller.fixture.projectId,
      key,
      caller.ctx,
    );

    for (const source of ['design_asset', 'acceptance_video'] as const) {
      await adminDb.attachment.create({
        data: {
          workspaceId: caller.fixture.workspaceId,
          uploaderUserId: caller.fixture.ownerId,
          workItemId: item.id,
          source,
          blobPathname: `attachments/${source}`,
          mimeType: 'image/png',
          sizeBytes: 4,
          originalFilename: `${source}.png`,
        },
      });
    }

    const page = await attachmentsService.listForWorkItem(item.id, {}, caller.ctx);
    expect(page.attachments.map((a) => a.source)).toEqual(['api']);
    // The count is a second, independently-written predicate. A test that read
    // only the list would let the badge disagree with what it labels.
    expect(page.totalCount).toBe(1);
  });
});
