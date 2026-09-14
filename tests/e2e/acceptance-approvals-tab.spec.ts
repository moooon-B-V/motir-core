import type { Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { servePrivateObjectStore } from './_helpers/object-store';
import {
  IMAGE_SOURCE_PATH,
  MOCK_HTML,
  MOCK_SOURCE_PATH,
  NOTE_MD,
  NOTE_SOURCE_PATH,
  PNG_BYTES,
} from './_helpers/design-approval-seed';
import {
  plantFillerGates,
  seedApprovalsTab,
  STORY_TITLE_EXPORT,
  type ApprovalsTabSeed,
} from './_helpers/approvals-tab-seed';

// THE APPROVALS TAB, END TO END — AND THE ACCEPTANCE RECEIPT FOR IT
// (Story MOTIR-4879 · Subtask MOTIR-5149).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// One thing, and it is the thing the story exists for: a person arrives at work
// and is TOLD what is waiting on them, instead of having to already know which
// card to open. The clip's argument is the first screen after sign-in — a tab
// with a number on it — and the moment after the decision, when that number and
// the list agree without anybody reloading anything.
//
// ── THE ONE THING ONLY AN E2E CAN PROVE ─────────────────────────────────────
//
// Deciding from this tab moves THREE things that live in different places: the
// row leaves the list, the badge on the strip drops, and — because a
// `design_result` approval is TERMINAL — the subject card reaches `done`.
// MOTIR-4794 keeps them consistent by REFRESHING the server-rendered page
// rather than patching a client island, and "they agree" is a property of ONE
// RENDER CONTAINING BOTH. A unit test cannot see it: the badge and the rows are
// rendered by different components, and a suite asserting them separately would
// pass on exactly the implementation this contract forbids.
//
// So the central assertion reads the badge and the rows IN THE SAME PAGE STATE,
// before and after — never a render apart.
//
// ── WHAT IS PUBLISHED FOR REAL, AND WHAT IS SEEDED ──────────────────────────
//
// The gate under test is PUBLISHED through `publish_design_result` over
// `/api/mcp` with a `CLI_TOKEN_GRANT` bearer, exactly as
// `design-approval.spec.ts` does: the `awaiting` gate is created BY
// `designEvidenceService` at publish, so a seeded one would be an assertion
// against a row the product never made. The pager's filler gates are written
// directly — `approvals-tab-seed.ts` states that trade in full, and nothing is
// ever asserted about them individually.
//
// ⚠️ EVERY WAIT IS AUTHORITATIVE — the row COUNT, the URL, the row's own text.
// No `waitForTimeout` and no fixed sleeps anywhere in this file.

test.describe.configure({ timeout: 240_000 });

const b64 = (b: Buffer) => b.toString('base64');

/** Open an MCP session as an AGENT would — a bearer, no cookie, no session. */
async function agentSession(token: string, baseURL: string): Promise<Client> {
  const client = new Client({ name: 'approvals-tab-e2e', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/api/mcp', baseURL), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function publish(client: Client, key: string): Promise<CallToolResult> {
  return client.callTool({
    name: 'publish_design_result',
    arguments: {
      key,
      assets: [
        {
          kind: 'mock',
          sourcePath: MOCK_SOURCE_PATH,
          contentType: 'text/html',
          contentBase64: b64(Buffer.from(MOCK_HTML)),
        },
        {
          kind: 'image',
          sourcePath: IMAGE_SOURCE_PATH,
          contentType: 'image/png',
          contentBase64: b64(PNG_BYTES),
        },
        {
          kind: 'note_file',
          sourcePath: NOTE_SOURCE_PATH,
          contentType: 'text/markdown',
          contentBase64: b64(Buffer.from(NOTE_MD)),
        },
      ],
      noteMd: NOTE_MD,
      producedByKey: key,
    },
  }) as Promise<CallToolResult>;
}

/**
 * The strip's **To approve** badge, as a number, read in the CURRENT page state.
 *
 * The strip SUPPRESSES a zero badge (`design/workbench/design-notes.md` § the
 * tab strip — *"a `0` beside a tab is noise a new user has to parse"*), so an
 * absent number IS zero rather than an element to wait for.
 */
async function badgeCount(page: Page): Promise<number> {
  const text = (await page.getByRole('link', { name: /To approve/ }).textContent()) ?? '';
  const digits = text.replace(/[^0-9]/g, '');
  return digits === '' ? 0 : Number(digits);
}

// ⚠️ ROLE-ROOTED, NEVER PAGE-ROOTED (MOTIR-5386). The workbench streams its tab
// behind an in-page `<Suspense>`, so the DOM can briefly hold a HIDDEN second
// copy of what the tab renders — and a page-rooted `getByText` / `getByTestId`
// resolves both and dies on strict mode. That ejected two unrelated pull
// requests from the merge queue in one day. `getByRole` reads the accessibility
// tree, which excludes the hidden copy, so every locator below starts from one
// (`docs/decisions/page-rooted-locator-disposition.md`, incident 7). The rows
// keep their test id, scoped to the live table rather than the page: the
// `row` role alone would also count the header row and each open disclosure.
const rows = (page: Page) =>
  page.getByRole('table', { name: 'To approve' }).getByTestId(/^approval-row-/);

/** The empty state's heading — an `<h2>`, so it has a role and a name. */
const emptyHeading = (page: Page, name: string) => page.getByRole('heading', { name });

/** The approval overlay (§ 22), named from its read answering — so waiting on the
 *  NAMED dialog is the authoritative signal that the gate arrived. */
const approvalDialog = (page: Page, key: string) =>
  page.getByRole('dialog', { name: `Design result for ${key}` });

test.describe('every decision waiting on you, in one place', () => {
  let seed: ApprovalsTabSeed;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedApprovalsTab(`s${Date.now().toString(36)}`);
  });

  test('a waiting design is answered from the tab, and the surface agrees with itself', async ({
    page,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    // The receipt belongs to the STORY, not to this subtask.
    acceptanceStory('MOTIR-4879');

    await servePrivateObjectStore(page);

    const client = await agentSession(seed.token, baseURL!);
    const published = await publish(client, seed.designKey);
    expect(published.isError ?? false).toBe(false);

    await chapter('An agent publishes a design, and the reviewer just signs in', async () => {
      await signIn(page, seed.reviewerEmail, seed.password);
      // The strip says there is something waiting BEFORE anybody navigates to
      // it — which is the whole difference between a queue and a folder.
      await expect(page.getByRole('link', { name: /To approve/ })).toBeVisible();
      expect(await badgeCount(page)).toBe(1);
    });

    await chapter('The tab says what is waiting, and which design it is about', async () => {
      await page.goto('/workbench?tab=approvals');
      await expect(page.getByRole('link', { name: /To approve/ })).toHaveAttribute(
        'aria-current',
        'page',
      );

      await expect(rows(page)).toHaveCount(1);
      await expect(rows(page).getByText('Design result')).toBeVisible();
      await expect(
        // Anchored on the key: since MOTIR-5225 the whole-row door is a link too,
        // named `Review <KEY> <title>`, and an unanchored match finds both.
        rows(page).getByRole('link', { name: new RegExp(`^${seed.designKey}`) }),
      ).toBeVisible();

      // ⚠️ THE BADGE AND THE ROWS, IN THE SAME PAGE STATE. Two reads a render
      // apart would pass against a surface whose count and list disagree.
      expect(await badgeCount(page)).toBe(await rows(page).count());
    });
    await beat();

    const dialog = approvalDialog(page, seed.designKey);

    await chapter(
      'Opening the row shows the design itself, full screen, over the tab',
      async () => {
        // ⚠️ RE-SCOPED by MOTIR-5225 (Story MOTIR-5214): the row no longer
        // discloses the frame inside the list, it opens the approval OVERLAY
        // over the tab. `exact`, because a substring match finds TWO things in
        // this row: the whole-row door (labelled `Review <KEY> <title>`) and the
        // visible button.
        await rows(page).first().getByRole('button', { name: 'Review', exact: true }).click();
        await expect(dialog).toBeVisible();
        // The tab is never left: the address only gains the overlay's two
        // parameters.
        await expect(page).toHaveURL(
          (url) =>
            url.pathname === '/workbench' &&
            url.searchParams.get('tab') === 'approvals' &&
            url.searchParams.get('approval') === seed.designKey &&
            url.searchParams.get('approvalKind') === 'design_result',
        );
        await expect(dialog.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
      },
    );
    await beat();

    await chapter('Approving it clears the row, the badge and the card together', async () => {
      await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
      // The confirm band — approving a design is TERMINAL, so it asks once, and
      // says what it is about to do before it does it.
      await expect(dialog.getByText('Approving this will:')).toBeVisible();
      await dialog.getByRole('button', { name: 'Yes, Approve' }).click();
      // AUTHORITATIVE: this pill is rendered from the gate row the decide action
      // RETURNED — true only once the server has recorded the decision.
      await expect(dialog.getByText('Approved', { exact: true })).toBeVisible();

      // Back to the tab, through the overlay's one close.
      await dialog.getByRole('button', { name: /^Close/ }).click();
      await expect(dialog).toBeHidden();
      await expect(page).toHaveURL(
        (url) => url.pathname === '/workbench' && url.search === '?tab=approvals',
      );

      // AUTHORITATIVE: the row count reaching zero, never a timeout.
      await expect(rows(page)).toHaveCount(0, { timeout: 30_000 });
      // …and the badge agrees IN THAT SAME STATE.
      expect(await badgeCount(page)).toBe(0);
      await expect(emptyHeading(page, 'Nothing is waiting on your approval')).toBeVisible();
    });
    await beat();

    await chapter('And the work it was holding is done', async () => {
      // The half that lives outside the page entirely — and the reason the
      // decision is worth anything.
      await expect
        .poll(
          async () =>
            (
              await adminDb.workItem.findUniqueOrThrow({
                where: { id: seed.designId },
                select: { status: true },
              })
            ).status,
          { timeout: 30_000 },
        )
        .toBe('done');
    });
  });

  test('a reader it is NOT routed to is told so, rather than shown an empty box', async ({
    page,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-4879');

    await signIn(page, seed.readerEmail, seed.password);
    await page.goto('/workbench?tab=approvals');

    await expect(emptyHeading(page, 'Nothing is waiting on your approval')).toBeVisible();
    await expect(rows(page)).toHaveCount(0);
    // The badge is SUPPRESSED at zero rather than reading `0`.
    expect(await badgeCount(page)).toBe(0);

    // ⚠️ AND IN `zh`, ASSERTED THROUGH THE CATALOGUE'S OWN STRINGS — never by
    // checking an English one is absent, which passes on a blank page. The
    // `NEXT_LOCALE` cookie is the suite's own switch (`workbench.spec.ts`).
    await page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: page.url() }]);
    await page.goto('/workbench?tab=approvals');
    await expect(page.getByRole('link', { name: /待审批/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(emptyHeading(page, '没有等待你审批的工作')).toBeVisible();
    // The body is a `<p>`: the `paragraph` role carries no accessible name, so
    // it is narrowed by its text — still inside the accessibility tree.
    await expect(
      page.getByRole('paragraph').filter({ hasText: '需要你签字确认才能继续的工作会显示在这里。' }),
    ).toBeVisible();
    // Negatively too: the English literal must not be reachable on a `zh` page.
    await expect(page.getByText('Nothing is waiting on your approval')).toHaveCount(0);
  });

  test('a reader who may SEE a decision but not make it gets its state and no verbs', async ({
    page,
    baseURL,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-4879');
    await servePrivateObjectStore(page);

    // The viewer is a project `viewer` AND the assignee: ROUTED the gate by ADR
    // §2, and held out of deciding it by the kind's `work_item:edit` floor. No
    // other combination produces this row.
    const client = await agentSession(seed.token, baseURL!);
    const viewerCard = await adminDb.workItem.findUniqueOrThrow({
      where: { id: seed.viewerDesignId },
      select: { identifier: true },
    });
    expect((await publish(client, viewerCard.identifier)).isError ?? false).toBe(false);

    await signIn(page, seed.viewerEmail, seed.password);
    await page.goto('/workbench?tab=approvals');

    await expect(rows(page)).toHaveCount(1);
    // The row is THERE and says what it is …
    await expect(rows(page).getByText('Design result')).toBeVisible();
    // … and offers nothing to press, here or inside.
    await expect(rows(page).getByRole('button', { name: 'Review', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);

    // ⚠️ But the LOOK is not withheld (MOTIR-5225): the row still opens the
    // approval — here by keyboard, which takes the same path as a plain click —
    // and the overlay draws the design with no verbs.
    await rows(page)
      .first()
      .getByRole('link', { name: /^Review / })
      .press('Enter');
    const dialog = approvalDialog(page, viewerCard.identifier);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Request changes' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  });

  test('past one page it inherits the shipped pager, and page two holds different rows', async ({
    page,
    baseURL,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-4879');

    const client = await agentSession(seed.token, baseURL!);
    expect((await publish(client, seed.designKey)).isError ?? false).toBe(false);
    // `HOME_PAGE_SIZE` is 25, so 25 filler gates plus the published one is a
    // boundary. See `approvals-tab-seed.ts` for why these are written directly.
    await plantFillerGates(seed, STORY_TITLE_EXPORT, 25);

    await signIn(page, seed.reviewerEmail, seed.password);
    await page.goto('/workbench?tab=approvals');

    await expect(rows(page)).toHaveCount(25);
    const firstPage = await rows(page).evaluateAll((nodes) =>
      nodes.map((n) => (n as HTMLElement).dataset['testid']),
    );

    await page.getByRole('button', { name: 'Page 2' }).click();

    await expect(page).toHaveURL(/tab=approvals&page=2/);
    await expect(rows(page)).toHaveCount(1);
    const secondPage = await rows(page).evaluateAll((nodes) =>
      nodes.map((n) => (n as HTMLElement).dataset['testid']),
    );
    // The window MOVED rather than being re-served.
    expect(secondPage.filter((id) => firstPage.includes(id))).toEqual([]);
  });
});
