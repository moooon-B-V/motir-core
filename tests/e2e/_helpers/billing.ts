// E2E seed + fixture helpers for the billing journeys (Subtask 8.1.10).
//
// The billing surfaces are CLOUD-ONLY (MOTIR_CLOUD), so these specs run in the
// dedicated cloud-on lane (playwright.billing.config.ts). The motir-ai side of
// billing (AI plan/usage + Stripe sessions) is stood in for by the E2E_TEST_BILLING
// boundary mock (lib/test-billing-mock.ts); these helpers (1) seed the local org /
// membership / project + the active-context cookies, and (2) WRITE the per-org
// fixture file the mock reads, so a spec controls exactly what the boundary reports
// for its org — and can REWRITE it mid-test to simulate a Stripe webhook landing.

import { writeFileSync, readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { db } from './db-reset';
import { signUp, SHELL_PASSWORD } from './shell-session';
import { organizationsService } from '@/lib/services/organizationsService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import { ORGANIZATION_COOKIE_NAME } from '@/lib/organizations/cookie';
import type {
  BillingFixture,
  BillingFixtureEntry,
  BillingFixtureTier,
} from '@/lib/test-billing-mock';

export interface BillingSeed {
  ownerId: string;
  ownerEmail: string;
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

/** Sign up an org owner via the UI (auto workspace + auto org, owner role), then
 *  server-side: a project pinned active, and the active-context cookies (the
 *  `workspace_id` cookie the getWorkspaceContext-gated routes read + the
 *  `motir.org` cookie the billing page resolves the active org from). Leaves the
 *  page signed in as the owner. */
export async function seedBillingOwner(page: Page, email: string): Promise<BillingSeed> {
  await signUp(page, email);
  const local = email.split('@')[0]!;
  const owner = await db.user.findFirstOrThrow({ where: { email } });
  const workspace = await db.workspace.findFirstOrThrow({
    where: { name: `${local}'s Workspace` },
  });
  const membership = await db.organizationMembership.findFirstOrThrow({
    where: { userId: owner.id, role: ORGANIZATION_ROLE.owner },
  });
  const organizationId = membership.organizationId;

  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Billing E2E',
    identifier: 'BILL',
  });

  // Pin the active project (so /onboarding + /api/ai/access resolve a context)
  // and the active-context cookies (workspace + org) so routing is deterministic.
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  await pinContextCookies(page, { workspaceId: workspace.id, organizationId });

  return {
    ownerId: owner.id,
    ownerEmail: email,
    workspaceId: workspace.id,
    organizationId,
    projectId: project.id,
  };
}

/** Add a plain (non-admin) MEMBER to the seeded org — the permission-gate actor
 *  (a member who can VIEW nothing billable: the 403 → "ask your owner" gate). */
export async function addOrgMember(
  seed: BillingSeed,
  email: string,
): Promise<{ id: string; email: string }> {
  const member = await usersService.createUser({
    email,
    password: SHELL_PASSWORD,
    name: 'Org Member',
  });
  await organizationsService.addMember({
    organizationId: seed.organizationId,
    userId: member.id,
    role: ORGANIZATION_ROLE.member,
    actorUserId: seed.ownerId,
  });
  return { id: member.id, email };
}

/** Set the `motir.org` (active org) + `workspace_id` cookies on the browser
 *  context, so the billing page resolves the right org and the workspace-gated
 *  routes resolve the right workspace. */
export async function pinContextCookies(
  page: Page,
  ctx: { workspaceId?: string; organizationId?: string },
): Promise<void> {
  const cookies = [];
  if (ctx.workspaceId) {
    cookies.push({ name: 'workspace_id', value: ctx.workspaceId, domain: 'localhost', path: '/' });
  }
  if (ctx.organizationId) {
    cookies.push({
      name: ORGANIZATION_COOKIE_NAME,
      value: ctx.organizationId,
      domain: 'localhost',
      path: '/',
    });
  }
  if (cookies.length) await page.context().addCookies(cookies);
}

// ── The motir-ai billing fixture (what the boundary mock reports per org) ──────

const STANDARD_TIER: BillingFixtureTier = {
  key: 'standard',
  name: 'Standard',
  monthlyCreditAllotment: 2000,
};
const PRO_TIER: BillingFixtureTier = { key: 'pro', name: 'Pro', monthlyCreditAllotment: 8000 };

/** A free org: no AI plan, out of trial credits (balance 0 → the paywall's
 *  proactive `blocked` threshold + the tier-gate variant). */
export function freeOrgState(balance = 0): BillingFixtureEntry {
  return {
    balance,
    tier: null,
    subscription: { status: null, currentPeriodEnd: null, priceId: null, planTier: null },
  };
}

/** A paid org on an active AI plan with the given tier + balance. */
export function paidOrgState(opts?: {
  tier?: BillingFixtureTier;
  balance?: number;
  status?: string;
  priceLookupKey?: string;
  currentPeriodEnd?: string;
}): BillingFixtureEntry {
  const tier = opts?.tier ?? STANDARD_TIER;
  return {
    balance: opts?.balance ?? tier.monthlyCreditAllotment,
    tier,
    subscription: {
      status: opts?.status ?? 'active',
      currentPeriodEnd: opts?.currentPeriodEnd ?? '2026-12-01T00:00:00.000Z',
      priceId: opts?.priceLookupKey ?? 'standard_pool_monthly',
      planTier: tier,
    },
  };
}

export const TIERS = { standard: STANDARD_TIER, pro: PRO_TIER } as const;

function fixturePath(): string {
  const p = process.env['MOTIR_AI_BILLING_FIXTURE_PATH'];
  if (!p)
    throw new Error('MOTIR_AI_BILLING_FIXTURE_PATH not set — the billing E2E lane must define it');
  return p;
}

function readFixture(): BillingFixture {
  try {
    return JSON.parse(readFileSync(fixturePath(), 'utf8')) as BillingFixture;
  } catch {
    return {};
  }
}

/** Merge one org's state into the fixture file the boundary mock reads on every
 *  request. Re-callable mid-test (the webhook-landed simulation): the next
 *  authoritative read reflects the new state. */
export function setOrgBillingState(organizationId: string, entry: BillingFixtureEntry): void {
  const fixture = readFixture();
  fixture[organizationId] = entry;
  writeFileSync(fixturePath(), JSON.stringify(fixture), 'utf8');
}

/** Reset the fixture file to empty (every org free) — call in beforeEach so a
 *  prior test's state never leaks. */
export function resetBillingFixture(): void {
  writeFileSync(fixturePath(), '{}', 'utf8');
}
