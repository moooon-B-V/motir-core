// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { HomeActorContext } from '@/lib/services/homeService';
import { APPROVAL_GATE_KINDS } from '@/lib/approvals/overlayAddress';
import { UNREGISTERED_GATE_KINDS } from '@/lib/approvalGates/registry';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import en from '@/messages/en.json';
import { renderWithIntl } from '../../helpers/renderWithIntl';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// ═══════════════════════════════════════════════════════════════════════════
// THE STORY GATE — DECIDE APPROVE-AND-MERGE FULL SCREEN (Story MOTIR-5437 ·
// Subtask MOTIR-5441)
// ═══════════════════════════════════════════════════════════════════════════
//
// Two code cards shipped the pull-request arm: the READ (MOTIR-5439) answers the
// Development block's data, and the HOST (MOTIR-5440) mounts that block as the
// gate's port. Each proved its own half against input it built itself. This file
// stands where they MEET, over real Postgres:
//
//   1. READ → HOST → PORT. The browser's `fetch` is answered by the REAL route,
//      so the overlay's real client parses the route's real body and the real
//      `DevelopmentSectionBody` renders it. A route that returns a field and a
//      component that reads one do not imply they are the same field; this asks.
//   2. KIND TOTALITY ACROSS BOTH ENDS, enumerated FROM the constant: for every
//      member of `ApprovalGateKind` the route's answer and the host's drawn arm
//      agree. A kind added with an arm on only one end fails here.
//   3. ONE RECONCILE. A decision pressed in the overlay settles the row in the
//      tab underneath and drops the strip's count, in ONE page state.
//
// The sibling file `approval-overlay-story-gate.test.tsx` is MOTIR-5226's, for
// the design-result arm; this one adds only what the pull-request arm brings.
// The stubs are the same ones a Vitest process cannot supply for real, plus the
// design PORT, which has its own suite.

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

/** The address bar, as the design story's gate models it. */
const nav = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let params = new URLSearchParams();
  return {
    pushes: [] as string[],
    get params() {
      return params;
    },
    go(href: string) {
      params = new URL(href, 'http://localhost:3000').searchParams;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});
const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useRouter: () => ({ push, refresh }),
    usePathname: () => '/workbench',
    useSearchParams: () => useSyncExternalStore(nav.subscribe, () => nav.params),
  };
});
vi.mock('@/lib/navigation/shallowUrl', () => ({
  shallowPush: (href: string) => {
    nav.pushes.push(href);
    nav.go(href);
  },
  shallowReplace: vi.fn(),
}));
vi.mock('@/app/(authed)/items/[key]/_components/DesignResultPanel', () => ({
  DesignResultPanel: ({ evidence }: { evidence: { id: string } | null }) => (
    <div data-testid="design-port" data-evidence={evidence?.id ?? ''} />
  ),
}));

const { GET: gateRoute } = await import('@/app/api/work-items/approval-gate/route');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { homeService } = await import('@/lib/services/homeService');
const { approvalGateRepository } = await import('@/lib/repositories/approvalGateRepository');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { ApprovalOverlay } = await import('@/components/approvals/ApprovalOverlay');
const { ApprovalsList } = await import('@/app/(authed)/workbench/_components/ApprovalsList');

/** The empty state a tab's list draws when it holds nothing (MOTIR-5245). */
const EMPTY = <p>Nothing is waiting</p>;

const SLOW = { timeout: 15_000 };
const HEAD_WEB = '9840d00ea1b2c3d4e5f60718293a4b5c6d7e8f90';
const HEAD_API = '1111111111111111111111111111111111111111';
const BODY = ['## Locally', '', '```bash', 'pnpm dev', '```'].join('\n');

let fx: WorkItemFixture;
let repoSeq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  session.current = null;
  activeCtx.current = null;
  nav.pushes.length = 0;
  nav.go('/workbench');
  push.mockReset();
  refresh.mockReset();
  // The browser's `fetch`, answered by the REAL route — never a canned body.
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost:3000');
    if (url.pathname !== '/api/work-items/approval-gate') throw new Error(`unexpected ${url}`);
    return gateRoute(new Request(url));
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

type Actor = { id: string; email: string };
const owner = (): Actor => ({ id: fx.owner.id, email: fx.owner.email });

function signIn(actor: Actor, on: WorkItemFixture = fx) {
  session.current = { user: { id: actor.id, email: actor.email, name: 'Ada Lovelace' } };
  activeCtx.current = {
    userId: actor.id,
    workspaceId: on.workspaceId,
    projectId: on.projectId,
    project: on.project,
  } as ProjectContext;
}

function actorCtx(on: WorkItemFixture = fx): HomeActorContext {
  return { ...on.ctx, projectId: on.projectId };
}

