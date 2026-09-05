// WHERE A GIT CONNECT FLOW RETURNS TO (Story MOTIR-4669 · MOTIR-4676).
//
// The OAuth identity grant and the App-install setup handler both redirect back
// with `?github=<status>`, and both used to land on a hard-coded
// `/settings/workspace/github` — because that page was historically the only
// place either flow could BEGIN. Once *connect a new one* starts from a
// project's Repositories room or from the organisation's Git page, a user
// connects a repository and is dropped on a settings page they never asked for,
// wondering whether it worked.
//
// ⚠️ THE RETURN TARGET IS AN ID, NEVER A PATH — and that is the whole security
// design rather than a stylistic choice. A redirect target resolved from a
// string that reached us from outside is an open redirect, and every mitigation
// for one (scheme checks, `//` checks, host allow-lists, normalisation) is a
// filter somebody has to get exactly right. An ID cannot express an absolute
// URL, a protocol-relative URL, a backslash, a userinfo `@`, or a path
// traversal: `resolveReturnPath` is a lookup in the frozen map below, and
// anything absent from it resolves to the default. There is no string to
// sanitise because there is no string.
//
// Two carriers, because the two flows have different shapes, and the
// difference is worth stating where it is decided:
//
//   · THE OAUTH GRANT starts with a request to Motir, so it can set a cookie —
//     and the origin therefore never leaves this server at all. It rides in the
//     httpOnly state cookie beside the CSRF nonce (`app/api/github/oauth/start`).
//     A value that never takes the round trip cannot be tampered with on it.
//   · THE APP INSTALL starts from a bare `github.com/apps/<slug>/…` URL with no
//     request to Motir, so no cookie can be set (`installState.ts` says so). The
//     origin has to travel, so it travels INSIDE the signed install-state
//     envelope, where it is covered by the same HMAC as the workspace and user.
//
// Either way the value that is read back is an id from this map, and either way
// an absent or unknown one falls back to `DEFAULT_RETURN_PATH`.

/** Every surface a git connect flow may return to, id → in-app path. */
export const GITHUB_RETURN_SURFACES = {
  /** Settings → Workspace → Git, GitHub variant. The historical landing. */
  workspaceGithub: '/settings/workspace/github',
  /** Settings → Workspace → Git, GitLab variant. */
  workspaceGitlab: '/settings/workspace/gitlab',
  /** Settings → Project → Repositories — the room the `Add repository` picker
   *  lives in (MOTIR-4674 draws it, MOTIR-4681 builds it). */
  projectRepositories: '/settings/project/repositories',
  /** Settings → Organisation → Git — the org's repository inventory.
   *  ⚠️ The ROUTE lands in MOTIR-4680, a sibling under this same story. The id
   *  is registered here rather than later because the two halves of a return
   *  belong in one map; it is unreachable until then BY CONSTRUCTION, since the
   *  only thing that sets an origin is the surface that STARTS the flow, and
   *  that surface is what MOTIR-4680 builds. */
  organizationGit: '/settings/organization/git',
  /** Settings → Account → Git accounts — the member's own credential.
   *  ⚠️ Same note: the route lands in MOTIR-4682. */
  accountGit: '/settings/account/git',
} as const;

export type GithubReturnSurfaceId = keyof typeof GITHUB_RETURN_SURFACES;

/** Where a flow lands when it carries no origin, or one we do not recognise.
 *  This is exactly the path both routes hard-coded before MOTIR-4676, so an
 *  in-flight round trip that started before the deploy is unchanged. */
export const DEFAULT_RETURN_PATH = GITHUB_RETURN_SURFACES.workspaceGithub;

const SURFACE_IDS = new Set<string>(Object.keys(GITHUB_RETURN_SURFACES));

/** Narrow an untrusted string to a known surface id, or `null`.
 *
 *  Everything that is not a key of the map is `null` — including an absolute
 *  URL, a protocol-relative URL, a path, and a path with traversal in it. The
 *  refusal is a set membership test, so it cannot be defeated by an encoding
 *  the way a prefix or scheme check can. */
export function parseReturnSurfaceId(
  value: string | null | undefined,
): GithubReturnSurfaceId | null {
  if (typeof value !== 'string' || !SURFACE_IDS.has(value)) return null;
  return value as GithubReturnSurfaceId;
}

/** The in-app path a flow returns to. Anything unrecognised — absent, unknown,
 *  or an attempt at a URL — resolves to `DEFAULT_RETURN_PATH`. */
export function resolveReturnPath(value: string | null | undefined): string {
  const id = parseReturnSurfaceId(value);
  return id ? GITHUB_RETURN_SURFACES[id] : DEFAULT_RETURN_PATH;
}
