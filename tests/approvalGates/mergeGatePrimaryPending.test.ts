import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shaFor } from '../helpers/commitShaFixtures';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';
import { makeWorkWaitOn } from '@/tests/helpers/designWaits';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';

// THE MERGE GATE'S OWN APPROVE FOLLOWS THE DESIGN (Bug MOTIR-5785; `design-result.md`
// AMENDMENT 6 Q1), against a REAL Postgres through the real webhook and publish doors.
//
// ⚠️ THE DOOR THAT WAS LEFT. MOTIR-5712 hid a design card's merge row from To approve and
// MOTIR-5762 held the `auto` arm and the GitHub review sync — but the approve-to-merge gate
// is still a real gate, and anything naming its id (the REST decide route, `decideGate`,
// the merge row pressed alone) approved it and went on to merge over an undecided design.
// The refusal now lives on the gate's own `approve`, so every door means the same thing.

vi.mock('@/lib/github/appAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/github/appAuth')>()),
  mintInstallationToken: vi.fn(async () => ({
    token: 'ghs_test',
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
}));

const signedIn = { current: null as { userId: string; workspaceId: string } | null };
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => signedIn.current,
}));

vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));

const store = new Map<string, { contentType: string; size: number }>();
vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(),
  signedDownloadUrl: vi.fn(),
  deleteAttachmentBlob: vi.fn(),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));

const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { githubWebhookService } = await import('@/lib/services/githubWebhookService');
const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { pullRequestMergeService } = await import('@/lib/services/pullRequestMergeService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { ApprovalGatePrimaryPendingError } = await import('@/lib/approvalGates/errors');
const { APPROVAL_GATE_STATUS } = await import('@/lib/approvalGates/httpStatus');
const { toGateRefusal } = await import('@/lib/approvalGates/refusals');
const { POST: decideRoute } = await import('@/app/api/approval-gates/[id]/decide/route');

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-primary-pending';
const REPO_PROVIDER_ID = '883';
const INSTALLATION = { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } };

type Scenario = Awaited<ReturnType<typeof makeScenario>>;

async function makeScenario(email: string) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: 'ACME',
  });
  await adminDb.project.update({ where: { id: project.id }, data: { prMergeMode: 'manual' } });
  const ctx = { userId: user.id, workspaceId: workspace.id };
  signedIn.current = ctx;
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: REPO_PROVIDER_ID,
        owner: 'moooon',
        name: 'acme',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  return { user, workspace, project, ctx };
}

const green = (headSha: string, number: number) =>
  githubWebhookService.handleEvent('check_suite', {
    action: 'completed',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_suite: {
      head_sha: headSha,
      head_branch: null,
      status: 'completed',
      conclusion: 'success',
      app: { slug: 'github-actions' },
      pull_requests: [{ number }],
    },
  });

async function openLinked(identifier: string, number: number) {
  const headRef = `design/${identifier}-${number}`;
  await linkPrByIdentifier({ identifier, owner: 'moooon', name: 'acme', number, headRef });
  await githubWebhookService.handleEvent('pull_request', {
    action: 'opened',
    installation: INSTALLATION,
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      title: `A design (${headRef})`,
      head: { ref: headRef },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  });
}

/** A card with an open delivering pull request, mid-run, that a later card waits on. */
async function card(s: Scenario, number: number) {
  const item = await workItemsService.createWorkItem(
    { projectId: s.project.id, kind: 'task', title: `Draw the frame ${number}` },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  await makeWorkWaitOn(item.id, { projectId: s.project.id, ctx: s.ctx });
  await openLinked(item.identifier, number);
  return item;
}

async function publish(s: Scenario, itemId: string, label: string) {
  const prefix = designPrefix(s.workspace.id, itemId);
  store.set(`${prefix}${label}.mock.html`, { contentType: 'text/html', size: 2048 });
  store.set(`${prefix}${label}.design-notes.md`, { contentType: 'text/markdown', size: 512 });
  return designEvidenceService.recordFromPathnames(
    {
      workItemId: itemId,
      assets: [
        {
          kind: 'mock',
          sourcePath: `design/work-items/${label}.mock.html`,
          pathname: `${prefix}${label}.mock.html`,
        },
        {
          kind: 'note_file',
          sourcePath: 'design/work-items/design-notes.md',
          pathname: `${prefix}${label}.design-notes.md`,
        },
      ],
      commitSha: shaFor(label),
    },
    s.ctx,
  );
}

const awaiting = async (workItemId: string, kind: 'design_result' | 'pull_request_approval') =>
  adminDb.approvalGate.findFirst({ where: { workItemId, kind, state: 'awaiting' } });

const stateOf = async (gateId: string) =>
  (await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gateId } })).state;

