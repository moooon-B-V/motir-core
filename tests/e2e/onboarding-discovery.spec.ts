// E2E — the authed discovery onboarding flow (Subtask 7.3.8 / MOTIR-836).
//
// Drives the chat discovery loop end to end in a real browser and proves the
// FULL read surface lands in the reader: a chat turn drives the interview, the
// conductor produces the 4 direction tiers, and each tier's read-only review —
// PLUS the feature catalog folded into the vision tier — renders from
// /api/ai/pre-plan. This is the rescoped version of the original 3-doc E2E:
// 4 tiers + the catalog (the catalog seam is 7.3.78/MOTIR-1243 motir-ai +
// 7.3.79/MOTIR-1244 motir-core).
//
// motir-ai is server-to-server infrastructure with no presence in CI, so the
// three browser-reachable AI endpoints are STUBBED via page.route — exactly the
// boundary the open-core split draws (the browser only ever talks to
// motir-core's /api/ai/* routes). That keeps the test deterministic and scopes
// it to what 836 actually verifies: motir-core's consumer flow (the
// useDiscoveryChat hook + the discoveryLoop reducer + the gate/reader
// components) rendering a known conductor response — NOT motir-ai's planning.
//
//   GET  /api/ai/pre-plan        → resume read (empty before the turn; the full
//                                  4-tier + catalog state after it)
//   POST /api/ai/chat            → { jobId }
//   GET  /api/ai/chat/:id/stream → the conductor SSE (assistant + a docs frame
//                                  announcing all 4 tiers)

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { signUp, createFirstProject } from './_helpers/shell-session';

// Browser sign-up + project + a cold-compiled /onboarding route: more than the
// 30s default.
test.describe.configure({ timeout: 120_000 });

// The plain-language tier titles the reader renders (DirectionDocView's h1, from
// TIER_META) — what a founder sees, not the jargon tier names.
const TIER_TITLE = {
  discovery: 'Understanding your project',
  vision: "What we'll build",
  feasibility: 'Is it worth building?',
  validation: 'Will people want it?',
} as const;

// A recognizable body sentence per tier, so we assert the actual doc body (from
// the stubbed pre-plan) renders — not just the tier chrome.
const TIER_BODY = {
  discovery: 'Freelancers who bill clients hate chasing invoices.',
  vision: 'A calm invoicing workspace that sends and tracks for you.',
  feasibility: 'The unit economics work at a low monthly price.',
  validation: 'Ten freelancers said they would switch today.',
} as const;

type Tier = keyof typeof TIER_TITLE;
const TIERS: Tier[] = ['discovery', 'vision', 'feasibility', 'validation'];

const EMPTY_PREPLAN = { session: null, docs: [], catalog: null };

function tierDoc(kind: Tier) {
  return {
    kind,
    // The reader strips this leading `# …` title and shows TIER_TITLE instead;
    // the rest is the rendered body.
    currentBody: `# ${kind} (Tier)\n\n${TIER_BODY[kind]}`,
    currentVersion: 1,
    summary: [],
    versions: [
      {
        version: 1,
        changeReason: null,
        changeKind: null,
        diff: null,
        createdAt: '2026-06-21T00:00:00.000Z',
      },
    ],
  };
}

// The full pre-plan read once the interview has produced everything: all 4
// tiers, plus the structured feature catalog folded into vision.
const FULL_PREPLAN = {
  session: {
    classification: 'startup',
    platform: 'web',
    designStarter: null,
    validationTiming: 'standard',
    docSkipSet: [] as string[],
    currentGate: 'validation',
    status: 'active',
    conversation: [],
    createdAt: '2026-06-21T00:00:00.000Z',
    updatedAt: '2026-06-21T00:00:00.000Z',
  },
  docs: TIERS.map(tierDoc),
  catalog: {
    categories: [
      {
        id: 'cat_1',
        title: 'Invoicing',
        features: [
          {
            id: 'f1',
            name: 'Recurring invoices',
            descriptionMd: 'Auto-send on a schedule.',
            phase: 'mvp',
            status: 'todo',
          },
          {
            id: 'f2',
            name: 'Payment reminders',
            descriptionMd: 'Nudge late payers.',
            phase: 'v1',
            status: 'todo',
          },
        ],
      },
    ],
    glossary: [
      {
        id: 'g1',
        title: 'Core',
        concepts: [
          {
            id: 'c1',
            term: 'Invoice',
            aka: null,
            descriptionMd: 'A bill sent to a client.',
            example: null,
          },
        ],
      },
    ],
  },
};

