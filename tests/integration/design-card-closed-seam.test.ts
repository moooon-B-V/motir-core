import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { shaFor } from '../helpers/commitShaFixtures';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { grantForLegacyScopes } from '@/tests/helpers/tokenGrant';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { ensureWorkWaitsOn } from '../helpers/designWaits';

// STORY VITEST GATE — A DONE DESIGN IS FINAL (Story MOTIR-5552 · Subtask
// MOTIR-5558; `docs/decisions/approval-gates.md` §6c SECOND AMENDMENT).
//
// The refusal's own card tests each door alone. This file asserts what only the
// ASSEMBLED story can show, against a real Postgres with the real decide door and
// real status transitions:
//
//   (2) THE SEAM a person lives through — publish → approve → Done → a republish
//       refused → reopen by hand → a republish accepted, with a fresh gate.
//   (3) DOOR PARITY — all five doors that reach the guard, one `done` card, one
//       code.
//   (4) THE RACE — an approval that closes the card against a publish of a new
//       version, on separate connections, with both start orders, and the
//       invariant that no `done` card ends with a version newer than the one
//       approved.
//
// The object store is the one mocked external (no store runs in the vitest
// lanes), mocked as a STORE so a publish's authoritative `head` reads what was
// put. The two ambient auth seams the HTTP doors read are the only other fakes.

const store = new Map<string, { contentType: string; size: number }>();

vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(async (pathname: string, bytes: Buffer, contentType: string) => {
    store.set(pathname, { contentType, size: bytes.byteLength });
    return { pathname };
  }),
  signedDownloadUrl: vi.fn(),
  deleteAttachmentBlob: vi.fn(async () => {}),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

// The register/mint routes try keyless GitHub OIDC first; `null` sends them to
// the PAT path this file uses.
vi.mock('@/lib/github/oidcAuth', () => ({
  authenticateGithubOidc: vi.fn(async () => null),
  GITHUB_OIDC_AUTH_MARKER: 'github-oidc',
}));

// The DELETE door is session-authed; the session cookie does not exist here.
const workspaceCtx = vi.hoisted(() => ({
  current: null as null | { userId: string; workspaceId: string },
}));
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => workspaceCtx.current };
});

const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { apiTokensService } = await import('@/lib/services/apiTokensService');
const { runPublishDesignResult, runCreateDesignUpload } =
  await import('@/lib/mcp/tools/publishDesignResult');
const { POST: MINT } = await import('@/app/api/work-items/[id]/design-evidence/upload-token/route');
const { POST: REGISTER, DELETE: WITHDRAW } =
  await import('@/app/api/work-items/[id]/design-evidence/route');
const { ApprovalGateSupersededError } = await import('@/lib/approvalGates/errors');
const { DesignCardClosedError } = await import('@/lib/designEvidence/errors');

let fx: WorkItemFixture;

beforeEach(async () => {
  store.clear();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  workspaceCtx.current = { userId: fx.ctx.userId, workspaceId: fx.ctx.workspaceId };
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/**
 * A design subtask sitting IN REVIEW — where a published design waiting for a
 * decision is, and what makes the design gate's `→ done` effect a legal edge —
 * with one open card `blocked_by` it, so a publish is never refused for having
 * nothing waiting.
 */
async function designCardInReview(title = 'Draw the frame'): Promise<WorkItem> {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: `Story for ${title}` },
    fx.ctx,
  );
  const subtask = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title },
    fx.ctx,
  );
  await ensureWorkWaitsOn(subtask.id, fx);
  await workItemsService.updateStatus(subtask.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(subtask.id, 'in_review', fx.ctx);
  return adminDb.workItem.findUniqueOrThrow({ where: { id: subtask.id } });
}

/** The MCP publish, inline form — the door an agent actually uses. */
function mcpPublish(card: WorkItem, label: string) {
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  return runPublishDesignResult(
    {
      key: card.identifier,
      assets: [
        {
          kind: 'mock',
          sourcePath: `design/frame/${label}.mock.html`,
          contentType: 'text/html',
          contentBase64: b64(`<p>${label}</p>`),
        },
        {
          kind: 'note_file',
          sourcePath: 'design/frame/design-notes.md',
          contentType: 'text/markdown',
          contentBase64: b64(`# ${label}`),
        },
      ],
      commitSha: shaFor(label),
    },
    fx.ctx,
  );
}