/** The merge gate approved by its id, through the service's decide entry point. */
const approveMergeGate = (s: Scenario, gateId: string) =>
  pullRequestMergeService.decideGate(
    {
      gateId,
      decision: 'approve',
      source: 'ui',
      noteMd: null,
      stamp: DECIDED_WITHOUT_A_READER,
    },
    s.ctx,
  );

/** The design decided on its OWN, through the plain door — never the one press. */
const decideDesign = (s: Scenario, gateId: string, decision: 'approve' | 'request_changes') =>
  approvalGatesService.decide(
    {
      gateId,
      decision,
      source: 'ui',
      noteMd: decision === 'request_changes' ? 'Needs changes.' : null,
      refusalVerdict: decision === 'request_changes' ? 'revise' : null,
      stamp: DECIDED_WITHOUT_A_READER,
    },
    s.ctx,
  );

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  store.clear();
  signedIn.current = null;
  await truncateAuthTables();
  _resetInstallationTokenCache();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  // Any merge reaches the host through `fetch`; a refused approve never gets that far.
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no host in this spec'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('MOTIR-5785 — the merge gate cannot be approved over an unanswered design', () => {
  it('REFUSES approving the merge gate by its id while the design AWAITS, and merges nothing', async () => {
    const s = await makeScenario('pp-awaiting@example.com');
    const item = await card(s, 71);
    await publish(s, item.id, 'v1');
    await green('sha-a', 71);
    const design = (await awaiting(item.id, 'design_result'))!;
    const merge = (await awaiting(item.id, 'pull_request_approval'))!;
    expect(design).toBeTruthy();
    expect(merge).toBeTruthy();

    fetchSpy.mockClear();
    const refused = await approveMergeGate(s, merge.id).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ApprovalGatePrimaryPendingError);
    expect(refused).toMatchObject({ workItemId: item.id, primary: 'design' });

    // Nothing was written, and nothing reached the host.
    expect(await stateOf(merge.id)).toBe('awaiting');
    expect(await stateOf(design.id)).toBe('awaiting');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does NOT refuse Request changes on the merge gate', async () => {
    const s = await makeScenario('pp-changes@example.com');
    const item = await card(s, 72);
    await publish(s, item.id, 'v1');
    await green('sha-a', 72);
    const merge = (await awaiting(item.id, 'pull_request_approval'))!;

    const decided = await pullRequestMergeService.decideGate(
      {
        gateId: merge.id,
        decision: 'request_changes',
        source: 'ui',
        noteMd: 'Not these commits.',
        stamp: DECIDED_WITHOUT_A_READER,
      },
      s.ctx,
    );

    expect(decided.gate.state).toBe('changes_requested');
  });

  it('a design sent back (CHANGES_REQUESTED) still refuses the merge gate’s approve', async () => {
    const s = await makeScenario('pp-sentback@example.com');
    const item = await card(s, 73);
    await publish(s, item.id, 'v1');
    await decideDesign(s, (await awaiting(item.id, 'design_result'))!.id, 'request_changes');
    await green('sha-a', 73);
    const merge = (await awaiting(item.id, 'pull_request_approval'))!;
    expect(merge).toBeTruthy();

    await expect(approveMergeGate(s, merge.id)).rejects.toBeInstanceOf(
      ApprovalGatePrimaryPendingError,
    );
    expect(await stateOf(merge.id)).toBe('awaiting');
  });

  it('an approval of a SUPERSEDED result still refuses the merge gate’s approve', async () => {
    const s = await makeScenario('pp-superseded@example.com');
    const item = await card(s, 74);
    await publish(s, item.id, 'v1');
    await decideDesign(s, (await awaiting(item.id, 'design_result'))!.id, 'approve');
    // A NEW current result the approval does not name — written directly, as MOTIR-5762's
    // spec does: the publish door refuses it on an approved design, and the state is what
    // the rule guards (a card reopened by hand and republished), not a path of its own.
    const v1 = await adminDb.designEvidence.findFirstOrThrow({
      where: { workItemId: item.id, isCurrent: true },
    });
    await adminDb.designEvidence.update({ where: { id: v1.id }, data: { isCurrent: false } });
    await adminDb.designEvidence.create({
      data: {
        workspaceId: s.workspace.id,
        workItemId: item.id,
        commitSha: shaFor('v2'),
        isCurrent: true,
      },
    });
    await green('sha-a', 74);
    const merge = (await awaiting(item.id, 'pull_request_approval'))!;
    expect(merge).toBeTruthy();

    await expect(approveMergeGate(s, merge.id)).rejects.toBeInstanceOf(
      ApprovalGatePrimaryPendingError,
    );
    expect(await stateOf(merge.id)).toBe('awaiting');
  });

  it('once the design is approved over the CURRENT result, the merge gate approves', async () => {
    const s = await makeScenario('pp-approved@example.com');
    const item = await card(s, 75);
    await publish(s, item.id, 'v1');
    await green('sha-a', 75);
    const merge = (await awaiting(item.id, 'pull_request_approval'))!;
    await decideDesign(s, (await awaiting(item.id, 'design_result'))!.id, 'approve');

    // The door alone — the merge that follows is the press's business, not this rule's.
    const decided = await approvalGatesService.decide(
      {
        gateId: merge.id,
        decision: 'approve',
        source: 'ui',
        noteMd: null,
        stamp: DECIDED_WITHOUT_A_READER,
      },
      s.ctx,
    );
    expect(decided.gate.state).toBe('approved');
  });

  it('leaves a card with NO design result alone', async () => {
    const s = await makeScenario('pp-nodesign@example.com');
    const item = await card(s, 76);
    await green('sha-a', 76);
    expect(await awaiting(item.id, 'design_result')).toBeNull();
    const merge = (await awaiting(item.id, 'pull_request_approval'))!;

    const decided = await approvalGatesService.decide(
      {
        gateId: merge.id,
        decision: 'approve',
        source: 'ui',
        noteMd: null,
        stamp: DECIDED_WITHOUT_A_READER,
      },
      s.ctx,
    );
    expect(decided.gate.state).toBe('approved');
  });

  it('answers the REST caller with a NAMED 409 — never a 500 — naming the design', async () => {
    const s = await makeScenario('pp-rest@example.com');
    const item = await card(s, 77);
    await publish(s, item.id, 'v1');
    await green('sha-a', 77);
    const merge = (await awaiting(item.id, 'pull_request_approval'))!;
    const { stamp } = await approvalGatesService.getForWorkItem(
      { workItemId: item.id, kind: 'pull_request_approval' },
      s.ctx,
    );

    fetchSpy.mockClear();
    const res = await decideRoute(
      new Request(`http://localhost/api/approval-gates/${merge.id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'approve', stamp }),
      }),
      { params: Promise.resolve({ id: merge.id }) },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'APPROVAL_GATE_PRIMARY_PENDING',
      primary: 'design',
    });
    expect(await stateOf(merge.id)).toBe('awaiting');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('MOTIR-5785 — ONE primary-pending refusal, in the frame’s vocabulary', () => {
  it('maps to 409 and carries which primary holds the merge', () => {
    expect(APPROVAL_GATE_STATUS.APPROVAL_GATE_PRIMARY_PENDING).toBe(409);
    expect(toGateRefusal('APPROVAL_GATE_PRIMARY_PENDING', { primary: 'decision' })).toEqual({
      tag: 'APPROVAL_GATE_PRIMARY_PENDING',
      primary: 'decision',
    });
    // A caller that could not say reads the only primary `main` has.
    expect(toGateRefusal('APPROVAL_GATE_PRIMARY_PENDING')).toEqual({
      tag: 'APPROVAL_GATE_PRIMARY_PENDING',
      primary: 'design',
    });
  });
});