/** A repository with one green pull request, DELIVERED by `item`. */
async function deliver(item: { id: string }, opts: { name: string; number: number; head: string }) {
  repoSeq += 1;
  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: fx.workspaceId,
      installationId: `inst-5441-${repoSeq}`,
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
      repoId: `repo-5441-${repoSeq}`,
      owner: 'acme',
      name: opts.name,
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  const pr = await adminDb.githubPullRequest.create({
    data: {
      repoId: repo.id,
      number: opts.number,
      title: `Change in ${opts.name}`,
      state: 'open',
      merged: false,
      headRef: 'parent/ACME-12-throttle',
      baseRef: 'main',
      provider: 'github',
    },
  });
  await adminDb.githubCheckRun.create({
    data: {
      pullRequestId: pr.id,
      commitSha: opts.head,
      checkName: 'Vitest',
      conclusion: 'success',
    },
  });
  await adminDb.workItemDelivery.create({
    data: {
      workspaceId: fx.workspaceId,
      workItemId: item.id,
      githubPullRequestId: pr.id,
      repoId: repo.id,
    },
  });
  return pr;
}

/** A story in review, delivered by TWO repositories, with How to test written. */
async function twoRepoStory(opts: { howToTest?: boolean } = {}): Promise<WorkItem> {
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Throttle the public API' },
    fx.ctx,
  );
  await workItemsService.updateStatus(story.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(story.id, 'in_review', fx.ctx);
  await deliver(story, { name: 'web', number: 7, head: HEAD_WEB });
  await deliver(story, { name: 'api', number: 12, head: HEAD_API });
  if (opts.howToTest !== false) {
    await adminDb.testInstructions.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: story.id,
        bodyMd: BODY,
      },
    });
  }
  return adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } });
}

/** A gate row of `kind` on `card`, written directly — the shapes no shipped path
 *  creates in this process (the raise has its own suite, MOTIR-5482). */
async function rawGate(card: WorkItem, kind: string, subjectId: string, subjectVersion?: string) {
  return withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: card.id,
        kind: kind as 'design_result',
        subjectId,
        ...(subjectVersion ? { subjectVersion } : {}),
      },
      tx,
    ),
  );
}

const setVersion = `acme/web#7@${HEAD_WEB},acme/api#12@${HEAD_API}`;

describe('SEAM 1 · the route’s real answer reaches the Development block', () => {
  it('ONE frame over BOTH pull requests, with How to test inside the port and the kind’s verbs', async () => {
    const story = await twoRepoStory();
    await rawGate(story, 'pull_request_approval', story.id, setVersion);
    signIn(owner());

    nav.go(
      `/workbench?tab=approvals&approval=${story.identifier}&approvalKind=pull_request_approval`,
    );
    renderWithIntl(<ApprovalOverlay />);

    const dialog = await screen.findByRole(
      'dialog',
      { name: `Pull requests for ${story.identifier}` },
      SLOW,
    );
    const ports = within(dialog).getAllByRole('group', { name: en.approvalGate.port.label });
    // ONE frame over the whole delivery set — never one per pull request.
    expect(ports).toHaveLength(1);
    const port = ports[0]!;

    // Both rows: the titles travelled repository → route → JSON → client → block.
    expect(within(port).getByText('Change in web')).toBeTruthy();
    expect(within(port).getByText('Change in api')).toBeTruthy();
    // How to test, from the record this story wrote — inside the SAME port.
    const howToTest = within(port).getByRole('group', {
      name: en.github.development.howToTest.title,
    });
    expect(within(howToTest).getByText('pnpm dev')).toBeTruthy();
    // …and it carries NO verb of its own (§ 24: it is evidence, never a gate).
    expect(
      within(howToTest).queryByRole('button', { name: /approve|merge|request changes/i }),
    ).toBeNull();
    // The gate's verbs, once, from the shared frame.
    expect(
      within(dialog).getAllByRole('button', {
        name: en.approvalGate.pullRequestApproval.verb.approveAndMerge,
      }),
    ).toHaveLength(1);
    expect(within(dialog).queryByTestId('design-port')).toBeNull();
  });

  it('an item with NO How-to-test record draws the block’s missing state, and the verbs stay', async () => {
    const story = await twoRepoStory({ howToTest: false });
    await rawGate(story, 'pull_request_approval', story.id, setVersion);
    signIn(owner());

    nav.go(`/workbench?approval=${story.identifier}&approvalKind=pull_request_approval`);
    renderWithIntl(<ApprovalOverlay />);

    const dialog = await screen.findByRole(
      'dialog',
      { name: `Pull requests for ${story.identifier}` },
      SLOW,
    );
    const port = within(dialog).getByRole('group', { name: en.approvalGate.port.label });
    expect(within(port).getByText(en.github.development.howToTest.missing.title)).toBeTruthy();
    expect(
      within(dialog).getByRole('button', {
        name: en.approvalGate.pullRequestApproval.verb.approveAndMerge,
      }),
    ).toBeTruthy();
  });
});

