// E2E — the FULL start-fresh onboarding journey (Subtask 7.3.13 / MOTIR-842).
//
// Drives the 7.3 SLICE end to end in a real browser: a brand-new project walked
// through the guided wizard — the 4 direction tiers (each a READ-ONLY review with
// a Continue gate) + the validate-demand-first ask + the design wizard — up to the
// "Plan → your project" hand-off into 7.4, and STOPS there. The generate → review →
// approve assertions belong to 7.4's E2E (MOTIR-849), NOT here (the 2026-06-22
// re-scope: 7.3 ENDS at the design wizard / hand-off).
//
// CI-deterministic, no live model: motir-ai is server-to-server infrastructure with
// no presence in CI, so the three browser-reachable AI endpoints are STUBBED via
// `page.route` — exactly the open-core boundary (the browser only ever talks to
// motir-core's /api/ai/* routes). Unlike the single-turn 7.3.8 stub
// (onboarding-discovery.spec.ts), this one is a SCRIPTED, STATEFUL conductor: each
// chat turn (the idea, each Continue, the decision, a Skip) advances a turn index,
// mutates the accumulated pre-plan, and replays that turn's SSE — so the test
// exercises the wizard's real orchestration (tiers appearing one-by-one, the gates,
// the optional-tier skip, the design persist + RESUME across a reload), not the
// model's quality.
//
//   GET   /api/ai/pre-plan        → resume read (accumulated session + docs + catalog)
//   PATCH /api/ai/pre-plan        → persist the design choice (7.3.81); stored + echoed
//   POST  /api/ai/chat            → { jobId }; advances the scripted turn
//   GET   /api/ai/chat/:id/stream → that turn's conductor SSE (event:/data: frames)

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { signUp, createFirstProject } from './_helpers/shell-session';

// Browser sign-up + project + a cold-compiled /onboarding route + a multi-turn
// scripted journey: well past the 30s default.
test.describe.configure({ timeout: 120_000 });

// ── Fixtures (recorded, inline — no external JSON, no live model) ─────────────

// The plain-language tier titles the reader renders (DirectionDocView's <h1>, from
// TIER_META) — what a founder sees, not the internal tier names.
const TIER_TITLE = {
  discovery: 'Understanding your idea',
  vision: "What we'll build",
  feasibility: 'Is it worth building?',
  validation: 'Will people want it?',
} as const;
type Tier = keyof typeof TIER_TITLE;

// A recognizable body sentence per tier, so we assert the real doc body (from the
// stubbed pre-plan) rendered — not just the tier chrome.
const TIER_BODY: Record<Tier, string> = {
  discovery: 'Freelancers who bill clients hate chasing invoices.',
  vision: 'A calm invoicing workspace that sends and tracks for you.',
  feasibility: 'The unit economics work at a low monthly price.',
  validation: 'Ten freelancers said they would switch today.',
};

const ISO = '2026-06-21T00:00:00.000Z';

// One produced tier doc, in the /api/ai/pre-plan read shape (PreplanArtifactLogDTO).
// The reader strips the leading `# …` title and shows TIER_TITLE instead.
function tierDoc(kind: Tier) {
  return {
    kind,
    currentBody: `# ${kind} (Tier)\n\n${TIER_BODY[kind]}`,
    currentVersion: 1,
    versions: [{ version: 1, changeReason: null, changeKind: null, diff: null, createdAt: ISO }],
  };
}

// The structured feature catalog folded into the VISION tier's review (7.3.79).
const CATALOG = {
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
      ],
    },
  ],
  glossary: [
    {
      id: 'g1',
      title: 'Core',
      concepts: [{ id: 'c1', term: 'Invoice', aka: null, descriptionMd: 'A bill.', example: null }],
    },
  ],
};

// The design pick — both axes DIFFER from the product defaults (style
// `warm-editorial`, palette `motir`), so a change is observable. Display names come
// from the shipped registries (the picker chips render the registry `name`).
const DESIGN = {
  styleId: 'soft-playful',
  styleName: 'Soft / Playful',
  paletteId: 'cobalt',
  paletteName: 'Cobalt',
} as const;

// ── The scripted, stateful conductor stub ────────────────────────────────────

