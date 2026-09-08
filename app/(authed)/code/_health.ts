// THE HEALTH SECTION'S READ (Story MOTIR-1754 · MOTIR-1768).
//
// Lifted VERBATIM from `app/(authed)/code-health/page.tsx`, which is now a
// permanent redirect into `/code`. Nothing about the read changed — the
// two-phase selection, the per-repo containment and the three `allSettledOrThrow`
// fan-outs are the same code, moved so that the page composing them is the Code
// room rather than a route of its own.
//
// ⚠️ IT IS THE SHIPPED AUDIT, COMPOSED AND NOT REDRAWN (design/code-context
// §2.1, §5 panel H). The collapse is a change of DOOR, not of behaviour: every
// comment below describes a decision taken by MOTIR-2207 / MOTIR-3077 /
// MOTIR-3719 and still in force, and re-deriving any of them here would be a
// second home for reasoning that is already settled.

import { allSettledOrThrow } from '@/lib/async/allSettledOrThrow';
import { MotirAiError } from '@/lib/ai/errors';
import { aiConventionService } from '@/lib/services/aiConventionService';
import type {
  CodeAuditSurfaceDTO,
  ConventionSurfaceDTO,
  RepoAuditSurfaceDTO,
} from '@/lib/dto/codeHealth';
import { buildRepoAuditRows, defaultSelectedRepoKey } from '@/lib/codeHealth/repoAuditRows';

// The cheapest LEGAL summary read (Panel 7 §3). The per-repo list needs
// `healthSummary` + `total` for every repo and `findings` for none of them, but
// motir-ai's `parsePositiveInt` rejects `0` with a validation_error — so the
// floor is one row, not zero.
const SUMMARY_FINDINGS_LIMIT = 1;

export interface CodeHealthSurfaces {
  /** One entry per connected repo, in connected order — the LIST's source. */
  audits: RepoAuditSurfaceDTO[];
  /** The repo whose report opens the tab (worst-first), or null with no repos. */
  selectedRepoKey: string | null;
  /** That repo's report, read at the FULL findings page size. */
  selectedAudit: CodeAuditSurfaceDTO | null;
  conventions: ConventionSurfaceDTO[];
}

// ⚠️ A PER-REPO read failure degrades THAT repo only (MOTIR-2207).
//
// Before this card the page `Promise.all`ed its per-repo reads, so one repo's
// rejection failed the WHOLE page into `loadError` — including every repo that
// had resolved. Reading N audits as well as N conventions would have doubled
// that exposure on the exact surface that made it five times more likely to be
// hit. So each repo's read is caught HERE and becomes that row's own
// "Couldn't load this report" state (Panel 7 §6).
//
// Only a `MotirAiError` is absorbed. The project-gate errors
// (`NotProjectAdminError` / `ProjectNotFoundError`) come from `assertCanManage`
// and are a statement about the CALLER, not about one repo — swallowing them
// per repo would turn the admin-only screen into five broken rows.
//
// ⚠️ AND THIS CONTAINMENT IS TOTAL, WHICH IS WHY THE PAGE NO LONGER KEEPS A
// WHOLE-SURFACE `loadError` (MOTIR-3719). These two functions are the page's
// ONLY `aiConventionService` call sites, and every path through
// `loadCodeHealthSurfaces` — `repoRefs.length === 0`, `=== 1`, `> 1`, and the
// selected-repo re-read — goes through one of them. So a `MotirAiError` cannot
// reach the caller's `catch`, and the arm that used to sit there was dead from
// the moment MOTIR-2207 landed. `design/coding-convention/design-notes.md`
// Panel 7 §6 draws the answer that survives: the row's own `unavailable` state,
// and the page "does not fall into the whole-page `loadError`".
async function readRepoAudit(
  projectId: string,
  svcCtx: { userId: string; workspaceId: string },
  repoKey: string,
  findingsLimit?: number,
): Promise<RepoAuditSurfaceDTO> {
  try {
    const surface = await aiConventionService.getAudit(projectId, svcCtx, {
      repoKey,
      ...(findingsLimit === undefined ? {} : { findingsLimit }),
    });
    return { repoKey, surface };
  } catch (err) {
    if (err instanceof MotirAiError) return { repoKey, surface: null };
    throw err;
  }
}

// Same per-repo containment for the conventions. A repo whose read rejects is
// dropped exactly as a repo with nothing derived is — the tab's own empty state
// covers it, and neither one may hide the repos that DO have a convention.
async function readRepoConvention(
  projectId: string,
  svcCtx: { userId: string; workspaceId: string },
  repoKey: string,
): Promise<ConventionSurfaceDTO | null> {
  try {
    return await aiConventionService.getConvention(projectId, svcCtx, { repoKey });
  } catch (err) {
    if (err instanceof MotirAiError) return null;
    throw err;
  }
}

