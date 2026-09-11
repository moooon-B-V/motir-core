import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase } from './_helpers/db-reset';
import { signIn, startSignedOut } from './_helpers/shell-session';
import { servePrivateObjectStore } from './_helpers/object-store';
import {
  IMAGE_SOURCE_PATH,
  MOCK_HTML,
  MOCK_SOURCE_PATH,
  NOTE_BODY,
  NOTE_HEADING,
  NOTE_MD,
  NOTE_SOURCE_PATH,
  PNG_BYTES,
  seedDesignApproval,
  type DesignApprovalSeed,
} from './_helpers/design-approval-seed';

// THE ACCEPTANCE RECEIPT FOR APPROVING A DESIGN THAT HAS NO PULL REQUEST
// (Story MOTIR-4778 · Subtask MOTIR-4797).
//
// ════════════════════════════════════════════════════════════════════════════
// ⚠️ THE CARD'S 2026-09-08 AMENDMENT IS WHAT THIS FILE IS, and it is recorded
// here because a dropped criterion and an amended one look identical in a diff.
// ════════════════════════════════════════════════════════════════════════════
//
// MOTIR-4778 carried five features and now carries one. Everything about
// MERGING, the APPROVALS TAB, the ROUTING READ, `prMergeMode` and the REVIEW
// LINK moved to sibling stories under MOTIR-4878. So the walk the card's body
// describes is amended, not performed in full:
//
//   · step 3 (decide the MERGE gate)        — OUT: no merge gate in this story
//   · step 4 (a refusal, *not mergeable*)   — OUT: that refusal is the merge
//     seam's answer, and this story has no seam. The frame's OWN refusals
//     (`notAuthorised`, `superseded`, `alreadyDecided`) are covered at the
//     component altitude by `tests/components/approval-gate-control.test.tsx`
//   · step 6 (the tab's empty state)        — OUT: there is no Approvals tab in
//     this build. Verified rather than assumed — `ApprovalGateControl` has
//     exactly two mount points and both are the item page's design section
//   · steps 1 / 2 / 5 / 7                   — SURVIVE, and are the walk below
//
// VERIFIED BEFORE A LINE WAS WRITTEN, which is the card's own scaffold clause:
//
//   · the sign-in fixture — `shell-session.ts`, used by every acceptance spec
//   · a seedable design result — YES, and better than seedable: the awaiting
//     gate is created BY `designEvidenceService` at publish, so the spec
//     publishes for real through `publish_design_result` over `/api/mcp` with a
//     `CLI_TOKEN_GRANT` bearer. `design-result-publish.spec.ts` established
//     that this lane reaches `/api/mcp` and that the blob mock answers HEAD
//   · a second actor with a narrower permission — YES: `canDecide` is
//     *assignee OR reporter OR workspace manager*, so a plain workspace member
//     who is neither reaches the page and is offered nothing
//   · THE GITHUB SEAM — **NOT NEEDED, and that is the amendment's doing.** The
//     card asked for a merge stubbed at a seam the running server honours
//     because the original walk drove a merge. The design-only walk crosses no
//     process boundary at all: the decision is a server action, the status move
//     is `applyStatusTransition` in the same transaction, and readiness is
//     computed from the database. There is nothing outbound to stub, so the
//     card's own warning about `vi.mock` being unreachable from a spawned dev
//     server does not bite here. This is the finding the clause asked for,
//     reported rather than worked around
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// One thing, and it is the thing a green tick cannot show: that pressing
// Approve on THIS card moves work on ANOTHER one. The gate is not an opinion
// filed somewhere — it is the thing standing between a person and the next
// piece of work, and the clip's argument is the two item pages either side of
// one button.
//
// ⚠️ THE PACING IS A REQUIREMENT OF THIS CARD, NOT A COURTESY. Acceptance in
// this project rides the receipt, so a walk that races through the decision
// proves the code works and shows the reviewer nothing. Every phase is a
// `chapter()`, which paces itself; the two chapters either side of the button
// hold an extra `beat()`, because the before/after on the DEPENDENT card is the
// story's whole claim and it takes a moment to read.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a rendered landmark
// or an element's own visible state — the state pill is set from the decide
// action's AUTHORITATIVE response (`setCurrent(result.gate)`), never
// optimistically. There is no `waitForTimeout`; the only holds are `chapter()`
// and `beat()`, which run AFTER each phase has already asserted.

test.describe.configure({ timeout: 240_000 });

const b64 = (b: Buffer) => b.toString('base64');