type SessionPatch = Record<string, unknown>;
interface StubState {
  session: Record<string, unknown> | null;
  docs: ReturnType<typeof tierDoc>[];
  catalog: unknown;
}
interface TurnSpec {
  /** The SSE this turn replays (assistant + state + docs/ask frames). */
  sse: string;
  /** The mutation this turn applies to the accumulated pre-plan. */
  mutate: (s: StubState) => void;
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const BLANK_SESSION = {
  classification: null,
  platform: null,
  designStarter: null,
  designChoice: null,
  validationTiming: null,
  docSkipSet: [] as string[],
  currentGate: null,
  status: 'active',
  conversation: [] as unknown[],
  createdAt: ISO,
  updatedAt: ISO,
};

function patchSession(s: StubState, patch: SessionPatch): void {
  s.session = { ...(s.session ?? BLANK_SESSION), ...patch, updatedAt: ISO };
}
function addDoc(s: StubState, kind: Tier): void {
  if (!s.docs.some((d) => d.kind === kind)) s.docs = [...s.docs, tierDoc(kind)];
}

/**
 * Install the stateful conductor on `page` for a given `script`. The hook drives
 * POST /api/ai/chat → GET stream serially per turn, so a simple turn counter is
 * race-free. Returns nothing — the routes own all the state.
 */
async function installConductor(page: Page, script: TurnSpec[]): Promise<void> {
  const state: StubState = { session: null, docs: [], catalog: null };
  let turn = -1;
  let lastSse = '';

  // GET resume read + PATCH design-choice persist share the /api/ai/pre-plan path.
  await page.route('**/api/ai/pre-plan', async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = (route.request().postDataJSON() ?? {}) as { designChoice?: unknown };
      patchSession(state, { designChoice: body.designChoice ?? null });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ designChoice: (state.session as SessionPatch).designChoice }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ session: state.session, docs: state.docs, catalog: state.catalog }),
    });
  });

  // POST a chat turn → advance the script, apply its mutation, arm its SSE.
  await page.route('**/api/ai/chat', async (route) => {
    turn = Math.min(turn + 1, script.length - 1);
    const spec = script[turn]!;
    spec.mutate(state);
    lastSse = spec.sse;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobId: `job_${turn}` }),
    });
  });

  // The SSE stream for the turn just submitted. Registered LAST so this more
  // specific glob wins over `**/api/ai/chat`.
  await page.route('**/api/ai/chat/*/stream', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: lastSse });
  });
}

// The forward gated journey: idea → discovery → vision(+catalog) → feasibility →
// validation + the validate-demand-first ask → decision → tiers complete.
const GATED_SCRIPT: TurnSpec[] = [
  {
    // turn 0 — the idea seeds the discovery tier; the conductor infers a web project.
    sse:
      frame('assistant', { text: "Let's start by understanding your idea." }) +
      frame('state', {
        classification: 'startup',
        platform: 'web',
        currentGate: 'discovery',
        status: 'active',
      }) +
      frame('docs', { docs: [{ id: 'd1', kind: 'discovery', version: 1 }] }),
    mutate: (s) => {
      patchSession(s, {
        classification: 'startup',
        platform: 'web',
        currentGate: 'discovery',
        status: 'active',
      });
      addDoc(s, 'discovery');
    },
  },
  {
    // turn 1 — Continue from discovery drafts the vision tier (catalog folded in).
    sse:
      frame('assistant', { text: "Here's what we'll build." }) +
      frame('state', { currentGate: 'vision' }) +
      frame('docs', { docs: [{ id: 'd2', kind: 'vision', version: 1 }] }),
    mutate: (s) => {
      patchSession(s, { currentGate: 'vision' });
      addDoc(s, 'vision');
      s.catalog = CATALOG;
    },
  },
  {
    // turn 2 — Continue from vision drafts the (optional) feasibility tier.
    sse:
      frame('assistant', { text: 'Now the reality check.' }) +
      frame('state', { currentGate: 'feasibility' }) +
      frame('docs', { docs: [{ id: 'd3', kind: 'feasibility', version: 1 }] }),
    mutate: (s) => {
      patchSession(s, { currentGate: 'feasibility' });
      addDoc(s, 'feasibility');
    },
  },
  {
    // turn 3 — Continue from feasibility drafts validation AND parks the blocking
    // validate-demand-first ask on it (MOTIR-1064): the gate locks Continue.
    sse:
      frame('assistant', { text: 'One call before we finish.' }) +
      frame('state', { currentGate: 'validate_early' }) +
      frame('docs', { docs: [{ id: 'd4', kind: 'validation', version: 1 }] }) +
      frame('validate_early_ask', {
        recommendation: 'Real demand, but unproven for your exact take.',
        defaultTiming: 'standard',
      }),
    mutate: (s) => {
      patchSession(s, { currentGate: 'validate_early' });
      addDoc(s, 'validation');
    },
  },
  {
    // turn 4 — the decision resolves the ask; the direction is complete (no new doc,
    // so the state frame alone flips the loop to tiers_complete + clears the ask).
    sse:
      frame('assistant', { text: "Great — that's your direction set." }) +
      frame('state', {
        validationTiming: 'validate_first',
        currentGate: 'tiers_complete',
        status: 'tiers_complete',
      }),
    mutate: (s) => {
      patchSession(s, {
        validationTiming: 'validate_first',
        currentGate: 'tiers_complete',
        status: 'tiers_complete',
      });
    },
  },
];

