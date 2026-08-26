import { test, expect } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  agentSession,
  seedAgentAuthoredPlan,
  AGENT_HARNESS,
  AGENT_MODEL,
  AGENT_PLAN_SEED_PASSWORD,
} from './_helpers/agent-authored-plan-seed';
import {
  ADD_PLAN_ITEMS_TOOL_NAME,
  CREATE_PLAN_TOOL_NAME,
  UPDATE_PLAN_PROPOSAL_TOOL_NAME,
  WITHDRAW_PLAN_PROPOSAL_TOOL_NAME,
} from '@/lib/mcp/tools/authorPlan';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Story MOTIR-3533 · Subtask MOTIR-3543 — the reviewer's side of a plan being
// CORRECTED under them.
//
// ⚠️ THIS SPEC RECORDS NO ACCEPTANCE VIDEO, AND THE OMISSION IS A DECISION.
// The acceptance-video rule fires when a story's deliverable has a
// user-observable surface a person watches. This story ships no surface: its
// deliverable is two MCP tools and a service, and its diff touches no file under
// `components/`. The thing a reviewer would WATCH — a plan's timeline gaining a
// row — is the SIBLING story's surface and already carries the sibling story's
// receipt. A second clip of the same panel would produce two receipts for one
// surface and invite a reviewer to accept this story on evidence belonging to
// the other.
//
// So this is a REGRESSION spec: it declares no `acceptanceStory`, it takes the
// plain `@playwright/test` fixtures rather than the acceptance-video ones, and
// its filename is deliberately NOT `acceptance-*` — that prefix IS the lane
// (`playwright.acceptance.config.ts` matches `**/acceptance*.spec.ts`), and a
// regression test wearing it becomes a receipt with a lifecycle it does not
// want (`docs/decisions/acceptance-receipt-lifecycle.md`). It runs in the MAIN
// lane, whose server serves both `/plans/<id>` and `/api/mcp`.
//
// ⚠️ THE CORRECTION HAPPENS OUTSIDE THE BROWSER, and that is the product rather
// than a workaround. MOTIR-3084 removed the plan-review edit modal in favour of
// a read-only quick view; a proposal is corrected by the AGENT that wrote it,
// over the real MCP. Driving a door the product does not have would make the
// spec assert its own harness — the same reason the sibling specs refuse to stub
// the transport.
//
// What this spec does NOT re-assert: the service guarantees the vitest gate
// owns. A whole-batch rollback, a permission refusal and a referrer check are
// not visible in a browser, and `tests/integration/plans/` proves them against
// real Postgres.

