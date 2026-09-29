import { INSTANCE_HOME_PATH, INSTANCE_WORKSPACE_PATH } from './config';

// THE CLONE, as ONE command run inside the instance (Story MOTIR-6860 ·
// MOTIR-6872). The project's repositories land in `$HOME/workspace/<name>` (§1 —
// the rootfs resets on every wake, the home does not).
//
// ⚠️ THE TOKEN TRAVELS IN ARGV ONLY, AND LEAVES NO TRACE. It is a short-lived,
// READ-scoped installation token (`mintProjectReadCredentials`), handed to git as
// a one-shot `-c http.<url>.extraheader` — so it is never in a remote URL (every
// `origin` is the plain `https://github.com/<owner>/<name>.git`), never written
// to `.git/config`, never in the machine's env or config, and never on the
// volume. The agent inside the instance therefore never inherits Motir's access;
// the user pushes with their own credential.
//
// IDEMPOTENT: a repository already cloned (its `.git` exists) is skipped, so a
// settle that runs twice clones nothing twice and a repository the user deleted
// on purpose is cloned again only on a fresh boot of a new instance.
//
// It runs as `node` (the image's user), so the files are the user's.

const SCRIPT = [
  'set -e',
  'auth="$1"; shift',
  `mkdir -p "${INSTANCE_WORKSPACE_PATH}"`,
  'for repo in "$@"; do',
  '  dest="' + INSTANCE_WORKSPACE_PATH + '/${repo#*/}"',
  '  if [ -d "$dest/.git" ]; then continue; fi',
  '  git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $auth" clone --quiet "https://github.com/$repo.git" "$dest"',
  'done',
].join('\n');

/** The basic-auth value git sends for an installation token. */
export function installationBasicAuth(token: string): string {
  return Buffer.from(`x-access-token:${token}`).toString('base64');
}

/** The exec argv that clones `repositories` (each `owner/name`) with `token`. */
export function buildCloneCommand(repositories: readonly string[], token: string): string[] {
  return [
    'runuser',
    '-u',
    'node',
    '--',
    'env',
    `HOME=${INSTANCE_HOME_PATH}`,
    'sh',
    '-c',
    SCRIPT,
    'motir-clone',
    installationBasicAuth(token),
    ...repositories,
  ];
}
