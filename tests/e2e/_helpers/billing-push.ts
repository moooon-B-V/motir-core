import type { Page } from '@playwright/test';

// THE SEAT PUSH, as motir-ai's Stripe webhook makes it (Story MOTIR-6914 ·
// MOTIR-6924). `POST /api/internal/billing/ai-included-seat` is the one way
// motir-core learns an org's paid AI plan started or ended; the walk makes the
// same call, with the same bearer the webServer checks
// (`MOTIR_AI_TO_CORE_SERVICE_TOKEN`, set on both sides by
// `playwright.acceptance.config.ts`), so the lapse it records is the shipped path.

/** The motir-ai → motir-core bearer, one literal for the runner and the webServer. */
export const E2E_AI_TO_CORE_SERVICE_TOKEN = 'e2e-acceptance-ai-to-core-token';

/** Push the org's included seat on or off; resolves once motir-core answered 200. */
export async function pushAiIncludedSeat(
  page: Page,
  organizationId: string,
  included: boolean,
): Promise<void> {
  const res = await page.request.post('/api/internal/billing/ai-included-seat', {
    headers: { authorization: `Bearer ${E2E_AI_TO_CORE_SERVICE_TOKEN}` },
    data: { organizationId, included },
  });
  if (res.status() !== 200) {
    throw new Error(`the seat push answered ${res.status()}: ${await res.text()}`);
  }
}