describe('GUARD · TOTAL over `ApprovalGateKind`, at BOTH ends, enumerated FROM the constant', () => {
  // The registry moves a kind out of `UNREGISTERED_GATE_KINDS` when it registers,
  // so this table changes by itself and a kind added with an arm on only ONE end
  // fails here rather than drawing an empty port for somebody.
  expect(APPROVAL_GATE_KINDS.length).toBeGreaterThan(UNREGISTERED_GATE_KINDS.length);

  for (const kind of APPROVAL_GATE_KINDS) {
    const expected =
      kind === 'design_result'
        ? 'design port'
        : kind === 'acceptance_result'
          ? 'acceptance port'
          : kind === 'pull_request_approval'
            ? 'the Development block'
            : 'not built yet';

    it(`${kind}: the route's answer and the overlay's arm agree — ${expected}`, async () => {
      const story = await twoRepoStory();
      // Every kind gets the SAME card and the same delivery set, so the only
      // thing that differs between these cases is the kind itself.
      await rawGate(story, kind, kind === 'design_result' ? 'ev-gone' : story.id, setVersion);
      signIn(owner());

      nav.go(`/workbench?approval=${story.identifier}&approvalKind=${kind}`);
      renderWithIntl(<ApprovalOverlay />);
      // ⚠️ THE AUTHORITATIVE WAIT IS THE SETTLED NAME. While the read is in
      // flight the dialog is already mounted and named *Loading the approval*, so
      // a name-agnostic query resolves against the loading state and every
      // assertion below races it. The kind's own label is set only once the read
      // has answered — and it is the frame's label for the approve-to-merge kind.
      const dialog = await screen.findByRole(
        'dialog',
        {
          name: `${
            kind === 'pull_request_approval'
              ? en.approvalGate.pullRequestApproval.kindLabel
              : en.workbench.approvals.kind[kind]
          } for ${story.identifier}`,
        },
        SLOW,
      );

      if (kind === 'pull_request_approval') {
        const port = within(dialog).getByRole('group', { name: en.approvalGate.port.label });
        expect(within(port).getByText('Change in web')).toBeTruthy();
      } else if (kind === 'design_result' || kind === 'acceptance_result') {
        // A design gate whose evidence row is gone: the route answers `gone`, and
        // the overlay draws that arm — NOT the block, and not the not-built one.
        // MOTIR-4950 / MOTIR-5790: an acceptance gate whose receipt does not resolve
        // (here its subject is the story's own id) takes the same arm — it is a
        // REGISTERED kind with a real port, so *not built yet* would be false.
        expect(within(dialog).getByText(en.workbench.approvals.subjectGone)).toBeTruthy();
        expect(
          within(dialog).queryByRole('group', { name: en.approvalGate.port.label }),
        ).toBeNull();
      } else {
        expect(within(dialog).getByText(en.workbench.approvals.notRenderable)).toBeTruthy();
        expect(
          within(dialog).queryByRole('group', { name: en.approvalGate.port.label }),
        ).toBeNull();
      }
    });
  }
});

describe('SEAM 2 · a decision made in the overlay, seen from the tab', () => {
  it('the row SETTLES and the strip’s count drops — read in ONE page state', async () => {
    const story = await twoRepoStory();
    await rawGate(story, 'pull_request_approval', story.id, setVersion);
    signIn(owner());
    const queue = await approvalGatesService.listAwaitingMe(actorCtx(), { page: 1 });
    expect(queue.items).toHaveLength(1);
    expect((await homeService.tabCounts(actorCtx())).approvals).toBe(1);
    const gateId = queue.items[0]!.gateId;

    nav.go('/workbench?tab=approvals');
    renderWithIntl(
      <>
        <ApprovalsList
          rows={queue.items}
          label="To approve"
          pagination={{ total: queue.total, page: queue.page, pageSize: queue.pageSize }}
          empty={EMPTY}
        />
        <ApprovalOverlay />
      </>,
    );

    // THE ROW'S DOOR — this story's own change: the pull-request row opens the
    // overlay rather than sending the reader to the card (§ 24).
    fireEvent.click(screen.getByRole('link', { name: new RegExp(`^Review ${story.identifier} `) }));
    expect(nav.pushes).toEqual([
      `/workbench?tab=approvals&approval=${story.identifier}&approvalKind=pull_request_approval`,
    ]);
    const dialog = await screen.findByRole(
      'dialog',
      { name: `Pull requests for ${story.identifier}` },
      SLOW,
    );

    // REQUEST CHANGES — the decision that records and merges nothing, so this
    // seam asserts the reconcile without driving MOTIR-4882's merge path.
    fireEvent.click(
      within(dialog).getByRole('button', { name: en.approvalGate.verb.requestChanges }),
    );
    await within(dialog).findAllByText(en.approvalGate.state.changesRequested, {}, SLOW);

    // ⚠️ ONE PAGE STATE: nothing re-rendered the list from the server (the refresh
    // is a mock), so a settled row here can only be the island hearing the overlay.
    const row = screen.getByTestId(`approval-row-${gateId}`);
    expect(within(row).getByText(en.approvalGate.state.changesRequested)).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Review', hidden: true })).toBeNull();
    expect((await homeService.tabCounts(actorCtx())).approvals).toBe(0);
    expect(refresh).toHaveBeenCalled();
    expect((await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gateId } })).state).toBe(
      'changes_requested',
    );
  });
});

