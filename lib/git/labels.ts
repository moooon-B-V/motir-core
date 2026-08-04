// Human-facing labels for provider-agnostic concepts (MOTIR-1873). The seam
// normalizes a PR and an MR into ONE `NormalizedChangeRequest`, which is exactly
// right for logic and wrong for prose: a comment Motir posts on a work item is
// read by someone looking at GitHub or at GitLab, and it should use their host's
// word. Kept here — beside the types the noun describes — so every consumer that
// writes about a change request says the same thing (`changeRequestStatusSync`'s
// stranded-merge note and `changeRequestCiFeedback`'s CI note both do).

import type { GitProviderId } from './types';

/** The host's noun for a change request — a GitHub `pull request`, a GitLab
 *  `merge request` — so a posted comment reads naturally on either host. */
export function changeRequestNoun(provider: GitProviderId): string {
  return provider === 'gitlab' ? 'merge request' : 'pull request';
}
