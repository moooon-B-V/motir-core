// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { renderWithIntl } from '../../helpers/renderWithIntl';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// ═══════════════════════════════════════════════════════════════════════════
// AN OPEN OVERLAY LEARNS ITS QUESTION WAS WITHDRAWN FOR A CONFLICT (Subtask
// MOTIR-5917, for Bug MOTIR-5907; `design/github/design-notes.md` § 30 Panels 4a, 4b)
// ═══════════════════════════════════════════════════════════════════════════
//
// A base-branch push put a member in conflict, and the approve-to-merge gate was
// superseded with `conflict` while somebody had it open full screen. That moves no
// STAMP, so § 26's *subject moved* notice never fires for it — the probe's GATE is
// what has to say so. Over real Postgres and the real route, with the Workbench's
// live host above the overlay and a stream this file controls:
//
//   · 4a — on the next nudge the notice appears, naming the member and its base, and
//     BOTH verbs are drawn DISABLED rather than removed; the frame beneath is NOT
//     re-rendered (band 1 still says *Awaiting you*, the row carries no conflict pill).
//   · 4b — *Show the current version* re-reads, and the fill port draws the item page's
//     withdrawn frame with the `conflict` band (MOTIR-5916).
//   · The § 26 guard — a nudge with the gate still awaiting changes nothing: no notice,
//     the verbs stay live.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getSession: async () => session.current };
});
vi.mock('@/lib/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/projects')>();
  return { ...actual, getActiveProject: async () => activeCtx.current };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));
const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => '/workbench',
  useSearchParams: () => nav.params,
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn(), shallowReplace: vi.fn() }));

const { GET: gateRoute } = await import('@/app/api/work-items/approval-gate/route');
const { approvalGateRepository } = await import('@/lib/repositories/approvalGateRepository');
const { pullRequestMergeabilityService } =
  await import('@/lib/services/pullRequestMergeabilityService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { ApprovalOverlay } = await import('@/components/approvals/ApprovalOverlay');
const { WorkbenchLive } = await import('../../../app/(authed)/workbench/_components/WorkbenchLive');
const { WORKBENCH_STREAM_PATH } =
  await import('../../../app/(authed)/workbench/_components/useWorkbenchLive');

const SLOW = { timeout: 15_000 };
const HEAD = '9840d00ea1b2c3d4e5f60718293a4b5c6d7e8f90';
const pra = en.approvalGate.pullRequestApproval;

let fx: WorkItemFixture;
let stream: ReadableStreamDefaultController<Uint8Array> | null;
let gateReads = 0;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  stream = null;
  gateReads = 0;
  push.mockReset();
  refresh.mockReset();
  // The overlay's reads go to the REAL route; the host's stream is one this file feeds.
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost:3000');
    if (url.pathname === WORKBENCH_STREAM_PATH) {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          stream = c;
        },
      });
      return new Response(body, { status: 200 });
    }
    if (url.pathname !== '/api/work-items/approval-gate') throw new Error(`unexpected ${url}`);
    const res = await gateRoute(new Request(url));
    gateReads += 1;
    return res;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A story in review delivering ONE green pull request, `acme/web · #7`, with its
 *  approve-to-merge gate awaiting the owner. */
async function awaitingStory(): Promise<{ story: WorkItem; prId: string; gateId: string }> {
  const created = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Throttle the public API' },
    fx.ctx,
  );
  await workItemsService.updateStatus(created.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(created.id, 'in_review', fx.ctx);
  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: fx.workspaceId,
      installationId: 'inst-5917',
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      installationId: installation.id,
      repoId: 'repo-5917',
      owner: 'acme',
      name: 'web',
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  const pr = await adminDb.githubPullRequest.create({
    data: {
      repoId: repo.id,
      number: 7,
      title: 'Change in web',
      state: 'open',
      merged: false,
      headRef: 'parent/ACME-12-throttle',
      baseRef: 'main',
      provider: 'github',
    },
  });
  await adminDb.githubCheckRun.create({
    data: { pullRequestId: pr.id, commitSha: HEAD, checkName: 'Vitest', conclusion: 'success' },
  });
  await adminDb.workItemDelivery.create({
    data: {
      workspaceId: fx.workspaceId,
      workItemId: created.id,
      githubPullRequestId: pr.id,
      repoId: repo.id,
    },
  });
  const gate = await withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: created.id,
        kind: 'pull_request_approval',
        subjectId: created.id,
        subjectVersion: `acme/web#7@${HEAD}`,
      },
      tx,
    ),
  );
  const story = await adminDb.workItem.findUniqueOrThrow({ where: { id: created.id } });
  return { story, prId: pr.id, gateId: gate.id };
}

function signIn() {
  session.current = { user: { id: fx.owner.id, email: fx.owner.email, name: 'Ada Lovelace' } };
  activeCtx.current = {
    userId: fx.owner.id,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  } as ProjectContext;
}

