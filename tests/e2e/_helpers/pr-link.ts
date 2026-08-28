import { expect, type Page } from '@playwright/test';

// THE EXPLICIT DELIVERY LINK, for the E2E lane (Story MOTIR-3672).
//
// ⚠️ WHY EVERY SPEC THAT DRIVES A `pull_request` DELIVERY NOW NEEDS THIS. Until
// MOTIR-3674 a pull request found its card by PARSE — the head ref or the title
// naming a key was the association — so a spec could post a delivery titled
// `feat: ACME-7 …` and the sync would attribute it. That inference is retired:
// a pull request belongs to a card only by an explicit link, and a delivery
// without one resolves `no_work_item` and moves nothing. That is the story's
// first acceptance criterion, asserted precisely on a title carrying a real,
// resolvable key — which is exactly the shape these specs were written in.
//
// So a spec whose SUBJECT is the lifecycle (opened → Implemented, merged → Done,
// the repository-set hold, the CI feedback loop) declares the link as SETUP, and
// keeps asserting the lifecycle unchanged. A spec whose subject is the
// retirement itself asserts `no_work_item` instead and calls nothing here.
//
// The transport is `POST /api/_test/pull-request-links` — the shipped
// `linkPullRequestByCoordinates` reached over HTTP under the caller's real
// session, gated to non-production. It is not a shortcut past the link's rules:
// a card in another workspace, or a repository this workspace has not connected,
// is refused here exactly as at the MCP tool.

export interface E2ERepoRef {
  owner: string;
  name: string;
  defaultBranch: string;
}

/**
 * Link one pull request to one card, the way `link_pull_request` does.
 *
 * Call it BEFORE the delivery whose outcome the spec asserts. The sync reads the
 * STORED link when the delivery arrives, so a link written afterwards does not
 * retroactively move the card — the ordering is the product's, not the harness's.
 */
export async function linkPr(
  page: Page,
  args: {
    workItemId: string;
    repo: E2ERepoRef;
    number: number;
    headRef: string;
    baseRef?: string;
    title?: string | null;
  },
): Promise<void> {
  const res = await page.request.post('/api/_test/pull-request-links', {
    data: {
      workItemId: args.workItemId,
      owner: args.repo.owner,
      name: args.repo.name,
      number: args.number,
      headRef: args.headRef,
      baseRef: args.baseRef ?? args.repo.defaultBranch,
      title: args.title ?? null,
    },
  });
  // The body carries the refusal reason — a bare status sends the reader to the
  // server log to find out which of the link's several gates said no.
  expect(
    res.status(),
    `link ${args.repo.name}#${args.number} → ${(await res.text()).slice(0, 300)}`,
  ).toBe(201);
}
