import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAccessDTO } from '@/lib/dto/aiAccess';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';
import { makeWorkItemFixture } from './fixtures/workItemFixtures';

// MOTIR-4925 · MOTIR-5168 — BOTH publish gates resolve the switch for the STORY'S
// OWN project.
//
// The acceptance-video switch is a project setting now, and there are two doors a
// receipt can arrive through: the CI publish route (`authorizeAcceptancePublish`,
// a bearer PAT or a verified Actions token) and the MCP tool
// (`runCreateAcceptanceUpload`, an agent's token). Both ask the one eligibility
// service, and both used to ask it about the ORGANISATION — so a credential
// authorised for the workspace could publish into any project under it on one
// answer.
//
// ⚠️ EVERY CASE HERE IS A PAIR, AND THAT IS THE ONLY SHAPE THAT PROVES ANYTHING.
// One project cannot distinguish a per-project read from a per-organisation one:
// both return the same boolean. So each test drives ONE credential against TWO
// stories in TWO projects of the SAME organisation whose switches disagree, and
// asserts the refusal lands on exactly one of them. The organisation's own column
// is left ON throughout, so a verdict cannot be right by accident.
//
// `billingService` is mocked at the `getAiAccessForContext` seam only — the gate is
// `hasPaidAiPlan AND the switch`, and with no paid plan every case would refuse
// `no_plan` and the switch would never be consulted. Its own suites cover the plan
// resolution.

const aiAccess = vi.hoisted(() => ({ current: null as AiAccessDTO | null }));

vi.mock('@/lib/services/billingService', () => ({
  billingService: {
    getAiAccessForContext: vi.fn(async () => aiAccess.current),
  },
}));

const { authorizeAcceptancePublish } = await import('@/lib/acceptanceEvidence/publishAuth');
const { runCreateAcceptanceUpload } = await import('@/lib/mcp/tools/publishAcceptanceResult');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { apiTokensService } = await import('@/lib/services/apiTokensService');
const { projectsService } = await import('@/lib/services/projectsService');

let fx: Awaited<ReturnType<typeof makeWorkItemFixture>>;
let orgId: string;
let seq = 0;

function access(partial: Partial<AiAccessDTO>): AiAccessDTO {
  return {
    applicable: true,
    organizationId: null,
    organizationName: 'Acme',
    canManageBilling: false,
    hasPaidAiPlan: false,
    balance: 0,
    tierName: null,
    tierAllotment: null,
    renewsAt: null,
    ...partial,
  };
}

/**
 * A second project in the fixture's own workspace, with its gate switch set.
 *
 * ⚠️ THROUGH `projectsService.createProject`, NEVER a bare `project.create`. A
 * project is not just a row: `createProject` also seeds its DEFAULT WORKFLOW in
 * the same transaction, and `workItemsService.createWorkItem` reads that
 * workflow for the item's initial status. A hand-inserted row therefore looks
 * complete right up until `storyIn` below, which fails with
 * `NoInitialStatusError: … has no initial workflow status (corrupt seed)` —
 * a message that reads like a broken fixture file and is actually a project
 * created past the service that makes one usable.
 *
 * The switch is set afterwards because the column is NOT a create-time input:
 * it carries `@default(true)` and its only writers are the migration's backfill
 * and `approvalGateSettingsService`. Writing it here with `adminDb` is the
 * fixture doing what an admin would later do through the settings room.
 */
async function projectWithSwitch(enabled: boolean) {
  const n = seq++;
  const project = await projectsService.createProject({
    workspaceId: fx.workspaceId,
    actorUserId: fx.ownerId,
    name: `Gate P${n}`,
  });
  return adminDb.project.update({
    where: { id: project.id },
    data: { acceptanceVideoEnabled: enabled },
  });
}

/** A story in `projectId`, addressed by the key both gates take. */
async function storyIn(projectId: string, title: string) {
  const item = await workItemsService.createWorkItem({ projectId, kind: 'story', title }, fx.ctx);
  return item.identifier;
}