test.describe.configure({ timeout: 180_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

function mcpOrigin(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('no Playwright baseURL — the MCP transport has nowhere to go');
  return baseURL;
}

const struct = (r: CallToolResult) => r.structuredContent as unknown as { id: string };
const itemIds = (r: CallToolResult) =>
  (r.structuredContent as unknown as { planItemIds: string[] }).planItemIds;

/** The plan review rail's history list — where a correction has to surface. */
const timeline = (page: Parameters<typeof signIn>[0]) =>
  page.getByRole('complementary', { name: 'Plan review' }).getByRole('list').first();

test('an agent corrects a plan a reviewer is holding, and the reviewer can see it', async ({
  page,
  baseURL,
}) => {
  const seed = await seedAgentAuthoredPlan('plan-correction@example.com');
  const agent = await agentSession(seed.token, mcpOrigin(baseURL));

  // ── 1 · A LANDED plan whose structure is wrong ────────────────────────────
  // Authored the way an agent does — and the two `add`s go in SEPARATE calls,
  // because the append now refuses a ref to a proposal in its own batch. The
  // wrongness here is a proposal parented nowhere that should hang off its
  // prerequisite.
  const planId = struct(
    (await agent.callTool({
      name: CREATE_PLAN_TOOL_NAME,
      arguments: {
        projectKey: seed.projectKey,
        title: 'Seller payouts',
        plannedWithHarness: AGENT_HARNESS,
        plannedWithModel: AGENT_MODEL,
      },
    })) as CallToolResult,
  ).id;

  const prerequisite = itemIds(
    (await agent.callTool({
      name: ADD_PLAN_ITEMS_TOOL_NAME,
      arguments: {
        planId,
        proposals: [{ op: 'add', proposedFields: { title: 'Payout ledger', kind: 'story' } }],
      },
    })) as CallToolResult,
  )[0]!;

  const [dependent, doomed] = itemIds(
    (await agent.callTool({
      name: ADD_PLAN_ITEMS_TOOL_NAME,
      arguments: {
        planId,
        proposals: [
          // ⚠️ KINDS CHOSEN SO THE CORRECTED TREE IS LEGAL AT APPROVE. The
          // correction re-parents 'Payout schedule' UNDER 'Payout ledger', and
          // `ALLOWED_CHILD_TYPES` lets a story hold a task — a story under a
          // story is refused by the confirmation gate, which would make this
          // spec fail at approve for a reason that has nothing to do with the
          // correction door.
          { op: 'add', proposedFields: { title: 'Payout schedule', kind: 'task' } },
          { op: 'add', proposedFields: { title: 'Payout retries', kind: 'task' } },
        ],
      },
    })) as CallToolResult,
  ) as [string, string];

  // Closed for review. From here a person owns it.
  await agent.callTool({
    name: ADD_PLAN_ITEMS_TOOL_NAME,
    arguments: { planId, proposals: [], final: true },
  });

  // ── 2 · The reviewer opens it, and reads the structure AS IT STANDS ───────
  await signIn(page, seed.email, AGENT_PLAN_SEED_PASSWORD);
  await page.goto(`/plans/${planId}`);
  await expect(page.getByTestId('plan-status-pill')).toContainText('Ready to review');

  // ⚠️ ASSERTED ON THE RAIL'S OWN COUNT, not on a canvas node testid. The plan
  // detail has two views — List and Canvas — and `plan-item-node` belongs to the
  // Canvas one, so a testid assertion silently measures which TAB is open rather
  // than how many proposals the plan holds. The rail renders the count in both
  // views, which is also the number the reviewer actually reads.
  const rail = page.getByRole('complementary', { name: 'Plan review' });
  await expect(rail).toContainText('3 proposed items');
  await expect(page.getByText('Payout retries')).toBeVisible();

  // The timeline BEFORE anything is corrected — so the row that arrives later is
  // demonstrably new rather than something that was always there.
  await expect(timeline(page)).toContainText('Plan ready');
  await expect(timeline(page)).not.toContainText('proposal corrected');

  // ── 3 · The agent CORRECTS it, out of band, while the page is open ────────
  const corrected = (await agent.callTool({
    name: UPDATE_PLAN_PROPOSAL_TOOL_NAME,
    arguments: {
      planId,
      planItemId: dependent,
      parentRef: `${TEMP_REF_PREFIX}${prerequisite}`,
      blockedByRefs: [`${TEMP_REF_PREFIX}${prerequisite}`],
      title: 'Payout schedule (weekly)',
    },
  })) as CallToolResult;
  // The AUTHORITATIVE signal: the tool's own response, never the rendered page.
  expect(corrected.isError).toBeFalsy();

  // ── 4 · Reload — the CORRECTED structure is what renders ──────────────────
  await page.reload();
  await expect(page.getByText('Payout schedule (weekly)')).toBeVisible();
  await expect(page.getByText('Payout schedule', { exact: true })).toHaveCount(0);

  // …and the plan's own timeline says it was corrected, by which harness. This
  // is the two stories meeting: the correction is MOTIR-3540's write, the row is
  // the sibling story's read.
  await expect(timeline(page)).toContainText('1 proposal edited');
  await expect(timeline(page)).toContainText(`· ${AGENT_HARNESS}`);

  // ── 5 · A proposal is WITHDRAWN, and leaves the canvas ────────────────────
  const withdrawn = (await agent.callTool({
    name: WITHDRAW_PLAN_PROPOSAL_TOOL_NAME,
    arguments: { planId, planItemId: doomed },
  })) as CallToolResult;
  expect(withdrawn.isError).toBeFalsy();

  await page.reload();
  await expect(rail).toContainText('2 proposed items');
  await expect(page.getByText('Payout retries')).toHaveCount(0);
  await expect(timeline(page)).toContainText('1 proposal withdrawn');

  // A sibling that still REFERENCES a proposal is reported rather than left
  // dangling — asserted here as the reviewer experiences it: the canvas never
  // renders a broken edge, because the withdraw was refused.
  const refused = (await agent.callTool({
    name: WITHDRAW_PLAN_PROPOSAL_TOOL_NAME,
    arguments: { planId, planItemId: prerequisite },
  })) as CallToolResult;
  expect(refused.isError).toBe(true);
  await page.reload();
  await expect(rail).toContainText('2 proposed items');

  // ── 6 · APPROVED — and the plan stops being the editable thing ────────────
  // ⚠️ ARMED BEFORE THE CLICK, and asserted on the WRITE'S RESPONSE rather than
  // on the pill (`motir-core/CLAUDE.md`'s E2E discipline). Polling the pill is
  // the optimistic-UI race that rule exists to stop: it reads whatever the page
  // happens to show while the POST is still in flight.
  const approved = page.waitForResponse(
    (r) => r.url().includes(`/api/plans/${planId}/approve`) && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /Approve.*to your backlog/ }).click();
  // The stale-drift confirm appears only when the plan has drifted; this one has
  // not, so the dialog is optional and the armed wait catches the POST whichever
  // button ends up firing it.
  const confirm = page.getByRole('dialog');
  if (await confirm.isVisible().catch(() => false)) {
    const anyway = confirm.getByRole('button', { name: 'Approve anyway' });
    if (await anyway.isVisible().catch(() => false)) await anyway.click();
  }
  expect((await approved).status()).toBe(200);
  await expect(page.getByTestId('plan-status-pill')).toContainText('Approved');

  const tooLate = (await agent.callTool({
    name: UPDATE_PLAN_PROPOSAL_TOOL_NAME,
    arguments: { planId, planItemId: dependent, title: 'Too late' },
  })) as CallToolResult;
  expect(tooLate.isError).toBe(true);
  // The refusal NAMES the status and points at the surface that is now live —
  // the reviewer's decision is final from their side, which is the boundary this
  // story drew.
  const message = (tooLate.content as { text?: string }[]).map((c) => c.text ?? '').join('\n');
  expect(message).toContain('approved');
  expect(message).toContain('update_work_item');
});
