import {
  DispatchRunNotFoundError,
  DispatchRunTerminalError,
  DispatchRunTokenOutOfScopeError,
} from '@/lib/dispatchRuns/errors';
import { mintRunGitCredentials } from '@/lib/github/runGitCredential';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// A running hosted run trades its RUN credential for fresh git credentials
// (MOTIR-6538, `docs/decisions/hosted-run-runs-the-cli-as-the-app.md` §5).
//
// GitHub gives an App's installation token one hour, and a healthy hosted run
// has no wall-clock limit — so the run asks again as often as it needs, through
// the one credential it already holds. It is also the run's FIRST git
// credential: the container boots with none, and the CLI's credential helper
// calls this for the clone, every push and every pull request.
//
// Every token handed out is recorded by `mintRunGitCredentials` itself
// (`DispatchRunGitCredential`), so the end path revokes all of them. This service
// stores nothing of its own.

/** The wire shape (`dispatchRunGitCredentialsSchema` documents it). */
export interface DispatchRunGitCredentialsDto {
  credentials: {
    repository: string;
    token: string;
    expiresAt: string;
    authorName: string;
    authorEmail: string;
  }[];
  dispatchedBy: string | null;
}

export const hostedRunGitCredentialService = {
  /**
   * The run's git credentials, one entry per repository of the run.
   *
   * ⚠️ ONLY THE RUN'S OWN CREDENTIAL. A person's token is refused here even
   * though its grant holds the route's key: a git token is handed to the run
   * that will push with it, never to a person, who needs no GitHub access for a
   * hosted run at all. The binding is checked BEFORE the run is read, so the
   * refusal (`DISPATCH_RUN_TOKEN_OUT_OF_SCOPE`, 403) is the same for a run that
   * exists and one that does not — no existence oracle, as on the run's ingest.
   *
   * Then the run is read under the caller's workspace (RLS): a run outside it
   * is `DISPATCH_RUN_NOT_FOUND` (404). A run that is no longer `running` is
   * `DISPATCH_RUN_TERMINAL` (409) — nothing is minted for a run that has ended.
   */
  async issue(runId: string, ctx: ServiceContext): Promise<DispatchRunGitCredentialsDto> {
    if (ctx.tokenDispatchRunId === undefined || ctx.tokenDispatchRunId !== runId) {
      throw new DispatchRunTokenOutOfScopeError();
    }

    const run = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => dispatchRunRepository.findById(runId, tx),
    );
    if (!run) throw new DispatchRunNotFoundError(runId);
    if (run.status !== 'running') throw new DispatchRunTerminalError(runId, run.status);

    // `mintRunGitCredentials` re-reads the run and refuses a non-running one
    // itself (`RUN_CREDENTIAL_RUN_NOT_LIVE`, 409), which covers a close racing
    // this call between the read above and the mint.
    const entries = await mintRunGitCredentials(runId);

    const dispatcher = run.createdById ? await userRepository.findById(run.createdById) : null;

    return {
      credentials: entries.map((e) => ({
        repository: e.repository,
        token: e.token,
        expiresAt: e.expiresAt.toISOString(),
        authorName: e.author.name,
        authorEmail: e.author.email,
      })),
      dispatchedBy: dispatcher?.name?.trim() || null,
    };
  },
};
