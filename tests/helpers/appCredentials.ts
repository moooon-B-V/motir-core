import { generateKeyPairSync } from 'node:crypto';
import { vi } from 'vitest';
import type { GithubAppRole } from '@/lib/github/appAuth';

/** Wire the GitHub App credentials the installation-token mint needs.
 *
 *  ⚠️ IT WIRES EXACTLY ONE OF THE TWO REGISTRATIONS, and the other is stubbed
 *  EMPTY rather than left alone. `resolveConfig` refuses on a falsy value, so an
 *  empty string is "not configured" — which is what lets a test assert that the
 *  caller reached the App it was supposed to reach, instead of reading an
 *  ambient one out of the environment and passing either way (MOTIR-5811).
 *
 *  ⚠️ SO THE ONE-APP ARM IS THE ASSERTION, NOT THE SETUP. A provenance test that
 *  wires BOTH registrations proves nothing: a mint that ignored provenance
 *  entirely would still produce a token and still pass. Wiring only the App the
 *  repository's provenance selects is what makes the wrong choice UNABLE to mint
 *  at all, so the test fails on the defect rather than on a later assertion about
 *  which credential was used.
 *
 *  ⚠️ AND A PROVENANCE TEST OWES A CONTROL (MOTIR-5843). Asserting only that a
 *  hosted repository reaches the provisioning App is satisfied by an
 *  implementation that ALWAYS mints through the provisioning App — which would
 *  break every real tenant. Pair each hosted case with a customer-owned one that
 *  must still resolve to `user-facing` WITH the provisioning org configured, so
 *  the two together pin the decision rather than one direction of it.
 *
 *  Lives here rather than in one spec because the provenance sweep needs it in
 *  several: the seam callers (MOTIR-5843) and the low-level callers (MOTIR-5861)
 *  assert the same property about different call sites. */
export function stubAppCredentials(app: GithubAppRole = 'user-facing') {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const hosted = app === 'provisioning';
  vi.stubEnv('GITHUB_APP_ID', hosted ? '' : '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', hosted ? '' : privateKey);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', hosted ? '888' : '');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', hosted ? privateKey : '');
}

/** Wire BOTH registrations, so a mint succeeds whichever App provenance selects.
 *
 *  This is the setup for a CONTROL: it removes "only one App is configured" as an
 *  explanation for the result, leaving the resolved role as the only thing that
 *  can decide which credential was used. Read the role back from the request the
 *  transport actually made (the App id in the signed JWT, or the stubbed mint's
 *  recorded argument) rather than from the token string, which carries no
 *  provenance of its own. */
/** The App id in the JWT the mint signed — `createAppJwt` puts `appId` in `iss`,
 *  so this reads back WHICH registration a call actually used.
 *
 *  Pass the `fetch` mock; it finds the `/access_tokens` request and decodes the
 *  bearer's payload. `null` when no mint was attempted. With
 *  `stubBothAppCredentials()` the ids are `USER_FACING_APP_ID` / `PROVISIONING_APP_ID`,
 *  which is what lets a CONTROL assert the user-facing App was chosen rather than
 *  merely that some token came back. */
export function mintedAppIds(fetchMock: { mock: { calls: unknown[][] } }): string[] {
  const ids: string[] = [];
  for (const call of fetchMock.mock.calls) {
    const url = String(call[0]);
    if (!url.endsWith('/access_tokens')) continue;
    const init = call[1] as { headers?: Record<string, string> } | undefined;
    const auth = init?.headers?.['authorization'] ?? '';
    const jwt = auth.replace(/^Bearer /, '');
    const payload = jwt.split('.')[1];
    if (!payload) continue;
    try {
      ids.push(String(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).iss));
    } catch {
      // A malformed bearer is a failure for the test to report as "no id", not a
      // throw that masks the assertion the caller is actually making.
    }
  }
  return ids;
}

/** The ids `stubAppCredentials` / `stubBothAppCredentials` wire, so a test names
 *  the App rather than a magic number. */
export const USER_FACING_APP_ID = '999';
export const PROVISIONING_APP_ID = '888';

export function stubBothAppCredentials() {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '888');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
}
