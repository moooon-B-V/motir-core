import { test, expect } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  openAgentSession,
  publishDesignResult,
  seedDesignApproval,
  type DesignApprovalSeed,
} from './_helpers/design-approval-seed';

// THE APPROVAL OVERLAY'S SMOKE (Story MOTIR-5214 · Subtask MOTIR-5224).
//
// ⚠️ THIS IS AN ORDERING CHOICE, NOT A SECOND E2E. The overlay is the first thing
// in this story that RENDERS, and the class of defect living in the server/client
// seam — a client module importing across the render boundary, a hook read outside
// its Suspense boundary — is invisible to a type-check, to a production build and
// to a component's own unit suite. So this card lands the one instrument that
// OPENS the surface, and every later card in the story is built on a page
// something has proven can render. The story's own walk (MOTIR-5227) is the E2E.
//
// It opens the overlay the only way this card ships — BY ITS ADDRESS — over an
// ordinary authed page, asserts one landmark of the frame, and closes it back to
// that page. The gate is PUBLISHED for real through `publish_design_result`, as
// `design-approval.spec.ts` does, because the `awaiting` gate is created by the
// publish path and a seeded row would be an assertion about a row the product did
// not make.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): the dialog's accessible name is set
// from the overlay's READ answering — it is "Loading the approval" until then —
// so waiting on the named dialog IS the authoritative signal. No `waitForTimeout`.

test.describe.configure({ timeout: 180_000 });

test.describe('the approval overlay opens by its address', () => {
  let seed: DesignApprovalSeed;

  test.beforeEach(async () => {
    await resetDatabase();
    seed = await seedDesignApproval('overlay-smoke');
  });

  test('over the page you are on, and closes back to exactly that page', async ({
    page,
    baseURL,
  }) => {
    const client = await openAgentSession(seed.token, baseURL!);
    const published = await publishDesignResult(client, seed.designKey);
    expect(published.isError ?? false, JSON.stringify(published.content)).toBe(false);
    await client.close();

    await signIn(page, seed.reviewerEmail, seed.password);
    const host = `/items/${seed.dependentKey}`;
    await page.goto(`${host}?approval=${seed.designKey}&approvalKind=design_result`);

    const dialog = page.getByRole('dialog', { name: `Design result for ${seed.designKey}` });
    await expect(dialog).toBeVisible();
    // Band 1 of the shared frame — the one visible "Design result" (§ 22).
    await expect(dialog.getByText('Design result', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'Open work item' })).toHaveAttribute(
      'href',
      `/items/${seed.designKey}`,
    );

    await dialog.getByRole('button', { name: /^Close/ }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL((url) => url.pathname === host && url.search === '');
    // The page underneath was never left.
    await expect(page.getByRole('heading', { name: seed.dependentTitle })).toBeVisible();
  });
});
