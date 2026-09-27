import { hostedRunWriteAccess } from '@/lib/github/runGitCredential';
import { RunGitCredentialUnavailableError } from '@/lib/hostedRuns/errors';
import { isOrganizationSeedSource } from '@/lib/projectRepos/vocabulary';
import type {
  HostedRunRepoAccessDto,
  HostedRunRepoAccessMapDto,
  ProjectRepoDto,
} from '@/lib/dto/projectRepos';

// WHERE MOTIR'S APP CAN WRITE, PER CONNECTED REPOSITORY (MOTIR-1895 ·
// `design/repository-set/design-notes.md` §18.1;
// `docs/decisions/hosted-run-runs-the-cli-as-the-app.md` §5, §8).
//
// ⚠️ THE ANSWER IS MOTIR-6449's, NOT A SECOND ONE. The start path refuses a run on
// `hostedRunWriteAccess`; the room asks the same function, so a row that reads
// *ready* is a repository a run can write and a row with a warning is exactly the
// repository a refused run names. Re-deriving "is it installed, did it accept" here
// would be a second answer to the question the refusal already owns.
//
// ⚠️ ONLY THE ORGANISATION'S REPOSITORIES GET A LINE. A Motir-hosted row is written
// with `motir-studio` in Motir's own organisation — there is nothing for anybody to
// accept or reconnect, so §18.1 draws nothing there.
//
// ⚠️ A READ THAT FAILS DRAWS NOTHING, NEVER A WARNING. A warning line says "a run
// here will be refused", and GitHub being slow or down says nothing of the sort:
// - the Integration App is not configured on this deployment → no line on any row
//   (AC3 — there are no hosted runs to explain);
// - GitHub cannot be reached, or does not answer inside READ_TIMEOUT_MS → no line
//   on that row. The room is the record on the next load.
//
// ⚠️ ONE GITHUB CALL PER CONNECTED REPOSITORY, concurrently. The permission state
// belongs to the installation, but whether the installation still INCLUDES a
// repository is per repository, and `GET /repos/{owner}/{name}/installation` answers
// both in one call. Nothing is minted — `hostedRunWriteAccess` is a pure read.

/** How long one repository's GitHub read may hold the room's render. */
const READ_TIMEOUT_MS = 4_000;

const TIMED_OUT = Symbol('timed-out');

async function withTimeout<T>(pending: Promise<T>): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Configured-nowhere, signalled up so the whole map collapses (AC3). */
class NotConfigured extends Error {}

async function readOne(
  repository: string,
  installHref: string | null,
): Promise<HostedRunRepoAccessDto | null> {
  let answer;
  try {
    answer = await withTimeout(
      hostedRunWriteAccess([{ repository, app: 'motir-integration' }]).then((r) => r[0]),
    );
  } catch (err) {
    if (err instanceof RunGitCredentialUnavailableError && err.reason === 'not_configured') {
      throw new NotConfigured();
    }
    if (err instanceof RunGitCredentialUnavailableError) return null;
    throw err;
  }
  if (answer === TIMED_OUT || answer === undefined) return null;
  if (answer.ok) return { state: 'ready' };
  if (answer.fix === 'accept_permissions') {
    // The installation that covers `owner/name` is the one on account `owner`, so
    // the account an owner of which accepts is the repository's owner.
    return {
      state: 'needs_permissions',
      account: repository.split('/')[0] ?? repository,
      reviewHref: answer.fixUrl ?? installHref,
    };
  }
  return { state: 'unreachable', repository, reconnectHref: installHref };
}

export const hostedRunRepoAccessService = {
  /**
   * The room's hosted-run line for each of the ORGANISATION's repositories in
   * `rows`, keyed by row id. `installHref` is the Integration App's install
   * screen (`githubAppInstallUrl()`), where a repository is reconnected and the
   * fallback for a permission review whose installation page is unknown.
   */
  async forRoomRows(
    rows: readonly ProjectRepoDto[],
    { installHref }: { installHref: string | null },
  ): Promise<HostedRunRepoAccessMapDto> {
    const candidates = rows.filter(
      (row) =>
        isOrganizationSeedSource(row.seedSource) &&
        row.established &&
        row.realizedRepo?.provider === 'github',
    );
    if (candidates.length === 0) return {};
    try {
      const answers = await Promise.all(
        candidates.map(async (row) => {
          const answer = await readOne(row.realizedRepo!.repoRef, installHref);
          return [row.id, answer] as const;
        }),
      );
      const out: HostedRunRepoAccessMapDto = {};
      for (const [id, answer] of answers) if (answer) out[id] = answer;
      return out;
    } catch (err) {
      if (err instanceof NotConfigured) return {};
      throw err;
    }
  },
};
