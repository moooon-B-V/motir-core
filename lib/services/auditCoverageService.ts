import { getCodeAudit } from '@/lib/ai/motirAiClient';
import { MotirAiError } from '@/lib/ai/errors';
import { resolveCodeContext } from '@/lib/ai/codeContext';
import { projectAccessService, type AccessActorContext } from '@/lib/services/projectAccessService';
import type {
  AuditCoverageDTO,
  RepoAuditCoverageEntryDTO,
  RepoAuditCoverageState,
} from '@/lib/dto/codeHealth';

// Audit COVERAGE (MOTIR-2248) — which of a project's connected repos have no
// derived code-health audit. One question, one request, no rendering: this is the
// read the planning workspace's nudge (MOTIR-2250) fetches for itself, in the shape the
// shipped `app/api/ready/nudge` route established (a banner polls its own state
// rather than blocking a page render on it).
//
// Nothing is stored. N cheap reads behind an admin-gated endpoint IS the shape —
// a persisted coverage row would be a second source of truth for a fact motir-ai
// already owns, and it would go stale exactly when an audit lands.

// motir-ai's `parsePositiveInt` REJECTS `0`, so ONE finding is the cheapest legal
// page — the same floor `/code-health`'s summary reads use. We want `audit`
// present-or-absent and nothing else; reading the default 100-row page per repo
// would ship N × 100 findings to answer a yes/no question per repo.
const COVERAGE_FINDINGS_LIMIT = 1;

// ⚠️ A PER-REPO read failure degrades THAT repo ONLY.
//
// This is the property MOTIR-2207 established for the page after its bare
// `Promise.all` was found to fail whole — one slow or broken repo took every
// resolved sibling down with it. The containment lives HERE, inside the per-repo
// mapper, which is why the `Promise.all` below is safe: every branch resolves.
//
// Only a `MotirAiError` is absorbed. The project-gate errors come from
// `assertCanManage` and are a statement about the CALLER, not about one repo —
// and the gate runs once, before any of this.
//
// ⚠️ EXPORTED AS A PRIMITIVE, NOT AS AN API SURFACE (MOTIR-2266). It carries NO
// permission gate — `getCoverage` below runs one before it, and the auto-fire
// trigger (`firstAuditTriggerService`) has no caller to gate, because it runs
// inside `system.code-graph-index` where there is no request. It is exported so
// the trigger's idempotency gate asks the SAME question this read asks rather
// than growing a second definition of "does this repo have an audit" — the two
// would drift on exactly the detail that matters (`audit === null` is a
// successful read of an un-derived repo; a MotirAiError is not an answer at all).
// A ROUTE that reaches for this instead of `getCoverage` has skipped the gate.
export async function readRepoAuditState(
  query: { coreWorkspaceId: string; coreProjectId: string },
  repoKey: string,
): Promise<RepoAuditCoverageEntryDTO> {
  let state: RepoAuditCoverageState;
  try {
    const surface = await getCodeAudit({
      ...query,
      repoKey,
      findingsLimit: COVERAGE_FINDINGS_LIMIT,
    });
    // `audit === null` is a SUCCESSFUL read of a repo with nothing derived —
    // never an error. That distinction is the whole point of the two states.
    state = surface.audit ? 'audited' : 'not_audited';
  } catch (err) {
    if (!(err instanceof MotirAiError)) throw err;
    state = 'unavailable';
  }
  return { repoKey, state };
}

export const auditCoverageService = {
  /**
   * Which connected repos have no derived audit, for the given project.
   *
   * Project-manage gated, so the capability check exists on the SERVER and not
   * only in the component that hides the nudge — the remedy behind the nudge
   * (`reaudit`) carries the same gate, and a nudge shown to someone who would be
   * refused is an invitation to a 403.
   */
  async getCoverage(projectId: string, ctx: AccessActorContext): Promise<AuditCoverageDTO> {
    // `ai:configure`, NOT `ai:plan` (Story MOTIR-2291 · Subtask MOTIR-2362).
    // The inventory mapped the four coding-convention operations to `ai:plan`,
    // which the decision record puts at `member` — applying that mapping would
    // have WIDENED admin-only operations to every member, in a story where every
    // other row narrows. `docs/decisions/member-facing-permissions.md` §4 resolves
    // it as a MAPPING fix: re-running a convention audit is AI CONFIGURATION
    // wearing a usage-shaped URL, the same class as the AI settings MOTIR-2300
    // already put behind `ai:configure`. `assertCanManage` was
    // `assertPermission(…, 'project:administer')` and `admin` holds
    // `ai:configure`, so NO actor's answer changes.
    await projectAccessService.assertPermission(projectId, ctx, 'ai:configure');

    const code = await resolveCodeContext({ userId: ctx.userId, workspaceId: ctx.workspaceId });
    const repoRefs = code?.repos.map((repo) => repo.repoRef) ?? [];
    // A project with no connected repo is a well-formed EMPTY answer, never an
    // error — there is nothing un-audited, so the nudge has nothing to say.
    if (repoRefs.length === 0) return { repos: [], notAuditedCount: 0 };

    const query = { coreWorkspaceId: ctx.workspaceId, coreProjectId: projectId };
    const repos = await Promise.all(repoRefs.map((repoKey) => readRepoAuditState(query, repoKey)));

    return {
      repos,
      // `unavailable` is NOT counted. Unknown is not the same as missing, and a
      // nudge that cries wolf once is worth less than no nudge.
      notAuditedCount: repos.filter((repo) => repo.state === 'not_audited').length,
    };
  },
};
