import { createTokenCrypto } from '@/lib/crypto/tokenCrypto';

// GitLab token encryption (Story 7.23 · MOTIR-1474). GitLab's OAuth grant issues
// an access + refresh token per connection that we MUST persist (unlike GitHub's
// mint-on-demand model) — so both are encrypted at rest with the shared
// AES-256-GCM `lib/crypto/tokenCrypto` (the same algorithm/format the GitHub
// identity store and the import-source store use). Only `gitlabConnectionService`
// reads/writes these; nothing else touches the tokens' cryptographic shape.
//
// Keyed on `GITLAB_TOKEN_ENCRYPTION_KEY`, falling back to
// `GITHUB_TOKEN_ENCRYPTION_KEY` so a deployment that already wired GitHub can
// connect GitLab with zero new config (the same fallback the import store uses).
export const { encryptToken, decryptToken } = createTokenCrypto([
  'GITLAB_TOKEN_ENCRYPTION_KEY',
  'GITHUB_TOKEN_ENCRYPTION_KEY',
]);
