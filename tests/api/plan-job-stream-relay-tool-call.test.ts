import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE RELAYS PASS THE PER-CALL FRAMES THROUGH UNCHANGED (Story MOTIR-7974 ·
// MOTIR-7976).
//
// Both planning relays — the project thread's `GET /api/ai/augment/[jobId]/stream`
// and the anchored `GET /api/work-items/[id]/ai/plan/[jobId]/stream` — write each
// frame's `event` and `JSON.stringify(data)` verbatim, so no relay code changed
// for the `tool_call` contract. This file PINS that: a future coercer that copies
// named fields would drop `callId`, `verb` or `object` silently, and the rail
// would lose its call lines with nothing red anywhere else.
//
// Per the motir-core convention only the boundary client and the two context
// resolvers the test env cannot supply (`getSession`, `getActiveProject`) are
// mocked; the permission gate runs against the real Postgres.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

const streamJobMock = vi.fn();
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/ai/motirAiClient')>();
  return { ...real, streamJob: (...args: unknown[]) => streamJobMock(...(args as [])) };
});

const { GET: augmentStream } = await import('@/app/api/ai/augment/[jobId]/stream/route');
const { GET: anchoredStream } =
  await import('@/app/api/work-items/[id]/ai/plan/[jobId]/stream/route');

const BASE = 'http://localhost:3000';

/** What the mocked motir-ai stream yields — the three frames of the contract. */
const FRAMES = [
  {
    event: 'tool_call',
    data: {
      callId: 'c1',
      tool: 'read_file',
      family: 'code_read',
      verb: 'read',
      object: { kind: 'path', value: 'lib/auth/session.ts' },
      itemRef: 'MOTIR-12',
    },
  },
  {
    event: 'retrieval',
    data: {
      tool: 'read_file',
      family: 'code_read',
      ok: false,
      args: { path: 'lib/auth/session.ts' },
      callId: 'c1',
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: 'w1',
      tool: 'add_item',
      family: 'item',
      verb: 'add',
      object: { kind: 'item', value: 'The stop' },
      itemRef: null,
    },
  },
  { event: 'tool_call_failed', data: { callId: 'w1', reason: 'refused', code: 'PLAN_GATE' } },
] as const;

/** The exact bytes a relay must write for those frames. */
const EXPECTED = FRAMES.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join(
  '',
);

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  streamJobMock.mockReset();
  streamJobMock.mockImplementation(() =>
    (async function* () {
      for (const frame of FRAMES) yield frame;
    })(),
  );
  fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the per-call frames leave both planning relays byte-identical', () => {
  it('GET /api/ai/augment/[jobId]/stream', async () => {
    const res = await augmentStream(new Request(BASE), {
      params: Promise.resolve({ jobId: 'job-1' }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(EXPECTED);
  });

  it('GET /api/work-items/[id]/ai/plan/[jobId]/stream', async () => {
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Billing' });
    const res = await anchoredStream(new Request(BASE), {
      params: Promise.resolve({ id: story.id, jobId: 'job-1' }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(EXPECTED);
  });
});
