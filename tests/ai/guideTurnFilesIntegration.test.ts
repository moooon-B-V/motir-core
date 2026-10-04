import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { GuideContext } from '@/lib/ai/guideWorkItem';
import { GUIDE_FILE_TEXT_MAX, GUIDE_IMAGE_MAX_BYTES } from '@/lib/ai/guideFiles';
import type { AttachmentDTO } from '@/lib/dto/attachments';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import type { AiJobsFixture, GuideJobOutcome } from '@/lib/test-ai-jobs-mock';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { ALIGNED_WINDOW_MS } from '../helpers/rateLimitWindow';

// FILES ON A GUIDE TURN, against a REAL Postgres and the attachment store lane
// (Story MOTIR-7471 · MOTIR-7487; `docs/decisions/guide-turn-files.md`).
//
// Nothing the story wrote is mocked. A file goes up through the shipped upload
// route (`POST /api/work-items/{id}/attachments`) into the object store's
// in-process transport — `lib/test-blob-mock.ts`, the SAME seam the E2E lane
// installs, so the real S3 client serialises and signs the PUT and the GET that
// later reads the bytes back. motir-ai is crossed on the wire through
// `lib/test-ai-jobs-mock.ts` (the undici intercept the guide gate uses), so the
// `guideContext.files` asserted here is the body of a `POST /v1/jobs`. The only
// module mocks are the three request-bound reads that need cookies: the
// session, the active project and the workspace context.
//
// The composer half (attach, paste, drop, the tray, Retry) is the component
// suite `tests/components/guide-turn-files.test.tsx`; the browser flow is the
// story's acceptance run.

const ORIGIN = 'http://motir-ai.guide-files.test';

const S3_ENV = {
  MOTIR_S3_ENDPOINT: 'https://s3.guide-files.invalid',
  MOTIR_S3_REGION: 'auto',
  MOTIR_S3_ACCESS_KEY_ID: 'test-access-key',
  MOTIR_S3_SECRET_ACCESS_KEY: 'test-secret-key',
  MOTIR_S3_PRIVATE_BUCKET: 'motir-private',
  MOTIR_S3_PUBLIC_BUCKET: 'motir-public',
  MOTIR_S3_PUBLIC_BASE_URL: 'https://s3.guide-files.invalid/motir-public',
} as const;

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => session.current,
}));
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: async () => activeCtx.current,
}));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () =>
    activeCtx.current
      ? { userId: activeCtx.current.userId, workspaceId: activeCtx.current.workspaceId }
      : null,
}));

let fixturePath: string;
let agent: MockAgent;
/** Every `POST /v1/jobs` body the seam received, in order. */
const wire: { jobKind: string; context: { guideContext?: GuideContext } }[] = [];

beforeAll(async () => {
  fixturePath = join(mkdtempSync(join(tmpdir(), 'motir-guide-files-')), 'jobs.json');
  writeFileSync(fixturePath, '{}');
  vi.stubEnv('MOTIR_AI_URL', ORIGIN);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token-test');
  vi.stubEnv('MOTIR_AI_JOBS_FIXTURE_PATH', fixturePath);
  // A generous budget so the uploads are never refused; the window is pinned to
  // the aligned grid per MOTIR-2648. No case here asserts a refusal.
  vi.stubEnv('MOTIR_UPLOAD_RATE_LIMIT', '1000');
  vi.stubEnv('MOTIR_UPLOAD_RATE_LIMIT_WINDOW_MS', String(ALIGNED_WINDOW_MS));
  for (const [name, value] of Object.entries(S3_ENV)) vi.stubEnv(name, value);

  agent = new MockAgent();
  agent.enableNetConnect();
  setGlobalDispatcher(agent);
  // Installed ONCE: the submit observer keeps its subscribers in module scope.
  const { installAiJobsBoundaryMock, observeAiJobSubmit } = await import('@/lib/test-ai-jobs-mock');
  installAiJobsBoundaryMock(agent);
  observeAiJobSubmit((raw) => {
    wire.push(JSON.parse(raw) as (typeof wire)[number]);
  });
});

afterAll(async () => {
  const { resetS3ClientForTests } = await import('@/lib/blob/s3');
  resetS3ClientForTests();
  vi.unstubAllEnvs();
  await agent.close();
  await db.$disconnect();
  await adminDb.$disconnect();
});

const { POST: guide } = await import('@/app/api/ai/guide/route');
const { POST: guideSettle } = await import('@/app/api/ai/guide/settle/route');
const { POST: ask } = await import('@/app/api/ai/ask/route');
const { GET: listAttachments, POST: uploadAttachment } =
  await import('@/app/api/work-items/[id]/attachments/route');
