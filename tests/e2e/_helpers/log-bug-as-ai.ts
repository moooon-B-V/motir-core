import type { Page } from '@playwright/test';

// THE PLANNER'S `log_bug`, as motir-ai makes it (Story MOTIR-7797 · MOTIR-7809).
//
// motir-ai has no presence in the acceptance lane, so a spec that needs a
// planning run to FILE a bug plays motir-ai through the REAL route —
// `POST /api/internal/ai/log-bug` — with the two credentials motir-ai's
// `buildBugFilingSink` presents:
//
//   - the §4a SERVICE bearer, `CORE_CALLBACK_SECRET`, set on the webServer by
//     `playwright.acceptance.config.ts` from the literal below; and
//   - the §4b JOB TOKEN, the `readBackToken` motir-core minted into the submit's
//     envelope, which `lib/test-ai-jobs-mock.ts` records beside the job id it
//     answered with.
//
// Nothing is seeded into the bug table: the route, the service, its cap under
// the plan's row lock and its `bug_filed` trail row all run as shipped.

/** The ai → core service bearer (`CORE_CALLBACK_SECRET`), one literal for the
 *  runner and the webServer. */
export const E2E_CORE_CALLBACK_SECRET = 'e2e-acceptance-core-callback-secret';

export interface LogBugAsAiInput {
  /** The job token the submit's envelope carried. */
  readBackToken: string;
  /** The job the filing counts against — its plan's `sourceJobId`. */
  jobId: string;
  title: string;
  descriptionMd: string;
  explanationMd?: string;
}

/** File ONE bug through the log-bug route; resolves with the 201 body's key. */
export async function logBugAsAi(page: Page, input: LogBugAsAiInput): Promise<string> {
  const { readBackToken, ...body } = input;
  const res = await page.request.post('/api/internal/ai/log-bug', {
    headers: {
      authorization: `Bearer ${E2E_CORE_CALLBACK_SECRET}`,
      'x-motir-job-token': readBackToken,
    },
    data: body,
  });
  if (res.status() !== 201) {
    throw new Error(`log-bug answered ${res.status()}: ${await res.text()}`);
  }
  const filed = (await res.json()) as { key?: unknown };
  if (typeof filed.key !== 'string') {
    throw new Error(`log-bug's 201 carried no key: ${JSON.stringify(filed)}`);
  }
  return filed.key;
}
