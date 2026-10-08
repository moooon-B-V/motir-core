import type { Browser, Page } from '@playwright/test';
import { expect, test } from './_helpers/acceptance-video';
import { adminDb, db, resetDatabase } from './_helpers/db-reset';
import {
  TIERS,
  addOrgMember,
  paidOrgState,
  pinContextCookies,
  resetBillingFixture,
  seedBillingOwner,
  setOrgBillingState,
  type BillingSeed,
} from './_helpers/billing';
import { emailsTo, waitForEmail } from './_helpers/email-capture';
import { SHELL_PASSWORD, signIn, signUp } from './_helpers/shell-session';
import enMessages from '@/messages/en.json';

/**
 * STORY MOTIR-7602 — Contact sales reaches platform staff (MOTIR-7611). The
 * story's verification recipe across its two actors, in a real browser on the
 * cloud-on acceptance lane.
 *
 * The recorded HAPPY PATH (the first test, the story's receipt), paced for a
 * person:
 *  1. The owner opens Billing & plans → Motir AI and presses Contact sales; the
 *     form shows the org read-only.
 *  2. Fills the needs and the note and sends; the card reads "Request sent".
 *  3. Pressing it again shows the request read-only, not a second form.
 *  4. The lane's email outbox holds one message per platform staff member,
 *     naming the org and linking to the request.
 *  5. An operator opens the console, finds Enterprise requests in its rail, and
 *     the request at the top as New.
 *  6. Opens it, follows the org link to Tenants and back, and moves it
 *     contacted → offer sent → won; each move lands in the History.
 *  7. The owner reloads Billing & plans and is offered Contact sales again.
 * The second test holds the refusals and the empty state (cases 8–9).
 *
 * Every wait is an authoritative signal — the enterprise-request route's own
 * response (status AND body), the outbox file the `file` email provider writes,
 * the detail's `data-status` the revalidated server page renders, a rendered
 * landmark. The `beat()`s are the reviewer's pauses, never synchronisation.
 */

test.describe.configure({ timeout: 300_000 });

const sales = enMessages.billing.contactSales;
const plans = enMessages.billing.plans;
const ai = enMessages.billing.ai;
const requests = enMessages.platformAdmin.enterpriseRequests;
const shell = enMessages.platformAdmin.shell;
const mail = enMessages.email.enterpriseRequestReceived;
const MOVES = [
  requests.move.contacted,
  requests.move.offer_sent,
  requests.move.won,
  requests.move.lost,
];

const OWNER = 'acceptance-contact-sales-owner@example.com';
const OPERATOR = 'acceptance-contact-sales-operator@example.com';
const SUPPORT = 'acceptance-contact-sales-support@example.com';
const MEMBER = 'acceptance-contact-sales-member@example.com';
const ORG = 'Northwind Robotics';
const NOTE =
  'We want Motir to run our platform team’s backlog around the clock, across twelve repositories.';

const BILLING_PATH = '/settings/organization/billing';

/** A message with `{placeholders}` filled — the same substitution next-intl makes. */
function fill(message: string, values: Record<string, string>): string {
  return message.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}

/** A message as a literal pattern. */
const literal = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

/** The date as the card writes it: next-intl's day / short month / year, in UTC. */
function asCardDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

interface RequestBody {
  id: string;
  createdAt: string;
  status: string;
  contact: string;
  note: string;
}

const enterpriseRequestRoute = (orgId: string) =>
  `/api/organizations/${orgId}/billing/enterprise-request`;

/** The card's own read or write of the org's open request. Armed BEFORE the action. */
function enterpriseResponse(page: Page, orgId: string, method: 'GET' | 'POST') {
  return page.waitForResponse(
    (res) =>
      res.request().method() === method &&
      new URL(res.url()).pathname === enterpriseRequestRoute(orgId),
    { timeout: 45_000 },
  );
}

/** A console move — the server action POSTed to the detail page it was pressed on. */
function moveResponse(page: Page, requestId: string) {
  return page.waitForResponse(
    (res) =>
      res.request().method() === 'POST' &&
      res.request().headers()['next-action'] !== undefined &&
      new URL(res.url()).pathname === `/admin/enterprise-requests/${requestId}`,
    { timeout: 45_000 },
  );
}

/** Sign platform staff up in a context nobody films, and give them their role. */
async function seedStaff(
  browser: Browser,
  staff: Array<{ email: string; role: 'operator' | 'support' }>,
): Promise<void> {
  const context = await browser.newContext();
  const setupPage = await context.newPage();
  for (const { email } of staff) await signUp(setupPage, email);
  await context.close();
  for (const { email, role } of staff) {
    // A staff notice reaches only a VERIFIED address (`listStaffRecipients`).
    await adminDb.user.update({
      where: { email },
      data: { platformRole: role, emailVerified: true },
    });
  }
}