/**
 * The page's initial read for a connected repo SET (MOTIR-2123 → MOTIR-2207).
 *
 * ONE convention surface PER connected repo — the convention is scoped to a
 * (project, repo) pair (MOTIR-1660/1662) and `ConventionPanel` has rendered one
 * card per repo since MOTIR-1663, so reading only the first repo's surface was
 * what made four of MOTIR's five repos invisible.
 *
 * The AUDIT is now plural too (MOTIR-2207 · design/coding-convention Panel 7).
 * Everything below the presentation layer was already per-repo — the store since
 * MOTIR-1662, the boundary's `repoKey` query, the trigger's fan-out since
 * MOTIR-2123 — so one re-audit derived five `CodeAudit` rows and the tab showed
 * whichever sorted first under `owner asc, name asc`. Four repos' findings were
 * computed, stored, paid for and invisible.
 *
 * The read is in TWO phases because the selection model needs it to be: every
 * repo is read at SUMMARY depth to build the list, and only then — once
 * worst-first order names the selected repo — is that one repo re-read for its
 * real findings page. Reading all N at the full page size instead would ship
 * N × 100 findings to draw an N-row list.
 *
 * Exported for the page test (the `resolveSelectedBoardId` precedent) — the
 * composition is the behaviour worth pinning, not the JSX around it.
 */
export async function loadCodeHealthSurfaces(
  projectId: string,
  svcCtx: { userId: string; workspaceId: string },
  repoRefs: string[],
): Promise<CodeHealthSurfaces> {
  if (repoRefs.length === 0) {
    return { audits: [], selectedRepoKey: null, selectedAudit: null, conventions: [] };
  }

  const readConventions = async (): Promise<ConventionSurfaceDTO[]> => {
    // MOTIR-3077 — DANGEROUS bucket, repaired. Every arm here opens its own
    // transaction, and `readRepoConvention` rethrows a PROJECT-GATE error
    // (`NotProjectAdminError` / `ProjectNotFoundError` from `assertCanManage`)
    // rather than absorbing it — deliberately, per the note above, and an
    // ORDINARY path: a non-admin reaching an admin-only page. Under
    // `Promise.all` that refusal returned while the sibling repos' reads kept
    // running unobserved.
    const surfaces = await allSettledOrThrow(
      repoRefs.map((repoKey) => readRepoConvention(projectId, svcCtx, repoKey)),
    );
    return surfaces.filter((c): c is ConventionSurfaceDTO => c !== null && c.convention !== null);
  };

  // N = 1 — the list is not drawn at all (Panel 7 §7: selection and comparison
  // are both vacuous with one row), so the read stays exactly what it has always
  // been: ONE audit read at the full page size, no summary pass, no second trip.
  if (repoRefs.length === 1) {
    const repoKey = repoRefs[0]!;
    // MOTIR-3077 — DANGEROUS bucket, repaired: the audit arm rethrows the
    // project-gate error while `readConventions()` holds N open transactions.
    const [audit, conventions] = await allSettledOrThrow([
      readRepoAudit(projectId, svcCtx, repoKey),
      readConventions(),
    ]);
    return {
      audits: [audit],
      selectedRepoKey: repoKey,
      selectedAudit: audit.surface,
      conventions,
    };
  }

  // MOTIR-3077 — DANGEROUS bucket, repaired, and this is the site the empirical
  // probe caught: `tests/code-health-page.test.ts`'s project-gate case left one
  // backend `idle in transaction` on a `workspace_membership` SELECT. A rejected
  // audit arm abandoned both the other repos' audits and every convention read.
  const [audits, conventions] = await allSettledOrThrow([
    allSettledOrThrow(
      repoRefs.map((repoKey) => readRepoAudit(projectId, svcCtx, repoKey, SUMMARY_FINDINGS_LIMIT)),
    ),
    readConventions(),
  ]);

  const selectedRepoKey = defaultSelectedRepoKey(buildRepoAuditRows(audits));
  const selected = audits.find((a) => a.repoKey === selectedRepoKey);
  // Only a repo that HAS an audit owes a second read; a not-audited or
  // unloadable selection renders the panel's own state, with no findings to page.
  const selectedAudit =
    selectedRepoKey !== null && selected?.surface?.audit != null
      ? (await readRepoAudit(projectId, svcCtx, selectedRepoKey)).surface
      : null;

  return { audits, selectedRepoKey, selectedAudit, conventions };
}
