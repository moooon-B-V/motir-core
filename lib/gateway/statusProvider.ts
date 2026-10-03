import 'server-only';

import { isE2EProdHarness } from '@/lib/e2eProdHarness';
import { type GatewayStatusReader, httpGatewayStatusReader } from './statusClient';

// THE GATEWAY STATUS BINDING (MOTIR-742) — the same shape as
// `lib/publicAddresses/providers.ts`: one place chooses between the real client
// and an in-memory fake, so the story's E2E lane can film a populated Gateway
// card without a gateway behind it.
//
// ⚠️ THE FAKE CANNOT ARM IN A REAL PRODUCTION BUILD. A fake that reports a
// healthy gateway in production would paint the card green while every coding
// run fails — the exact blindness this card exists to end. So the flag is read at
// call time and refused when `NODE_ENV === 'production'` unless the E2E harness
// is ALSO set (`lib/e2eProdHarness.ts`, set by a Playwright config and nothing
// else): arming it in a real deployment takes two misconfigurations, not one.

const FAKE_FLAG = 'MOTIR_E2E_FAKE_GATEWAY_STATUS';

/** Is the in-memory binding armed? Never true in a real production build. */
export function usingFakeGatewayStatus(): boolean {
  if (process.env.NODE_ENV === 'production' && !isE2EProdHarness()) return false;
  return process.env[FAKE_FLAG] === '1';
}

/**
 * The fake: a gateway that is configured and answers healthily.
 *
 * Happy path only, deliberately — the failure arms are proved at the service
 * tier with a stubbed reader, where a test can hand the service any outcome
 * directly. The lane's job is to show the card populated.
 */
const fakeGatewayStatusReader: GatewayStatusReader = {
  configured: () => true,
  read: async () => ({
    latencyMs: 42,
    version: 'v0.0.0-e2e',
    startTime: '2026-01-01T00:00:00.000Z',
  }),
  // No gateway stands behind the fake, so there is no page to send anyone to.
  statusUrl: () => null,
};

/** The reader this deployment should use. */
export function gatewayStatusReader(): GatewayStatusReader {
  return usingFakeGatewayStatus() ? fakeGatewayStatusReader : httpGatewayStatusReader;
}