/** The CI publisher's request: the bearer-PAT arm, which is the one a run uses. */
async function ciRequest(): Promise<Request> {
  const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label: `gate-pair-${seq++}`,
    // `ACCEPTANCE_PUBLISH_PERMISSION` is `work_item:edit` (`lib/tokens/grant.ts`).
    // Granted WORKSPACE-wide with no project named, deliberately: that is exactly
    // the credential the card is about — one CI token, every project under it, and
    // until this change one answer for all of them.
    fixedGrant: ['work_item:edit'],
  });
  return new Request('https://motir.test/api/v1/acceptance', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeEach(async () => {
  seq = 0;
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "acceptance_evidence", "attachment", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  const ws = await adminDb.workspace.findUniqueOrThrow({ where: { id: fx.workspaceId } });
  orgId = ws.organizationId;
  aiAccess.current = access({ organizationId: orgId, hasPaidAiPlan: true });
});

/** The organisation's own switch, asserted ON so no verdict can come from it. */
async function assertOrgSwitchStillOn() {
  const org = await adminDb.organization.findUniqueOrThrow({ where: { id: orgId } });
  expect(
    org.acceptanceVideoEnabled,
    'the fixture leaves the ORGANISATION switch ON: a gate reading it would admit both stories',
  ).toBe(true);
}

describe('the CI publish gate refuses on the STORY’S OWN project', () => {
  it('one credential, two projects: the OFF project refuses and the ON project passes', async () => {
    const off = await projectWithSwitch(false);
    const on = await projectWithSwitch(true);
    const offStory = await storyIn(off.id, 'Receipt in the quiet project');
    const onStory = await storyIn(on.id, 'Receipt in the gated project');
    await assertOrgSwitchStillOn();

    const refused = await authorizeAcceptancePublish(await ciRequest(), offStory);
    expect(refused, 'a story in a switched-off project must be refused').toBeInstanceOf(Response);
    const res = refused as Response;
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      code: 'ACCEPTANCE_VIDEO_INELIGIBLE',
      reason: 'toggle_off',
    });

    const admitted = await authorizeAcceptancePublish(await ciRequest(), onStory);
    expect(
      admitted,
      'the SAME credential must still publish into a project whose switch is on',
    ).not.toBeInstanceOf(Response);
    expect((admitted as { story: { identifier: string } }).story.identifier).toBe(onStory);
  });

  it('no paid plan refuses 402 in BOTH projects — the entitlement is still the organisation’s', async () => {
    aiAccess.current = access({ organizationId: orgId, hasPaidAiPlan: false });
    const off = await projectWithSwitch(false);
    const on = await projectWithSwitch(true);

    for (const [project, label] of [
      [off, 'switch off'],
      [on, 'switch on'],
    ] as const) {
      const story = await storyIn(project.id, `Plan gate ${label}`);
      const result = await authorizeAcceptancePublish(await ciRequest(), story);
      expect(result, `${label}: no plan must refuse`).toBeInstanceOf(Response);
      const res = result as Response;
      expect(res.status, `${label}: no plan is 402, not 403`).toBe(402);
      await expect(res.json()).resolves.toMatchObject({ reason: 'no_plan' });
    }
  });
});

describe('the MCP publish gate refuses on the STORY’S OWN project', () => {
  it('one token, two projects: the OFF project refuses and the ON project mints a grant', async () => {
    const off = await projectWithSwitch(false);
    const on = await projectWithSwitch(true);
    const offStory = await storyIn(off.id, 'MCP receipt, quiet project');
    const onStory = await storyIn(on.id, 'MCP receipt, gated project');
    await assertOrgSwitchStillOn();

    const refused = await runCreateAcceptanceUpload({ key: offStory }, fx.ctx);
    expect(refused.isError, JSON.stringify(refused)).toBe(true);
    const text = JSON.stringify(refused);
    expect(text).toContain('ACCEPTANCE_VIDEO_INELIGIBLE');
    expect(text).toContain('toggle_off');

    const granted = await runCreateAcceptanceUpload({ key: onStory }, fx.ctx);
    expect(
      granted.isError,
      `the SAME token must still publish into a switched-on project: ${JSON.stringify(granted)}`,
    ).toBeFalsy();
  });

  it('the refusal names the PROJECT, not the workspace — the tier it now answers for', async () => {
    // The sentence is not an i18n key, so nothing else in the suite would catch it
    // drifting. It matters because this message is what a run or a CI job reads:
    // after the move, "this workspace may not publish" names the wrong tier and
    // sends whoever reads it to the wrong settings page.
    const off = await projectWithSwitch(false);
    const story = await storyIn(off.id, 'A story whose project said no');

    const refused = await runCreateAcceptanceUpload({ key: story }, fx.ctx);
    const text = JSON.stringify(refused);
    expect(text).toContain('This project may not publish an acceptance video');
    expect(text, 'the old wording named the workspace').not.toContain('This workspace may not');
    // The second sentence stays true and stays: nothing is lost by refusing here.
    expect(text).toContain('still in the run');
  });
});