/** The service publish by pathnames, with the objects already in the store. */
function servicePublish(card: WorkItem, label: string) {
  const prefix = designPrefix(fx.workspaceId, card.id);
  store.set(`${prefix}${label}.mock.html`, { contentType: 'text/html', size: 64 });
  store.set(`${prefix}${label}.md`, { contentType: 'text/markdown', size: 16 });
  return designEvidenceService.recordFromPathnames(
    {
      workItemId: card.id,
      assets: [
        {
          kind: 'mock',
          sourcePath: 'design/frame/f.mock.html',
          pathname: `${prefix}${label}.mock.html`,
        },
        {
          kind: 'note_file',
          sourcePath: 'design/frame/design-notes.md',
          pathname: `${prefix}${label}.md`,
        },
      ],
      commitSha: shaFor(label),
    },
    fx.ctx,
  );
}

function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

async function currentEvidenceId(workItemId: string) {
  return (
    (await adminDb.designEvidence.findFirst({ where: { workItemId, isCurrent: true } }))?.id ?? null
  );
}

async function awaitingDesignGate(evidenceId: string) {
  return adminDb.approvalGate.findFirstOrThrow({
    where: { subjectId: evidenceId, kind: 'design_result', state: 'awaiting' },
  });
}

describe('(2) the assembled seam — approve → Done → refused → reopen → accepted', () => {
  it('walks the whole lifecycle through the real MCP door, decide door and transitions', async () => {
    const card = await designCardInReview();

    // Publish v1 through the MCP tool: a current version and an awaiting gate.
    const v1Result = await mcpPublish(card, 'v1');
    expect(v1Result.isError, toolText(v1Result)).toBeFalsy();
    const v1Id = (await currentEvidenceId(card.id))!;
    const v1Gate = await awaitingDesignGate(v1Id);

    // Approve — no pull request, so the approval is TERMINAL and writes done.
    await approvalGatesService.decide(
      { gateId: v1Gate.id, decision: 'approve', source: 'ui' },
      fx.ctx,
    );
    const approved = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(approved.status).toBe('done');

    // A republish is refused with the way forward, and nothing moves.
    const refused = await mcpPublish(card, 'v2');
    expect(refused.isError).toBe(true);
    expect(toolText(refused)).toMatch(/^DESIGN_CARD_CLOSED: /);
    expect(toolText(refused)).toMatch(/reopen the card by hand/);
    expect(toolText(refused)).toMatch(/propose a new design card/);
    expect(await currentEvidenceId(card.id)).toBe(v1Id);
    expect(await adminDb.designEvidence.count({ where: { workItemId: card.id } })).toBe(1);

    // A PERSON reopens the card through the ordinary status door.
    await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);

    // The same publish is now accepted: a new current version, decided again.
    const accepted = await mcpPublish(card, 'v2');
    expect(accepted.isError, toolText(accepted)).toBeFalsy();
    const v2Id = (await currentEvidenceId(card.id))!;
    expect(v2Id).not.toBe(v1Id);
    // No open linked pull request → the publish raises a design gate, as today.
    expect((await awaitingDesignGate(v2Id)).workItemId).toBe(card.id);
    // And the approved v1 is still pinned and still decided.
    expect(
      (await adminDb.designEvidence.findUniqueOrThrow({ where: { id: v1Id } })).pinnedAt,
    ).not.toBeNull();
    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: v1Gate.id } })).state).toBe(
      'approved',
    );
  });
});

