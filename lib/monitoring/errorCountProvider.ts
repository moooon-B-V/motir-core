import 'server-only';

import { isE2EProdHarness } from '@/lib/e2eProdHarness';
import { type ErrorCountReader, httpErrorCountReader } from './sentryErrorCount';

// THE ERROR-COUNT BINDING (MOTIR-740) — the same shape as
// `lib/publicAddresses/providers.ts` and `lib/gateway/statusProvider.ts`: one
// place chooses between the real Sentry client and an in-memory fake, so the
// story's E2E lane can film a populated Errors card with no Sentry behind it.
//
// ⚠️ THE FAKE CANNOT ARM IN A REAL PRODUCTION BUILD. A fake that reports a calm
// error count in production would paint the card green during an error spike —
// the exact failure this card exists to end. So the flag is read at call time and
// refused when `NODE_ENV === 'production'` unless the E2E harness is ALSO set
// (`lib/e2eProdHarness.ts`, set by a Playwright config and nothing else).

const FAKE_FLAG = 'MOTIR_E2E_FAKE_ERROR_COUNT';

/** Is the in-memory binding armed? Never true in a real production build. */
export function usingFakeErrorCount(): boolean {
  if (process.env.NODE_ENV === 'production' && !isE2EProdHarness()) return false;
  return process.env[FAKE_FLAG] === '1';
}

/**
 * The fake: configured, and a fixed count well under the threshold. Happy path
 * only — the failure arms are proved at the service tier with a stubbed reader.
 */
const fakeErrorCountReader: ErrorCountReader = {
  configured: () => true,
  read: async () => ({ count: 7, projectId: '0', org: 'e2e' }),
  // No Sentry stands behind the fake, so there is no page to send anyone to.
  issuesUrl: () => null,
};

/** The reader this deployment should use. */
export function errorCountReader(): ErrorCountReader {
  return usingFakeErrorCount() ? fakeErrorCountReader : httpErrorCountReader;
}
