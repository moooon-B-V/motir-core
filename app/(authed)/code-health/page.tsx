import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Activity } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { NotProjectAdminError, ProjectNotFoundError } from '@/lib/projects/errors';
import { MotirAiError } from '@/lib/ai/errors';
import { resolveCodeContext } from '@/lib/ai/codeContext';
import { aiConventionService } from '@/lib/services/aiConventionService';
import { EmptyState } from '@/components/ui/EmptyState';
import type {
  CodeAuditSurfaceDTO,
  ConventionSurfaceDTO,
  RepoAuditSurfaceDTO,
} from '@/lib/dto/codeHealth';
import { buildRepoAuditRows, defaultSelectedRepoKey } from '@/lib/codeHealth/repoAuditRows';
import { CodeHealthClient } from './_components/CodeHealthClient';

// The Code-health page (MOTIR-926/1663) — a top-level, active-project page
// rendering the audit report + per-repo read-only convention cards. Server
// Component: session-gate, resolve the active project, read initial data
// through aiConventionService over the 7.1 boundary (project-admin gated),
// then seed the interactive island.

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
    const surfaces = await Promise.all(
      repoRefs.map((repoKey) => readRepoConvention(projectId, svcCtx, repoKey)),
    );
    return surfaces.filter((c): c is ConventionSurfaceDTO => c !== null && c.convention !== null);
  };

  // N = 1 — the list is not drawn at all (Panel 7 §7: selection and comparison
  // are both vacuous with one row), so the read stays exactly what it has always
  // been: ONE audit read at the full page size, no summary pass, no second trip.
  if (repoRefs.length === 1) {
    const repoKey = repoRefs[0]!;
    const [audit, conventions] = await Promise.all([
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

  const [audits, conventions] = await Promise.all([
    Promise.all(
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

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="flex flex-col gap-1">
      <h1 className="flex items-center gap-2 font-serif text-2xl font-semibold text-(--el-text)">
        <Activity className="h-6 w-6 text-(--el-text-secondary)" aria-hidden />
        {title}
      </h1>
      <p className="text-sm text-(--el-text-muted)">{subtitle}</p>
    </header>
  );
}

export default async function CodeHealthPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('codeHealth');
  const ctx = await getActiveProject();

  if (!ctx) {
    return (
      <div className="flex flex-col gap-6">
        <Header title={t('title')} subtitle={t('subtitle')} />
        <EmptyState title={t('noProjectTitle')} description={t('noProjectDescription')} />
      </div>
    );
  }

  const svcCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  let initialAudits: RepoAuditSurfaceDTO[] = [];
  let initialSelectedRepoKey: string | null = null;
  let initialSelectedAudit: CodeAuditSurfaceDTO | null = null;
  let initialConventions: ConventionSurfaceDTO[] = [];
  // Reached only by a failure that is NOT one repo's read — those are contained
  // per repo above and surface as that row's own state.
  let loadError: string | false = false;

  // Resolve connected repos for per-repo convention/audit scoping (MOTIR-1662).
  const code = await resolveCodeContext({
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  const repoRefs = (code?.repos ?? []).map((repo) => repo.repoRef);

  if (repoRefs.length > 0) {
    try {
      const surfaces = await loadCodeHealthSurfaces(ctx.projectId, svcCtx, repoRefs);
      initialAudits = surfaces.audits;
      initialSelectedRepoKey = surfaces.selectedRepoKey;
      initialSelectedAudit = surfaces.selectedAudit;
      initialConventions = surfaces.conventions;
    } catch (err) {
      if (err instanceof NotProjectAdminError || err instanceof ProjectNotFoundError) {
        return (
          <div className="flex flex-col gap-6">
            <Header title={t('title')} subtitle={t('subtitle')} />
            <EmptyState title={t('adminOnlyTitle')} description={t('adminOnlyDescription')} />
          </div>
        );
      }
      if (err instanceof MotirAiError) {
        loadError = `${err.code}: ${err.message}`;
      } else {
        throw err;
      }
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Header title={t('title')} subtitle={t('subtitle')} />
      <CodeHealthClient
        projectId={ctx.projectId}
        repoRefs={repoRefs}
        initialAudits={initialAudits}
        initialSelectedRepoKey={initialSelectedRepoKey}
        initialSelectedAudit={initialSelectedAudit}
        initialConventions={initialConventions}
        loadError={loadError}
      />
    </div>
  );
}
