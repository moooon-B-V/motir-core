import { createTokenCrypto } from '@/lib/crypto/tokenCrypto';

// GitHub user-access-token crypto (Story 7.10 · MOTIR-1498). The AES-256-GCM
// implementation moved to the generic `lib/crypto/tokenCrypto.ts` (Story 7.16 ·
// MOTIR-1653) so the import-source OAuth store reuses the exact same
// algorithm/format. This module is now just the GitHub-keyed instance — the
// serialized form and the `GITHUB_TOKEN_ENCRYPTION_KEY` env var are unchanged,
// so every existing caller (githubIdentityService) works byte-for-byte.

const ENV_KEY = 'GITHUB_TOKEN_ENCRYPTION_KEY';

const githubTokenCrypto = createTokenCrypto(ENV_KEY);

/** Encrypt a GitHub user access token into the versioned `v1.<iv>.<tag>.<ct>` form. */
export const encryptToken = githubTokenCrypto.encryptToken;
/** Decrypt a value produced by {@link encryptToken}. Throws on tamper / wrong key. */
export const decryptToken = githubTokenCrypto.decryptToken;