describe('SEAM 3 · the port is SCOPED — the actor’s view and the population differ', () => {
  it('an outsider’s address opens on NOT AVAILABLE; the same address resolves for its reader', async () => {
    const story = await twoRepoStory();
    await rawGate(story, 'pull_request_approval', story.id, setVersion);
    const address = `/workbench?approval=${story.identifier}&approvalKind=pull_request_approval`;

    // The TRUE population holds one awaiting gate over two pull requests…
    expect(await adminDb.approvalGate.count({ where: { state: 'awaiting' } })).toBe(1);
    expect(await adminDb.workItemDelivery.count({ where: { workItemId: story.id } })).toBe(2);

    // …and the outsider's view of it is empty.
    const elsewhere = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });
    signIn({ id: elsewhere.owner.id, email: elsewhere.owner.email }, elsewhere);
    nav.go(address);
    renderWithIntl(<ApprovalOverlay />);
    const refused = await screen.findByRole(
      'dialog',
      { name: en.approvalOverlay.notAvailable.title },
      SLOW,
    );
    expect(within(refused).queryByText('Change in web')).toBeNull();
    cleanup();

    // POSITIVE CONTROL — without it the refusal above could be a broken seam.
    signIn(owner());
    nav.go(address);
    renderWithIntl(<ApprovalOverlay />);
    const dialog = await screen.findByRole(
      'dialog',
      { name: `Pull requests for ${story.identifier}` },
      SLOW,
    );
    expect(within(dialog).getByText('Change in web')).toBeTruthy();
  });
});

describe('SEAM 5 · an EJECTED member reads the same in the overlay (MOTIR-5635)', () => {
  it('the decided frame shows Left the queue, the reason and the failing check', async () => {
    const story = await twoRepoStory();
    const gate = await rawGate(story, 'pull_request_approval', story.id, setVersion);
    await adminDb.approvalGate.update({
      where: { id: gate.id },
      data: {
        state: 'approved',
        decidedById: fx.owner.id,
        decidedByLabel: 'Owner',
        decidedAt: new Date(),
      },
    });
    const api = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 12 } });
    await adminDb.githubPullRequestQueueExit.create({
      data: {
        pullRequestId: api.id,
        deliveryId: 'guid-5635',
        rawReason: 'CI_FAILURE',
        disposition: 'failure',
        headSha: HEAD_API,
        exitedAt: new Date(),
        failingCheckName: 'CI complete',
        failingCheckUrl: 'https://github.com/acme/api/actions/runs/1/job/2',
      },
    });
    signIn(owner());

    nav.go(
      `/workbench?tab=approvals&approval=${story.identifier}&approvalKind=pull_request_approval`,
    );
    renderWithIntl(<ApprovalOverlay />);

    const pra = en.approvalGate.pullRequestApproval;
    const dialog = await screen.findByRole(
      'dialog',
      { name: `Pull requests for ${story.identifier}` },
      SLOW,
    );
    const row = within(dialog).getByText('Change in api').closest('li')!;
    expect(within(row).getByText(pra.outcome.leftQueue)).toBeTruthy();
    // The overlay draws a DECIDED gate with nothing to press, as it does Retry merge — the
    // press lives on the item page (an ejected card is not in To approve, § 22).
    expect(within(row).queryByRole('button', { name: pra.outcome.queueAgain })).toBeNull();
    expect(within(dialog).getByText(new RegExp(pra.exit.reason.CI_FAILURE))).toBeTruthy();
    expect(
      within(dialog)
        .getByRole('link', { name: pra.exit.openCheck.replace('{check}', 'CI complete') })
        .getAttribute('href'),
    ).toBe('https://github.com/acme/api/actions/runs/1/job/2');
    // The sibling was never removed.
    const web = within(dialog).getByText('Change in web').closest('li')!;
    expect(within(web).queryByText(pra.outcome.leftQueue)).toBeNull();
  });
});