// The skip branch: idea → discovery → vision, then SKIP the optional checks from the
// chat (a conversation-only decision) straight to a complete direction.
const SKIP_SCRIPT: TurnSpec[] = [
  GATED_SCRIPT[0]!,
  GATED_SCRIPT[1]!,
  {
    // turn 2 — the chat Skip advances past both optional tiers to tiers_complete.
    sse:
      frame('assistant', { text: "Skipping the optional checks — your direction's set." }) +
      frame('state', {
        docSkipSet: ['feasibility', 'validation'],
        currentGate: 'tiers_complete',
        status: 'tiers_complete',
      }),
    mutate: (s) => {
      patchSession(s, {
        docSkipSet: ['feasibility', 'validation'],
        currentGate: 'tiers_complete',
        status: 'tiers_complete',
      });
    },
  },
];

// The resume branch: a single idea turn drafts discovery, then we reload and prove
// the wizard hydrates back INTO the discovery review (not a restart).
const RESUME_SCRIPT: TurnSpec[] = [GATED_SCRIPT[0]!];

// ── Locators ─────────────────────────────────────────────────────────────────

const composer = (page: Page) => page.getByRole('textbox', { name: 'Reply, or ask a question…' });
const tierHeading = (page: Page, kind: Tier) =>
  page.getByRole('heading', { name: TIER_TITLE[kind], exact: true });
const continueButton = (page: Page) => page.getByRole('button', { name: 'Looks good — continue' });
// The hub's "Design your look" shortcut shares its accessible name with the canvas
// `design` station CTA; the station CTA lives inside [data-testid="planning-canvas"]
// and renders FIRST, so the hub shortcut is the LAST match.
const designEntry = (page: Page) => page.getByRole('button', { name: 'Design your look' }).last();
const designPage = (page: Page) => page.getByTestId('design-page');

async function startFreshOnboarding(page: Page, label: string): Promise<void> {
  const email = `onboarding-fresh-${label}-${Date.now()}@example.com`;
  await signUp(page, email);
  await createFirstProject(page, 'Invoicer');
  await page.goto('/onboarding');
  await expect(composer(page)).toBeVisible();
}

test.beforeEach(async () => {
  await resetDatabase();
});