/** The owner's org, renamed so every surface names something a reviewer can read. */
async function seedOwner(browser: Browser): Promise<BillingSeed> {
  const context = await browser.newContext();
  const setupPage = await context.newPage();
  const seed = await seedBillingOwner(setupPage, OWNER);
  await context.close();
  await adminDb.organization.update({ where: { id: seed.organizationId }, data: { name: ORG } });
  // A Pro organization: its owner reaches the plans screen through Change plan.
  setOrgBillingState(seed.organizationId, paidOrgState({ tier: TIERS.pro }));
  return seed;
}

/** Switch the filmed page to another account, from a clean cookie jar. */
async function switchTo(page: Page, email: string, seed?: BillingSeed): Promise<void> {
  await page.context().clearCookies();
  await signIn(page, email, SHELL_PASSWORD);
  if (seed) {
    await pinContextCookies(page, {
      workspaceId: seed.workspaceId,
      organizationId: seed.organizationId,
    });
  }
}

/** Billing & plans → Motir AI plans, waiting on the card's own read of the open request. */
async function openPlans(page: Page, orgId: string): Promise<RequestBody | null> {
  const read = enterpriseResponse(page, orgId, 'GET');
  await page.goto(BILLING_PATH);
  const res = await read;
  expect(res.status()).toBe(200);
  const open = (await res.json()) as RequestBody | null;
  await page.getByRole('button', { name: ai.changePlan }).click();
  await expect(page.getByRole('heading', { name: plans.title })).toBeVisible();
  return open;
}

test.afterAll(async () => {
  await db.$disconnect();
});

