// Public entry for the Git provider seam (Story 7.10 · MOTIR-891). Importing
// this module registers every built-in provider (via each provider module's
// import side-effect) and re-exports the resolver, so a consumer does
// `import { getGitProvider } from '@/lib/git'` and is guaranteed the provider is
// registered before it resolves one. Import `@/lib/git` (never
// `@/lib/git/registry` directly) so the registration side-effects run.

import './providers/github'; // side-effect: registers the GitHub provider

export {
  getGitProvider,
  registerGitProvider,
  registeredGitProviderIds,
  UnknownGitProviderError,
} from './registry';
export type { GitProvider } from './provider';
export type {
  ChangeRequestLifecycle,
  ChangeRequestState,
  CiConclusion,
  GitProviderId,
  InstallationToken,
  NormalizedBranch,
  NormalizedChangeRequest,
  NormalizedRepo,
  NormalizedStatusEvent,
} from './types';