// The conductor SSE: an assistant turn + a single docs frame announcing all four
// tiers (the format the chat/stream route emits — `event:`/`data:` + blank line).
const CONDUCTOR_SSE =
  `event: assistant\ndata: ${JSON.stringify({ text: "Here's the direction I've put together." })}\n\n` +
  `event: docs\ndata: ${JSON.stringify({
    docs: TIERS.map((kind, i) => ({ id: `d${i + 1}`, kind, version: 1 })),
  })}\n\n`;

/**
 * Stub the three motir-ai-backed endpoints. Pre-plan returns the EMPTY state
 * until a chat turn is submitted, then the FULL 4-tier + catalog state — gated
 * on the POST having happened (robust to however many times the hook re-reads
 * pre-plan on mount).
 */
async function stubDiscoveryApi(page: Page): Promise<void> {
  let turnSubmitted = false;

  await page.route('**/api/ai/pre-plan', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(turnSubmitted ? FULL_PREPLAN : EMPTY_PREPLAN),
    });
  });

  await page.route('**/api/ai/chat', async (route) => {
    turnSubmitted = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobId: 'job_test' }),
    });
  });

  await page.route('**/api/ai/chat/*/stream', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: CONDUCTOR_SSE });
  });
}

function reader(page: Page) {
  return {
    title: (kind: Tier) => page.getByRole('heading', { name: TIER_TITLE[kind], exact: true }),
    body: (kind: Tier) => page.getByText(TIER_BODY[kind]),
    crossLink: (kind: Tier) => page.getByRole('button', { name: TIER_TITLE[kind], exact: true }),
    catalogHeading: () => page.getByRole('heading', { name: 'The feature catalog' }),
  };
}

test.beforeEach(async () => {
  await resetDatabase();
});

test('chat discovery flow → the 4 tiers + the feature catalog appear in the reader', async ({
  page,
}) => {
  await stubDiscoveryApi(page);

  // Authed onboarding needs a session + an active project (the page gates on
  // both). Sign up + create the first project through the real UI, then enter
  // the immersive onboarding surface.
  const email = `discovery-${Date.now()}@example.com`;
  await signUp(page, email);
  await createFirstProject(page, 'Invoicer');

  await page.goto('/onboarding');

  // Fresh session → the onboarding hub with its chat composer (no docs yet).
  const composer = page.getByRole('textbox', { name: 'Reply, or ask a question…' });
  await expect(composer).toBeVisible();
  const r = reader(page);

  // Drive the interview with one chat turn.
  await composer.fill('A tool that chases unpaid invoices for freelancers.');
  await page.getByRole('button', { name: 'Send' }).click();

  // The conductor produced all four tiers; the loop opens the last one
  // (validation) into its read-only review gate.
  await expect(r.title('validation')).toBeVisible();
  await expect(r.body('validation')).toBeVisible();
  // The catalog is folded into VISION only — not shown on the validation tier.
  await expect(r.catalogHeading()).toHaveCount(0);

  // The vision tier carries the folded-in feature catalog.
  await r.crossLink('vision').click();
  await expect(r.title('vision')).toBeVisible();
  await expect(r.body('vision')).toBeVisible();
  await expect(r.catalogHeading()).toBeVisible();
  await expect(page.getByRole('heading', { name: /Invoicing/ })).toBeVisible(); // a catalog category
  await expect(page.getByText('Recurring invoices')).toBeVisible(); // a catalog feature

  // The remaining two tiers each render their read-only review too — all 4
  // direction tiers are reachable in the reader.
  await r.crossLink('feasibility').click();
  await expect(r.title('feasibility')).toBeVisible();
  await expect(r.body('feasibility')).toBeVisible();

  await r.crossLink('discovery').click();
  await expect(r.title('discovery')).toBeVisible();
  await expect(r.body('discovery')).toBeVisible();
});