// ── 1. The full gated journey → design wizard → hand-off (stops before 7.4) ──
test('fresh onboarding: 4 gated tiers → validate ask → design wizard → plan hand-off', async ({
  page,
}) => {
  await installConductor(page, GATED_SCRIPT);
  await startFreshOnboarding(page, 'gated');

  // Seed the idea (the typed front-door idea; a fresh sign-up carries no cookie).
  await composer(page).fill('A tool that chases unpaid invoices for freelancers.');
  await page.getByRole('button', { name: 'Send' }).click();

  // ── The tiers appear ONE BY ONE, each a read-only review with a Continue gate ──
  // discovery
  await expect(tierHeading(page, 'discovery')).toBeVisible();
  await expect(page.getByText('Read-only.')).toBeVisible(); // the gate is read-only
  await expect(page.getByText(TIER_BODY.discovery)).toBeVisible();
  await expect(continueButton(page)).toBeEnabled();
  await continueButton(page).click();

  // vision — carries the folded-in feature catalog
  await expect(tierHeading(page, 'vision')).toBeVisible();
  await expect(page.getByText(TIER_BODY.vision)).toBeVisible();
  await expect(page.getByRole('heading', { name: /Invoicing/ })).toBeVisible(); // catalog category
  await expect(page.getByText('Recurring invoices')).toBeVisible(); // catalog feature
  await continueButton(page).click();

  // feasibility (optional)
  await expect(tierHeading(page, 'feasibility')).toBeVisible();
  await expect(page.getByText(TIER_BODY.feasibility)).toBeVisible();
  await continueButton(page).click();

  // validation (optional) — the validate-demand-first ask GATES Continue
  await expect(tierHeading(page, 'validation')).toBeVisible();
  const decision = page.getByRole('region', { name: 'One call before we plan' });
  await expect(decision).toBeVisible();
  await expect(continueButton(page)).toBeDisabled(); // blocked until a choice is made

  // Decide on the page → the ask clears, the direction completes.
  await decision.getByRole('button', { name: 'Prove demand first' }).click();
  await expect(decision).toBeHidden();

  // Back to the hub — now complete, the design + plan affordances appear.
  await page.getByRole('button', { name: 'Back' }).first().click();
  await expect(page.getByRole('button', { name: 'Go to plan phase' })).toBeVisible();
  await expect(designEntry(page)).toBeVisible();

  // ── The design wizard: pick a Style + Palette; the page styles its WHOLE self ──
  await designEntry(page).click();
  await expect(designPage(page)).toBeVisible();
  await page
    .getByRole('radiogroup', { name: 'Style', exact: true })
    .getByRole('radio', { name: DESIGN.styleName, exact: true })
    .click();
  await page
    .getByRole('radiogroup', { name: 'Palette', exact: true })
    .getByRole('radio', { name: DESIGN.paletteName, exact: true })
    .click();
  // The whole design page wears the chosen axes (scoped to its own <section>).
  await expect(designPage(page)).toHaveAttribute('data-style', DESIGN.styleId);
  await expect(designPage(page)).toHaveAttribute('data-palette', DESIGN.paletteId);

  // Persist it — arm the PATCH wait BEFORE the click (the save is best-effort).
  const patch = page.waitForResponse(
    (r) => r.url().includes('/api/ai/pre-plan') && r.request().method() === 'PATCH',
  );
  await page.getByRole('button', { name: 'Use this design' }).click();
  expect((await patch).status()).toBe(200);

  // ── Persistence across a reload: re-open the design step, still selected ──
  await page.reload();
  await expect(designEntry(page)).toBeVisible(); // resumed at the complete hub
  await designEntry(page).click();
  await expect(designPage(page)).toHaveAttribute('data-style', DESIGN.styleId);
  await expect(designPage(page)).toHaveAttribute('data-palette', DESIGN.paletteId);
  await expect(
    page
      .getByRole('radiogroup', { name: 'Style', exact: true })
      .getByRole('radio', { name: DESIGN.styleName, exact: true }),
  ).toHaveAttribute('aria-checked', 'true');

  // ── The hand-off into 7.4 — reach it and STOP (no tree generation here) ──
  await page.getByRole('button', { name: 'Back' }).first().click(); // design → hub
  await page.getByRole('button', { name: 'Go to plan phase' }).click();
  await expect(page.getByTestId('generation-handoff')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your direction is set' })).toBeVisible();
});

// ── 2. An optional tier can be SKIPPED in the chat ───────────────────────────
test('fresh onboarding: an optional tier can be skipped from the chat', async ({ page }) => {
  await installConductor(page, SKIP_SCRIPT);
  await startFreshOnboarding(page, 'skip');

  await composer(page).fill('A tool that chases unpaid invoices for freelancers.');
  await page.getByRole('button', { name: 'Send' }).click();

  // discovery → vision, then back to the hub where the skip affordance lives.
  await expect(tierHeading(page, 'discovery')).toBeVisible();
  await continueButton(page).click();
  await expect(tierHeading(page, 'vision')).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).first().click();

  // The chat offers an optional-tier Skip; taking it completes the direction
  // without drafting the optional checks.
  const skip = page.getByRole('button', { name: 'Skip it' });
  await expect(skip).toBeVisible();
  await skip.click();

  await expect(page.getByRole('button', { name: 'Go to plan phase' })).toBeVisible();
  await expect(tierHeading(page, 'validation')).toHaveCount(0); // the optional tier was skipped
});

// ── 3. Resume: a reload returns to the right step with the docs intact ───────
test('fresh onboarding: reloading resumes the wizard at the right step', async ({ page }) => {
  await installConductor(page, RESUME_SCRIPT);
  await startFreshOnboarding(page, 'resume');

  await composer(page).fill('A tool that chases unpaid invoices for freelancers.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(tierHeading(page, 'discovery')).toBeVisible();

  // Reload mid-journey — the persisted pre-plan hydrates back INTO the discovery
  // review (not a fresh-start composer), with the tier body intact.
  await page.reload();
  await expect(tierHeading(page, 'discovery')).toBeVisible();
  await expect(page.getByText(TIER_BODY.discovery)).toBeVisible();
});