const { installBlobStoreMock } = await import('@/lib/test-blob-mock');

const BASE = 'http://localhost:3000';
const post = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// ── The motir-ai side ─────────────────────────────────────────────────────────

const readFixture = () => JSON.parse(readFileSync(fixturePath, 'utf8')) as AiJobsFixture;
/** The n-th guide job's turn (0-based), declared for every job up to it. */
function turnAt(n: number, actions: unknown[], messageMd = 'Next step.'): void {
  const queue: GuideJobOutcome[] = [...(readFixture().guide ?? [])];
  while (queue.length < n) queue.push({});
  queue[n] = { guideTurn: { messageMd, actions } };
  writeFileSync(fixturePath, JSON.stringify({ ...readFixture(), guide: queue }));
}
const guideWire = () => wire.filter((b) => b.jobKind === 'guide_work_item');
const lastContext = () => guideWire().at(-1)!.context.guideContext!;

// ── The core side ─────────────────────────────────────────────────────────────

interface Turned {
  jobId: string;
  session: PlanChangeSessionDto;
}

let fx: WorkItemFixture;

function actAs(f: WorkItemFixture): void {
  session.current = { user: { id: f.ownerId, email: 'owner@example.com', name: 'Owner' } };
  activeCtx.current = {
    userId: f.ownerId,
    workspaceId: f.workspaceId,
    projectId: f.projectId,
    project: f.project,
  };
}

async function manualCard(title = 'Rotate the signing key', f = fx) {
  const item = await createTestWorkItem(f, {
    kind: 'task',
    title,
    type: 'manual',
    executor: 'human',
  });
  return adminDb.workItem.update({ where: { id: item.id }, data: { status: 'todo' } });
}

async function open(itemKey: string): Promise<Turned> {
  const res = await guide(post('/api/ai/guide', { itemKey }));
  expect(res.status).toBe(200);
  return (await res.json()) as Turned;
}
async function settle(t: Turned): Promise<Array<[string, string]>> {
  const res = await guideSettle(
    post('/api/ai/guide/settle', { jobId: t.jobId, sessionId: t.session.id }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    record?: { outcomes: Array<{ type: string; outcome: string }> };
  };
  return (body.record?.outcomes ?? []).map((o) => [o.type, o.outcome]);
}
/** Open the guide and land its opening turn, so the conversation is idle. */
async function openIdle(itemKey: string, actions: unknown[] = []): Promise<Turned> {
  const opened = await open(itemKey);
  turnAt(guideWire().length - 1, actions);
  await settle(opened);
  return opened;
}
function sendTurn(sessionId: string, text: string | undefined, attachmentIds: string[]) {
  return guide(
    post('/api/ai/guide', { sessionId, ...(text !== undefined ? { text } : {}), attachmentIds }),
  );
}

/** Upload one file through the SHIPPED route, as the composer does. */
async function upload(workItemId: string, file: File) {
  const form = new FormData();
  form.append('file', file);
  return uploadAttachment(
    new Request(`${BASE}/api/work-items/${workItemId}/attachments`, {
      method: 'POST',
      body: form,
    }),
    { params: Promise.resolve({ id: workItemId }) },
  );
}
async function uploaded(workItemId: string, file: File): Promise<AttachmentDTO> {
  const res = await upload(workItemId, file);
  expect(res.status).toBe(201);
  return (await res.json()) as AttachmentDTO;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const png = (name = 'console.png') => new File([PNG], name, { type: 'image/png' });
const text = (body: string, name = 'notes.txt', type = 'text/plain') =>
  new File([body], name, { type });

const userTurns = async (sessionId: string) =>
  adminDb.planChangeTurn.findMany({ where: { sessionId, role: 'user' }, orderBy: { seq: 'asc' } });

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "attachment" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  installBlobStoreMock();
  wire.length = 0;
  writeFileSync(fixturePath, '{}');
  fx = await makeWorkItemFixture();
  actAs(fx);
});