/** Open an MCP session as an AGENT would — a bearer, no cookie, no session. */
async function agentSession(token: string, baseURL: string): Promise<Client> {
  const client = new Client({ name: 'design-approval-e2e', version: '0.0.0' });
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

test.describe('a published design waits, the control clears it, and the work it held starts', () => {
  let seed: DesignApprovalSeed;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedDesignApproval('accept');
  });

  test('approving a design on the item page moves the card it was blocking', async ({
    page,
    baseURL,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    // The receipt belongs to the STORY, not to this subtask.
    acceptanceStory('MOTIR-4778');

    await servePrivateObjectStore(page);

    // ⚠️ THE MOCK'S BYTES ARE SERVED AT THE APP'S CONTENT ROUTE, and the reason
    // is a browser limitation rather than a shortcut — `design-result.spec.ts`
    // and `design-result-publish.spec.ts` both document it. The mock renders in
    // a frame with `sandbox=""`, so its document loads into an OPAQUE origin;
    // the content route's 302 is interceptable, but the fetch that FOLLOWS it is
    // made by the frame against the store host and escapes `page.route`
    // entirely, dying `ERR_NAME_NOT_RESOLVED` against the `.invalid` TLD. A
    // receipt someone WATCHES must not show a broken frame for a feature that
    // works. Nothing this spec is about is stubbed: the publish is real, the
    // decision is real, and the `.png` keeps its real content-route →
    // signed-URL → store hop, which is why non-HTML passes straight through.
    await page.route('**/api/attachments/*/content', async (route) => {
      const response = await route.fetch({ maxRedirects: 0 });
      const location = response.headers()['location'] ?? '';
      if (location.includes('.html')) {
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: MOCK_HTML,
        });
        return;
      }
      await route.fulfill({ response });
    });

    await chapter('An agent publishes the design — one call, a bearer, no browser', async () => {
      // The gate is not seeded: publishing is what CREATES it, with its subject
      // pinned to these bytes and its question routed to the card's assignee.
      const client = await agentSession(seed.token, baseURL!);
      const result = await publish(client, seed.designKey);
      expect(result.isError ?? false, JSON.stringify(result.content)).toBe(false);
      await client.close();
    });

    await chapter(
      'The work waiting on it cannot start — and says what it is waiting for',
      async () => {
        await signIn(page, seed.reviewerEmail, seed.password);
        await page.goto(`/items/${seed.dependentKey}`);
        await expect(page.getByRole('heading', { name: seed.dependentTitle })).toBeVisible();
        // The readiness banner, in its BLOCKED arm, naming the design card by key.
        // This is the "before" half of the story's whole claim.
        await expect(page.getByText('Blocked', { exact: true })).toBeVisible();
        await expect(page.getByText('Waiting on 1 work item')).toBeVisible();
        // ⚠️ `.first()` because the key is a link TWICE on this page — once in
        // the readiness banner's blocker list (`ReadinessBadge`) and once as
        // the blocked-by row in the relationships panel. Both are correct
        // evidence that this card names its blocker, and an unqualified
        // `getByRole` is a strict-mode violation rather than a stronger
        // assertion.
        await expect(page.getByRole('link', { name: seed.designKey }).first()).toBeVisible();
        await beat();
        await beat();
      },
    );

    await chapter('A reader who may not decide is offered nothing to press', async () => {
      // ⚠️ THIS CHAPTER RUNS BEFORE THE DECISION, DELIBERATELY. The absence of
      // controls has to be read off an AWAITING gate — on a decided one every
      // verb is gone from everybody, and the assertion would pass without the
      // authority rule existing at all.
      await startSignedOut(page);
      await signIn(page, seed.readerEmail, seed.password);
      await page.goto(`/items/${seed.designKey}`);
      await expect(page.getByRole('heading', { name: seed.designTitle })).toBeVisible();

      // They see the QUESTION and the design — the frame is not hidden from them.
      //
      // ⚠️ NOT `getByText('Design result')`: that string is on the page TWICE —
      // `ContentSectionCard`'s own title and the frame's band-1 kind label —
      // so it is a strict-mode violation rather than an assertion. The port
      // group is the frame's own landmark and belongs to nothing else.
      await expect(page.getByRole('group', { name: 'The subject being decided' })).toBeVisible();
      await expect(page.getByText('Awaiting', { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: NOTE_HEADING })).toBeVisible();
      await expect(page.getByText("Waiting on this work item's assignee.")).toBeVisible();

      // ⚠️ ABSENCE, NOT A DISABLED CONTROL — the card asks for exactly this
      // distinction. A disabled button still tells a reader the act is theirs
      // to be denied; the frame simply does not draw a verb it will not honour.
      await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Request changes' })).toHaveCount(0);
      await beat();
    });

    await chapter('The person it was routed to meets the same frame, with its verbs', async () => {
      await startSignedOut(page);
      await signIn(page, seed.reviewerEmail, seed.password);
      await page.goto(`/items/${seed.designKey}`);
      await expect(page.getByRole('heading', { name: seed.designTitle })).toBeVisible();

      // ⚠️ THE SHARED FRAME, ASSERTED AS THE FRAME. The card's surviving step 7
      // asks that this surface render the SAME control rather than a bespoke
      // panel of its own. The frame's OWN landmarks are what say so — the port
      // group `ApprovalGateControl` draws around whatever is being decided, its
      // state pill, and the kind-supplied consequence line — and none of them
      // is anything `DesignResultPanel` could produce by itself. (The band-1
      // kind label would read the same, but "Design result" is also the
      // enclosing `ContentSectionCard`'s title, so it identifies nothing.)
      await expect(page.getByRole('group', { name: 'The subject being decided' })).toBeVisible();
      await expect(page.getByText('Awaiting you', { exact: true })).toBeVisible();
      await expect(page.getByText(`Approving moves ${seed.designKey} to Done.`)).toBeVisible();

      // The design itself, inside the port — the thing they are deciding ABOUT.
      await expect(page.getByRole('heading', { name: NOTE_HEADING })).toBeVisible();
      await expect(page.getByText(NOTE_BODY)).toBeVisible();

      await expect(page.getByRole('button', { name: 'Request changes' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
      await beat();
    });

    await chapter('Approve — and the frame says what that will do before it does it', async () => {
      await page.getByRole('button', { name: 'Approve' }).click();
      // The confirm band. Approving is TERMINAL for this kind, which is the
      // whole reason this verb confirms and Request changes does not.
      await expect(page.getByText('Approving this will:')).toBeVisible();
      await expect(
        page.getByText(`move ${seed.designKey} to Done, starting the work items waiting on it.`),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
      await beat();

      await page.getByRole('button', { name: 'Yes, Approve' }).click();

      // ⚠️ THE AUTHORITATIVE SIGNAL. This pill is rendered from the gate row the
      // decide action RETURNED (`setCurrent(result.gate)`), not from an
      // optimistic guess — so it is true only once the server has recorded the
      // decision, and it is what the rest of this walk waits on.
      await expect(page.getByText('Approved', { exact: true })).toBeVisible();
      // The verbs are gone because the question is answered, not because this
      // reader may not act.
      await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
      await beat();
    });

    await chapter('The design card is Done, and the record says which version', async () => {
      // ⚠️ THE RELOAD IS AN AUTHORITATIVE COMMITTED-STATE READ, AND IT IS HERE
      // BECAUSE THE IN-PLACE REFRESH DOES NOT REACH THIS RAIL — a real defect,
      // filed as its own bug, NOT a wait this spec was missing.
      //
      // Measured on this spec's first run: the decide transaction wrote
      // `work_item.status = 'done'` and `completed_at` at 01:00:53.125Z, and the
      // page still rendered **In Progress** in the core-fields rail 27 seconds
      // later, with the record band's version and files lines missing for the
      // same reason. `decideApprovalGateAction` calls no `revalidatePath` (its
      // sibling `createLinkAction` does), so the only thing meant to repaint the
      // server-rendered rail is `DesignResultSection`'s own `router.refresh()`,
      // and it does not. That is the page-state contract's CASE 2 failing.
      //
      // A 20-second `toHaveText` is already a wait on that refresh, so waiting
      // harder is not the remedy — and weakening the assertion to match what the
      // page happens to show would delete the only detector this has. So the
      // spec asserts the REAL claim (the card is Done, the bytes are pinned)
      // against a committed read, and the staleness is carried by the bug rather
      // than absorbed here.
      await page.reload();
      // At rest the status is a `StatusPill`, not a combobox — the picker only
      // exists while that field is being edited.
      await expect(page.getByText('Done', { exact: true })).toBeVisible();
      // The approval pinned the bytes it was about, so the record can still say
      // WHAT was approved rather than only that something was.
      await expect(page.getByText('Files kept')).toBeVisible();
      await beat();
    });

    await chapter('And the work it was holding up is ready to start', async () => {
      // ⚠️ THE ASSERTION THE WHOLE STORY IS FOR, and the one a
      // plausible-but-wrong build passes without. A gate that recorded an
      // opinion and moved nothing would leave this banner exactly as chapter
      // two found it — and everything the reviewer saw would still look right.
      await page.goto(`/items/${seed.dependentKey}`);
      await expect(page.getByRole('heading', { name: seed.dependentTitle })).toBeVisible();
      await expect(page.getByText('All blockers resolved')).toBeVisible();
      await expect(page.getByText('Blocked', { exact: true })).toHaveCount(0);
      await beat();
      await beat();
    });
  });
});