describe('(3) door parity — every door that reaches the guard answers DESIGN_CARD_CLOSED', () => {
  it('refuses on all five doors for one done card', async () => {
    const card = await designCardInReview();
    await servicePublish(card, 'v1');
    await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'done' } });

    const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'ci',
      fixedGrant: grantForLegacyScopes(['integration']),
    });
    const post = (path: string, body: unknown) =>
      new Request(`http://localhost/api/work-items/${card.identifier}/design-evidence${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    const params = { params: Promise.resolve({ id: card.identifier }) };
    const prefix = designPrefix(fx.workspaceId, card.id);
    store.set(`${prefix}v2.mock.html`, { contentType: 'text/html', size: 64 });
    store.set(`${prefix}v2.md`, { contentType: 'text/markdown', size: 16 });

    const httpCode = async (res: Response) => ({
      status: res.status,
      code: ((await res.json()) as { code: string }).code,
    });
    const mcpCode = (result: Awaited<ReturnType<typeof runPublishDesignResult>>) => ({
      status: result.isError ? 409 : 200,
      code: toolText(result).split(':')[0] ?? '',
    });

    const doors: Array<[string, () => Promise<{ status: number; code: string }>]> = [
      ['MCP publish_design_result', async () => mcpCode(await mcpPublish(card, 'v2'))],
      [
        'MCP create_design_upload',
        async () =>
          mcpCode(
            await runCreateDesignUpload(
              {
                key: card.identifier,
                files: [
                  {
                    kind: 'mock',
                    sourcePath: 'design/frame/v2.mock.html',
                    contentType: 'text/html',
                  },
                ],
              },
              fx.ctx,
            ),
          ),
      ],
      [
        'HTTP POST design-evidence (register)',
        async () =>
          httpCode(
            await REGISTER(
              post('', {
                assets: [
                  {
                    kind: 'mock',
                    sourcePath: 'design/frame/v2.mock.html',
                    pathname: `${prefix}v2.mock.html`,
                  },
                  {
                    kind: 'note_file',
                    sourcePath: 'design/frame/design-notes.md',
                    pathname: `${prefix}v2.md`,
                  },
                ],
                commitSha: shaFor('v2'),
              }),
              params,
            ),
          ),
      ],
      [
        'HTTP POST design-evidence/upload-token',
        async () =>
          httpCode(
            await MINT(
              post('/upload-token', {
                files: [
                  {
                    kind: 'mock',
                    sourcePath: 'design/frame/v2.mock.html',
                    contentType: 'text/html',
                  },
                ],
              }),
              params,
            ),
          ),
      ],
      [
        'HTTP DELETE design-evidence (withdraw)',
        async () =>
          httpCode(
            await WITHDRAW(
              new Request(`http://localhost/api/work-items/${card.identifier}/design-evidence`, {
                method: 'DELETE',
              }),
              params,
            ),
          ),
      ],
    ];

    const answers = [];
    for (const [door, call] of doors) answers.push({ door, ...(await call()) });

    expect(answers).toEqual(
      doors.map(([door]) => ({ door, status: 409, code: 'DESIGN_CARD_CLOSED' })),
    );
    expect(await adminDb.designEvidence.count({ where: { workItemId: card.id } })).toBe(1);
  });
});

describe('(4) the race — an approval that closes the card against a publish of a new version', () => {
  const ITERATIONS = 6;
  const STAGGER_MS = 15;

  it('every iteration ends in exactly one legal outcome, in BOTH start orders', async () => {
    const outcomes: string[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      const card = await designCardInReview(`Race ${i}`);
      const v1 = await servicePublish(card, `race-${i}-v1`);
      const gate = await awaitingDesignGate(v1.id);

      // Alternate which transaction STARTS first, so both interleavings are driven
      // rather than whichever the scheduler happens to prefer.
      const approveFirst = i % 2 === 0;
      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const approve = async () => {
        if (!approveFirst) await delay(STAGGER_MS);
        return approvalGatesService.decide(
          { gateId: gate.id, decision: 'approve', source: 'ui' },
          fx.ctx,
        );
      };
      const publish = async () => {
        if (approveFirst) await delay(STAGGER_MS);
        return servicePublish(card, `race-${i}-v2`);
      };

      const [decided, published] = await Promise.allSettled([approve(), publish()]);

      // EXACTLY ONE lands.
      expect(
        [decided.status, published.status].filter((s) => s === 'fulfilled'),
        `iteration ${i}: ${JSON.stringify([decided.status, published.status])}`,
      ).toHaveLength(1);

      const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
      const current = await currentEvidenceId(card.id);
      const gateRow = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gate.id } });

      if (decided.status === 'fulfilled') {
        // The approval won: the card is done, the ORIGINAL version is current, and
        // the publish met a closed card.
        expect(row.status).toBe('done');
        expect(current).toBe(v1.id);
        expect(gateRow.state).toBe('approved');
        expect(published.status === 'rejected' && published.reason).toBeInstanceOf(
          DesignCardClosedError,
        );
        outcomes.push('approval-won');
      } else {
        // The publish won: the new version is current, the question was withdrawn,
        // and the card never reached done.
        expect(decided.reason).toBeInstanceOf(ApprovalGateSupersededError);
        expect(row.status).not.toBe('done');
        expect(current).not.toBe(v1.id);
        expect(gateRow.state).toBe('superseded');
        outcomes.push('publish-won');
      }

      // THE INVARIANT, in both branches: a done card's current version is the one
      // its approval was given on.
      if (row.status === 'done') expect(current).toBe(v1.id);
    }

    expect(outcomes).toHaveLength(ITERATIONS);
  });
});