describe('upload → attach → the job’s context', () => {
  it('lands each file on the guided card, and sends the image inline and the text cut', async () => {
    const card = await manualCard();
    await workItemTodosService.addTodo(card.id, { text: 'Paste the key' }, fx.ctx);
    const opened = await openIdle(card.identifier);

    const shot = await uploaded(card.id, png());
    const log = await uploaded(card.id, text('x'.repeat(GUIDE_FILE_TEXT_MAX + 50), 'run.log'));

    // The card lists both, with the person as their uploader.
    const listed = await listAttachments(
      new Request(`${BASE}/api/work-items/${card.id}/attachments`),
      { params: Promise.resolve({ id: card.id }) },
    );
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as { attachments: AttachmentDTO[] };
    expect(page.attachments.map((a) => [a.filename, a.source, a.uploader.id]).sort()).toEqual([
      ['console.png', 'panel', fx.ownerId],
      ['run.log', 'panel', fx.ownerId],
    ]);

    const res = await sendTurn(opened.session.id, 'This is what I see.', [shot.id, log.id]);
    expect(res.status).toBe(200);
    const turned = (await res.json()) as Turned;

    // The job carries the CURRENT turn's files, resolved from the stored bytes.
    expect(lastContext().files).toEqual([
      {
        attachmentId: shot.id,
        name: 'console.png',
        mime: 'image/png',
        kind: 'image',
        dataUrl: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`,
      },
      {
        attachmentId: log.id,
        name: 'run.log',
        mime: 'text/plain',
        kind: 'text',
        text: 'x'.repeat(GUIDE_FILE_TEXT_MAX),
        cut: true,
      },
    ]);

    // The turn records the ids in order, and the session DTO resolves them.
    expect((await userTurns(opened.session.id)).at(-1)!.attachmentIds).toEqual([shot.id, log.id]);
    const sent = turned.session.turns.filter((t) => t.role === 'user').at(-1)!;
    expect(sent.attachmentIds).toEqual([shot.id, log.id]);
    expect(Object.keys(turned.session.attachments ?? {}).sort()).toEqual([shot.id, log.id].sort());

    // The NEXT turn re-sends no bytes: the earlier files ride the history as notes.
    turnAt(guideWire().length - 1, []);
    await settle(turned);
    const next = await sendTurn(opened.session.id, 'Done.', []);
    expect(next.status).toBe(200);
    expect(lastContext().files ?? []).toEqual([]);
    const withFiles = lastContext().turns.filter((t) => t.files && t.files.length > 0);
    expect(withFiles).toHaveLength(1);
    expect(withFiles[0]!.files).toEqual([
      { name: 'console.png', kind: 'image' },
      { name: 'run.log', kind: 'text' },
    ]);
  });

  it('a turn of files and no words is sent', async () => {
    const card = await manualCard();
    const opened = await openIdle(card.identifier);
    const shot = await uploaded(card.id, png());
    const res = await sendTurn(opened.session.id, undefined, [shot.id]);
    expect(res.status).toBe(200);
    expect(lastContext().files).toHaveLength(1);
    expect((await userTurns(opened.session.id)).at(-1)!.body).toBe('');
  });

  it('a PDF, an SVG and an oversize image are attached and sent by name and kind only', async () => {
    const card = await manualCard();
    const opened = await openIdle(card.identifier);
    const pdf = await uploaded(
      card.id,
      new File(['%PDF-1.4'], 'guide.pdf', { type: 'application/pdf' }),
    );
    const svg = await uploaded(
      card.id,
      new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'logo.svg', {
        type: 'image/svg+xml',
      }),
    );
    const big = await uploaded(
      card.id,
      new File([new Uint8Array(GUIDE_IMAGE_MAX_BYTES + 1)], 'huge.png', { type: 'image/png' }),
    );
    const res = await sendTurn(opened.session.id, 'Here.', [pdf.id, svg.id, big.id]);
    expect(res.status).toBe(200);
    expect(lastContext().files).toEqual([
      {
        attachmentId: pdf.id,
        name: 'guide.pdf',
        mime: 'application/pdf',
        kind: 'unread',
        reason: 'type_not_read',
      },
      {
        attachmentId: svg.id,
        name: 'logo.svg',
        mime: 'image/svg+xml',
        kind: 'unread',
        reason: 'type_not_read',
      },
      {
        attachmentId: big.id,
        name: 'huge.png',
        mime: 'image/png',
        kind: 'unread',
        reason: 'image_too_large',
      },
    ]);
  });

  it('a file deleted from the card since its turn is dropped from the thread, not a fault', async () => {
    const card = await manualCard();
    const opened = await openIdle(card.identifier);
    const shot = await uploaded(card.id, png());
    const turned = (await (await sendTurn(opened.session.id, 'Look.', [shot.id])).json()) as Turned;
    turnAt(guideWire().length - 1, []);
    await settle(turned);
    await adminDb.attachment.delete({ where: { id: shot.id } });

    const next = await sendTurn(opened.session.id, 'And now?', []);
    expect(next.status).toBe(200);
    const body = (await next.json()) as Turned;
    expect(body.session.attachments ?? {}).toEqual({});
    expect(lastContext().turns.some((t) => (t.files?.length ?? 0) > 0)).toBe(false);
  });
});

describe('ownership — a file must be on the guided card', () => {
  async function refused(
    sessionId: string,
    ids: string[],
    reason: 'not_on_card' | 'too_many' | 'duplicate',
  ) {
    const jobsBefore = guideWire().length;
    const turnsBefore = (await userTurns(sessionId)).length;
    const res = await sendTurn(sessionId, 'Look at this.', ids);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'GUIDE_TURN_FILES_REFUSED', reason });
    // Nothing was sent: no job on the wire, no turn on the thread.
    expect(guideWire()).toHaveLength(jobsBefore);
    expect(await userTurns(sessionId)).toHaveLength(turnsBefore);
  }

  it('another card’s attachment, in the same project, is refused', async () => {
    const card = await manualCard();
    const other = await manualCard('Another card');
    const opened = await openIdle(card.identifier);
    const theirs = await uploaded(other.id, png());
    const mine = await uploaded(card.id, png('mine.png'));
    await refused(opened.session.id, [mine.id, theirs.id], 'not_on_card');
  });

  it('another workspace’s attachment is refused', async () => {
    const elsewhere = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });
    const theirCard = await manualCard('Theirs', elsewhere);
    actAs(elsewhere);
    const theirs = await uploaded(theirCard.id, png());

    actAs(fx);
    const card = await manualCard();
    const opened = await openIdle(card.identifier);
    await refused(opened.session.id, [theirs.id], 'not_on_card');
  });

  it('an id that names no attachment, a repeated id and a fifth file are refused', async () => {
    const card = await manualCard();
    const opened = await openIdle(card.identifier);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push((await uploaded(card.id, png(`${i}.png`))).id);
    await refused(opened.session.id, ['cl_not_an_attachment'], 'not_on_card');
    await refused(opened.session.id, [ids[0]!, ids[0]!], 'duplicate');
    await refused(opened.session.id, ids, 'too_many');
  });

  it('an editor embed on the card is not a guide file', async () => {
    const card = await manualCard();
    const opened = await openIdle(card.identifier);
    const shot = await uploaded(card.id, png());
    await adminDb.attachment.update({ where: { id: shot.id }, data: { source: 'editor' } });
    const res = await sendTurn(opened.session.id, 'Look.', [shot.id]);
    // An editor-sourced row is still on the card; what it is NOT is lifecycle-owned.
    expect(res.status).toBe(200);
    await adminDb.attachment.update({
      where: { id: shot.id },
      data: { source: 'design_asset' },
    });
    turnAt(guideWire().length - 1, []);
    await settle((await res.json()) as Turned);
    await refused(opened.session.id, [shot.id], 'not_on_card');
  });
});

describe('the shipped allow-list and size refusals', () => {
  it('a type off the allow-list is 415 and lands nothing on the card', async () => {
    const card = await manualCard();
    const res = await upload(
      card.id,
      new File(['MZ'], 'setup.exe', { type: 'application/x-msdownload' }),
    );
    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' });
    expect(await adminDb.attachment.count({ where: { workItemId: card.id } })).toBe(0);
  });

  it('a file over the upload cap is 413 and lands nothing on the card', async () => {
    const card = await manualCard();
    const res = await upload(
      card.id,
      new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' }),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(await adminDb.attachment.count({ where: { workItemId: card.id } })).toBe(0);
  });
});

describe('a temporary walk', () => {
  it('still attaches the file to the card, and the job reads it beside the unsaved list', async () => {
    const card = await manualCard('Add the DNS records');
    const opened = await openIdle(card.identifier, [
      {
        type: 'propose_todos',
        rows: [
          { id: 'tmp-1', text: 'Open the DNS console' },
          { id: 'tmp-2', text: 'Add the SPF record' },
        ],
      },
    ]);
    const walk = (await (
      await guide(post('/api/ai/guide', { sessionId: opened.session.id, text: 'Walk it.' }))
    ).json()) as Turned;
    // An agent step on the UNSAVED list is recorded too (A3.9 (a)).
    turnAt(guideWire().length - 1, [
      { type: 'current_step', rowId: 'tmp-1' },
      { type: 'local_agent_prompt', rowId: 'tmp-2', prompt: 'Add the SPF record with the CLI.' },
      { type: 'local_agent_prompt', rowId: 'tmp-9', prompt: 'Not a step.' },
    ]);
    expect(await settle(walk)).toEqual([
      ['current_step', 'recorded'],
      ['local_agent_prompt', 'recorded'],
      ['local_agent_prompt', 'skipped'],
    ]);

    const shot = await uploaded(card.id, png('dns.png'));
    const res = await sendTurn(opened.session.id, 'Is this the right screen?', [shot.id]);
    expect(res.status).toBe(200);

    // The list is still unsaved — and the file is on the card all the same.
    expect(lastContext().todos.temporary).toBe(true);
    expect(await adminDb.workItemTodo.count({ where: { workItemId: card.id } })).toBe(0);
    expect(lastContext().files).toMatchObject([{ attachmentId: shot.id, kind: 'image' }]);
    expect(await adminDb.attachment.findUniqueOrThrow({ where: { id: shot.id } })).toMatchObject({
      workItemId: card.id,
      source: 'panel',
      uploaderUserId: fx.ownerId,
    });
  });
});

describe('guide only (A3.7)', () => {
  it('the guide door refuses ids that address no conversation', async () => {
    const card = await manualCard();
    const shot = await uploaded(card.id, png());
    const res = await guide(
      post('/api/ai/guide', { itemKey: card.identifier, attachmentIds: [shot.id] }),
    );
    expect(res.status).toBe(400);
    expect(guideWire()).toHaveLength(0);
  });

  it('an ask turn with files is refused, with or without a session, and starts no job', async () => {
    const card = await manualCard();
    const shot = await uploaded(card.id, png());

    const loose = await ask(
      post('/api/ai/ask', { body: 'What is this?', attachmentIds: [shot.id] }),
    );
    expect(loose.status).toBe(400);
    expect(await loose.json()).toMatchObject({ code: 'TURN_FILES_GUIDE_ONLY' });
    expect(wire).toHaveLength(0);

    // A real ask conversation, then a file sent into it.
    const started = await ask(post('/api/ai/ask', { body: 'What is in this project?' }));
    expect(started.status).toBe(200);
    const askSession = await adminDb.planChangeSession.findFirstOrThrow({
      where: { origin: { not: 'guide' } },
    });
    const jobs = wire.length;
    const turns = await adminDb.planChangeTurn.count({ where: { sessionId: askSession.id } });
    const inSession = await ask(
      post('/api/ai/ask', {
        body: 'And this?',
        sessionId: askSession.id,
        attachmentIds: [shot.id],
      }),
    );
    expect(inSession.status).toBe(400);
    expect(await inSession.json()).toMatchObject({ code: 'TURN_FILES_GUIDE_ONLY' });
    expect(wire).toHaveLength(jobs);
    expect(await adminDb.planChangeTurn.count({ where: { sessionId: askSession.id } })).toBe(turns);
  });

  it('the ask door forwards a guide conversation’s files to the guide', async () => {
    const card = await manualCard();
    const opened = await openIdle(card.identifier);
    const shot = await uploaded(card.id, png());
    const res = await ask(
      post('/api/ai/ask', {
        body: 'Here.',
        sessionId: opened.session.id,
        attachmentIds: [shot.id],
      }),
    );
    expect(res.status).toBe(200);
    expect(guideWire().at(-1)!.context.guideContext!.files).toMatchObject([
      { attachmentId: shot.id, kind: 'image' },
    ]);
  });

  it('the guide door’s body is checked before anything runs', async () => {
    const card = await manualCard();
    const opened = await openIdle(card.identifier);
    const jobs = guideWire().length;
    const bad = async (body: unknown) => {
      const res = await guide(post('/api/ai/guide', body));
      expect(res.status).toBe(400);
    };
    await bad({ sessionId: opened.session.id, text: 42 });
    await bad({ turnId: 't1' });
    await bad({ sessionId: opened.session.id });
    await bad({ sessionId: opened.session.id, attachmentIds: [] });
    await bad({ itemKey: '  ' });
    const notJson = await guide(
      new Request(`${BASE}/api/ai/guide`, { method: 'POST', body: '{not json' }),
    );
    expect(notJson.status).toBe(400);
    expect(guideWire()).toHaveLength(jobs);
  });

  it('malformed ids are a 400 at either door', async () => {
    const card = await manualCard();
    const opened = await openIdle(card.identifier);
    for (const attachmentIds of ['one', [1], ['']]) {
      const g = await guide(
        post('/api/ai/guide', { sessionId: opened.session.id, text: 'x', attachmentIds }),
      );
      expect(g.status).toBe(400);
      const a = await ask(post('/api/ai/ask', { body: 'x', attachmentIds }));
      expect(a.status).toBe(400);
    }
  });
});