async function open(story: WorkItem, locale: 'en' | 'zh' = 'en') {
  nav.params = new URLSearchParams(
    `tab=approvals&approval=${story.identifier}&approvalKind=pull_request_approval`,
  );
  renderWithIntl(
    <WorkbenchLive>
      <ApprovalOverlay />
    </WorkbenchLive>,
    locale === 'zh' ? { locale: 'zh', messages: zh } : undefined,
  );
  // The KEY is only in the name once the read has settled (the loading dialog is named
  // *Loading the approval*), and zh orders it before the kind — so match the key alone.
  return screen.findByRole('dialog', { name: new RegExp(story.identifier) }, SLOW);
}

/** The host's stream says the To-approve tab moved — what the withdrawal's watermark
 *  produces (MOTIR-5914's Panel 3 test pins that half). */
async function nudge() {
  await act(async () => {
    stream?.enqueue(
      new TextEncoder().encode(
        `event: watermark\ndata: ${JSON.stringify({ moved: ['approvals'], cursor: 'w1.x' })}\n\n`,
      ),
    );
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** The withdrawal itself, by the one entry point the job, the tick and the press share. */
async function conflictWithdraws(prId: string) {
  await pullRequestMergeabilityService.settleReading(fx.workspaceId, prId, {
    mergeable: false,
    mergeableState: 'dirty',
    headSha: HEAD,
  });
}

describe('§ 30 Panel 4a — the open overlay learns the withdrawal, the frame stays', () => {
  it('draws the notice naming the member and its base, and DISABLES both verbs without removing them', async () => {
    const { story, prId, gateId } = await awaitingStory();
    signIn();
    const dialog = await open(story);
    const approve = within(dialog).getByRole('button', { name: pra.verb.approveAndMerge });
    expect((approve as HTMLButtonElement).disabled).toBe(false);

    await conflictWithdraws(prId);
    expect(
      (await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gateId } })).supersededCause,
    ).toBe('conflict');
    await nudge();

    const notice = await within(dialog).findByTestId('approval-withdrawn-conflict', {}, SLOW);
    expect(notice.textContent).toContain(
      'acme/web · #7 now conflicts with main, so this question was withdrawn.',
    );
    expect(notice.textContent).toContain(en.approvalOverlay.withdrawn.next);
    expect(
      within(notice).getByRole('button', { name: en.approvalGate.refusal.stale.control }),
    ).toBeTruthy();
    // DISABLED, not removed — band 3 does not reflow under the reader.
    for (const name of [pra.verb.approveAndMerge, en.approvalGate.verb.requestChanges]) {
      expect((within(dialog).getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    }
    // The frame is NOT re-rendered: the port still draws what was read at open — no
    // conflict pill on the row, and no withdrawn band.
    expect(within(dialog).queryByTestId('pr-row-conflict')).toBeNull();
    expect(within(dialog).getByText('Change in web')).toBeTruthy();
  });

  it('says it in Chinese from the zh catalog', async () => {
    const { story, prId } = await awaitingStory();
    signIn();
    const dialog = await open(story, 'zh');
    await conflictWithdraws(prId);
    await nudge();

    const notice = await within(dialog).findByTestId('approval-withdrawn-conflict', {}, SLOW);
    expect(notice.textContent).toContain('acme/web · #7 现在与 main 冲突，因此该问题已撤回。');
    expect(notice.textContent).toContain(zh.approvalOverlay.withdrawn.next);
  });
});

describe('§ 30 Panel 4b — *Show the current version* draws the withdrawn frame', () => {
  it('re-reads, and the fill port carries the conflict band and the row’s conflict pill', async () => {
    const { story, prId } = await awaitingStory();
    signIn();
    const dialog = await open(story);
    await conflictWithdraws(prId);
    await nudge();
    const notice = await within(dialog).findByTestId('approval-withdrawn-conflict', {}, SLOW);

    fireEvent.click(
      within(notice).getByRole('button', { name: en.approvalGate.refusal.stale.control }),
    );

    expect(await within(dialog).findByTestId('pr-row-conflict', {}, SLOW)).toBeTruthy();
    expect(within(dialog).queryByTestId('approval-withdrawn-conflict')).toBeNull();
    // State G: the question is gone, so there is nothing to press at all.
    expect(within(dialog).queryByRole('button', { name: pra.verb.approveAndMerge })).toBeNull();
    expect(dialog.textContent).toContain(
      pra.withdrawn.portConflict.replace('{pr}', 'acme/web · #7').replace('{base}', 'main'),
    );
  });
});

describe('the § 26 guard — a gate still AWAITING keeps its verbs live', () => {
  it('a nudge that withdrew nothing draws no notice and disables nothing', async () => {
    const { story } = await awaitingStory();
    signIn();
    const dialog = await open(story);

    const before = gateReads;
    await nudge();
    // The probe DID answer — wait on its read, not on nothing appearing.
    await vi.waitFor(() => expect(gateReads).toBe(before + 1), SLOW);
    await act(async () => {});

    expect(within(dialog).queryByTestId('approval-withdrawn-conflict')).toBeNull();
    expect(
      (within(dialog).getByRole('button', { name: pra.verb.approveAndMerge }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