test('an owner sends a Contact-sales request, staff are emailed and move it to won in /admin, and the owner can ask again', async ({
  page,
  browser,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7602');

  await resetDatabase();
  resetBillingFixture();
  await seedStaff(browser, [
    { email: OPERATOR, role: 'operator' },
    { email: SUPPORT, role: 'support' },
  ]);
  const seed = await seedOwner(browser);
  await switchTo(page, OWNER, seed);

  let request!: RequestBody;
  const contactSales = page.getByRole('button', { name: sales.contact, exact: true });

  await chapter('The owner presses Contact sales on the Enterprise plan', async () => {
    const open = await openPlans(page, seed.organizationId);
    expect(open).toBeNull();
    await expect(contactSales).toHaveAttribute('aria-haspopup', 'dialog');
    await contactSales.click();
    const dialog = page.getByRole('dialog', { name: sales.title });
    await expect(dialog).toBeVisible();
    // The org is sent read-only, beside the person's answers.
    const facts = dialog.getByTestId('contact-sales-facts');
    await expect(facts).toContainText(sales.facts.organization);
    await expect(facts).toContainText(ORG);
    await expect(facts).toContainText(TIERS.pro.name);
    await expect(dialog.getByRole('textbox', { name: sales.fields.contact })).toHaveValue(OWNER);
    await beat();
  });

  await chapter('Fill in what the team needs, and send', async () => {
    const dialog = page.getByRole('dialog', { name: sales.title });
    await dialog.getByRole('spinbutton', { name: sales.fields.cardsPerDay }).fill('40');
    await dialog.getByRole('spinbutton', { name: sales.fields.parallelAgents }).fill('8');
    await dialog
      .getByRole('radiogroup', { name: sales.fields.agentPath })
      .getByText(sales.agentPath.both.label, { exact: true })
      .click();
    await dialog
      .getByRole('radiogroup', { name: sales.fields.autonomy })
      .getByText(sales.autonomy.autonomous_lead.label, { exact: true })
      .click();
    await dialog.getByRole('combobox', { name: sales.fields.startWhen }).click();
    await page.getByRole('option', { name: sales.startWhen.within_month }).click();
    await dialog.getByRole('combobox', { name: sales.fields.teamSize }).click();
    await page.getByRole('option', { name: sales.teamSize.size_11_50 }).click();
    await dialog.getByRole('textbox', { name: /^Note/ }).fill(NOTE);
    await beat();

    const sent = enterpriseResponse(page, seed.organizationId, 'POST');
    const reread = enterpriseResponse(page, seed.organizationId, 'GET');
    await dialog.getByRole('button', { name: sales.send }).click();
    const res = await sent;
    expect(res.status()).toBe(201);
    request = (await res.json()) as RequestBody;
    expect(request.note).toBe(NOTE);
    expect(request.contact).toBe(OWNER);
    // The card re-reads the open request from the server before confirming.
    const fresh = await reread;
    expect(((await fresh.json()) as RequestBody).id).toBe(request.id);

    const confirmation = page.getByRole('dialog', { name: sales.sent.title });
    await expect(confirmation.getByTestId('contact-sales-sent')).toContainText(OWNER);
    await beat();
    await confirmation.getByRole('button', { name: sales.done }).click();
    await expect(confirmation).toBeHidden();
    await expect(
      page.getByRole('button', {
        name: fill(sales.sentChip, { date: asCardDate(request.createdAt) }),
      }),
    ).toBeVisible();
    await expect(contactSales).toHaveCount(0);
    await beat();
  });

  await chapter('Pressing it again shows the request, not a second form', async () => {
    await page
      .getByRole('button', { name: fill(sales.sentChip, { date: asCardDate(request.createdAt) }) })
      .click();
    const view = page.getByRole('dialog', { name: sales.request.title });
    const body = view.getByTestId('contact-sales-request');
    await expect(body).toContainText(NOTE);
    await expect(body).toContainText(sales.request.status.received);
    await expect(body).toContainText(sales.teamSize.size_11_50);
    await expect(view.getByRole('textbox')).toHaveCount(0);
    await expect(view.getByRole('button', { name: sales.send })).toHaveCount(0);
    await beat();
    // The footer's Close — the corner ✕ carries the same accessible name, no text.
    await view.getByRole('button', { name: sales.close }).filter({ hasText: sales.close }).click();
    await expect(view).toBeHidden();
  });

  await chapter('Every platform staff member is emailed, with a link to the request', async () => {
    const subject = fill(mail.subject, { organization: ORG });
    const link = `/admin/enterprise-requests/${request.id}`;
    for (const staff of [OPERATOR, SUPPORT]) {
      // The outbox the `file` provider appends to is the delivery's own record.
      const email = await waitForEmail(staff, { timeoutMs: 45_000 });
      expect(email.subject).toBe(subject);
      expect(email.text).toContain(ORG);
      expect(email.text).toContain(NOTE);
      expect(email.text).toContain(link);
      expect((await emailsTo(staff)).filter((e) => e.subject === subject)).toHaveLength(1);
    }
    // The owner is not staff, so the notice never reaches them.
    expect((await emailsTo(OWNER)).filter((e) => e.subject === subject)).toHaveLength(0);
  });

  await switchTo(page, OPERATOR);
  const main = page.getByRole('main');

  await chapter(
    'An operator finds Enterprise requests in the console, the request on top as New',
    async () => {
      await page.goto('/admin');
      await page.getByRole('link', { name: shell.navEnterpriseRequests, exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/enterprise-requests$/);
      await expect(main.getByRole('heading', { name: requests.title, level: 1 })).toBeVisible();
      await expect(
        main.getByRole('group', { name: requests.filterLabel }).getByRole('button', {
          name: literal(requests.filter.open),
        }),
      ).toBeVisible();
      const table = main.getByTestId('enterprise-requests-table');
      const row = table.getByTestId(`enterprise-request-row-${request.id}`);
      await expect(row).toHaveAttribute('data-status', 'new');
      await expect(table.locator('tbody tr').first()).toHaveAttribute(
        'data-testid',
        `enterprise-request-row-${request.id}`,
      );
      await expect(row).toContainText(requests.status.new);
      await beat();
    },
  );

  const detail = main.getByTestId('enterprise-request-detail');
  const history = main
    .getByTestId('enterprise-request-history')
    .getByTestId('enterprise-request-history-entry');

  await chapter('Open the request, and follow its organisation to Tenants and back', async () => {
    await main
      .getByTestId('enterprise-requests-table')
      .getByRole('link', { name: ORG, exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/admin/enterprise-requests/${request.id}$`));
    await expect(main.getByRole('heading', { name: ORG, level: 1 })).toBeVisible();
    await expect(main.getByTestId('enterprise-request-body')).toContainText(NOTE);
    await expect(history).toHaveCount(1);
    await beat();

    await main.getByRole('link', { name: fill(requests.detail.orgLink, { org: ORG }) }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/tenants/${seed.organizationId}$`));
    await expect(main.getByRole('heading', { name: ORG, level: 1 })).toBeVisible();
    await beat();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/admin/enterprise-requests/${request.id}$`));
    await expect(detail).toHaveAttribute('data-status', 'new');
  });

  await chapter('Move it to contacted, then to offer sent', async () => {
    for (const [action, to, entries] of [
      [requests.move.contacted, 'contacted', 2],
      [requests.move.offer_sent, 'offer_sent', 3],
    ] as const) {
      const moved = moveResponse(page, request.id);
      await main.getByRole('button', { name: action }).click();
      expect((await moved).status()).toBe(200);
      // The revalidated server page answers the move: its state and its History.
      await expect(detail).toHaveAttribute('data-status', to);
      await expect(history).toHaveCount(entries);
      await expect(history.last()).toContainText(requests.status[to]);
      await expect(history.last()).toContainText(OPERATOR);
      await beat();
    }
  });

  await chapter('Mark it won, after confirming', async () => {
    await main.getByRole('button', { name: requests.move.won }).click();
    const confirm = page.getByRole('alertdialog', {
      name: fill(requests.confirm.title, { state: requests.stateWord.won }),
    });
    await expect(confirm).toBeVisible();
    await beat();
    const moved = moveResponse(page, request.id);
    await confirm.getByRole('button', { name: requests.move.won }).click();
    expect((await moved).status()).toBe(200);
    await expect(detail).toHaveAttribute('data-status', 'won');
    await expect(history).toHaveCount(4);
    await expect(history.last()).toContainText(requests.status.won);
    await expect(main.getByTestId('enterprise-request-closed')).toBeVisible();
    for (const action of MOVES) {
      await expect(main.getByRole('button', { name: action })).toHaveCount(0);
    }
    await beat();
  });

  await switchTo(page, OWNER, seed);

  await chapter('The owner reloads Billing & plans and can contact sales again', async () => {
    // The card's own read says nothing is open any more.
    const open = await openPlans(page, seed.organizationId);
    expect(open).toBeNull();
    await expect(contactSales).toBeVisible();
    await expect(contactSales).toBeEnabled();
    await expect(
      page.getByRole('button', { name: literal(fill(sales.sentChip, { date: '' })) }),
    ).toHaveCount(0);
    await beat();
  });
});

test('refusals: an empty console, a member without manageBilling, and support staff with no state controls', async ({
  page,
  browser,
}) => {
  await resetDatabase();
  resetBillingFixture();
  await seedStaff(browser, [{ email: SUPPORT, role: 'support' }]);
  const main = page.getByRole('main');

  // ── Case 9: with no request ever sent, the console shows its empty state.
  await switchTo(page, SUPPORT);
  await page.goto('/admin/enterprise-requests');
  await expect(main.getByRole('heading', { name: requests.title, level: 1 })).toBeVisible();
  const empty = main.getByTestId('enterprise-requests-empty');
  await expect(empty).toContainText(requests.empty.title);
  await expect(empty).toContainText(requests.empty.body);
  await expect(main.getByTestId('enterprise-requests-table')).toHaveCount(0);

  // An owner sends one, through the card's own door.
  const seed = await seedOwner(browser);
  await addOrgMember(seed, MEMBER);
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await switchTo(ownerPage, OWNER, seed);
  const sent = await ownerPage.request.post(enterpriseRequestRoute(seed.organizationId), {
    data: { note: NOTE },
  });
  expect(sent.status()).toBe(201);
  const request = (await sent.json()) as RequestBody;
  await ownerContext.close();

  // ── Case 8a: a member without `manageBilling`. The plans screen — where the
  // Enterprise card's Contact sales lives — is reached only through the
  // manager-gated Change plan, so in the shipped flow a member never sees the
  // card at all: Billing & plans gives them the admins' gate, and the request
  // route refuses them with the billing refusal.
  await switchTo(page, MEMBER, seed);
  const billingRead = page.waitForResponse(
    (res) =>
      res.request().method() === 'GET' &&
      new URL(res.url()).pathname === `/api/organizations/${seed.organizationId}/billing`,
  );
  await page.goto(BILLING_PATH);
  expect((await billingRead).status()).toBe(403);
  await expect(
    page.getByRole('heading', { name: enMessages.billing.member.gateTitle }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: ai.changePlan })).toHaveCount(0);
  await expect(page.getByRole('button', { name: sales.contact, exact: true })).toHaveCount(0);
  for (const verb of ['get', 'post'] as const) {
    const res =
      verb === 'get'
        ? await page.request.get(enterpriseRequestRoute(seed.organizationId))
        : await page.request.post(enterpriseRequestRoute(seed.organizationId), {
            data: { note: NOTE },
          });
    expect(res.status(), verb).toBe(403);
    expect(((await res.json()) as { code: string }).code, verb).toBe('BILLING_FORBIDDEN');
  }

  // ── Case 8b: support staff read the request, with no state controls.
  await switchTo(page, SUPPORT);
  await page.goto(`/admin/enterprise-requests/${request.id}`);
  await expect(main.getByRole('heading', { name: ORG, level: 1 })).toBeVisible();
  await expect(main.getByTestId('enterprise-request-body')).toContainText(NOTE);
  await expect(main.getByTestId('enterprise-request-read-only')).toBeVisible();
  for (const action of MOVES) {
    await expect(main.getByRole('button', { name: action })).toHaveCount(0);
  }
  await expect(main.getByTestId('enterprise-request-detail')).toHaveAttribute('data-status', 'new');
});
