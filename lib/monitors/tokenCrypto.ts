import { createTokenCrypto } from '@/lib/crypto/tokenCrypto';

// Error-monitor token encryption (Story MOTIR-4926 · MOTIR-5258). A monitor
// GRANT is an installed integration, not a pasted token: the provider's
// authorisation issues an access token that expires in hours plus a refresh
// token to mint the next one, and Motir MUST persist both to call the provider
// on the workspace's behalf later. Both are encrypted at rest with the shared
// AES-256-GCM `lib/crypto/tokenCrypto` — the same algorithm and the same
// versioned `v1.<iv>.<tag>.<ct>` format the GitHub identity store, the GitLab
// connection and the import-source store use.
//
// ⚠️ NO NEW CRYPTOGRAPHY IS INVENTED HERE, and that is the whole point of this
// file being three lines: the story's body flagged "does an at-rest encryption
// seam already exist?" as a precondition to verify, the answer is yes, and the
// correct discharge of a verified precondition is a re-export rather than a
// second implementation. `lib/github/tokenCrypto.ts` and
// `lib/gitlab/tokenCrypto.ts` are the same three lines.
//
// Keyed on `SENTRY_TOKEN_ENCRYPTION_KEY`, falling back to
// `GITHUB_TOKEN_ENCRYPTION_KEY` so a deployment that already wired GitHub can
// connect a monitor with zero new config (the same fallback GitLab and the
// import store use). The key is resolved at CALL time, never at module load, so
// a deployment that never configures a monitor does not crash on boot — the flow
// is simply unreachable.
//
// Only `monitorConnectionService` and the credential-lifecycle path read or
// write these values; nothing else touches a token's cryptographic shape.
export const { encryptToken, decryptToken } = createTokenCrypto([
  'SENTRY_TOKEN_ENCRYPTION_KEY',
  'GITHUB_TOKEN_ENCRYPTION_KEY',
]);
