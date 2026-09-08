import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Activity } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { NotProjectAdminError, ProjectNotFoundError } from '@/lib/projects/errors';
import { EmptyState } from '@/components/ui/EmptyState';
import { resolveCodeContextState } from '@/lib/services/codeContextService';
import type {
  CodeAuditSurfaceDTO,
  ConventionSurfaceDTO,
  RepoAuditSurfaceDTO,
} from '@/lib/dto/codeHealth';
import { loadCodeHealthSurfaces } from './_health';
import { CodeHealthClient } from './_components/CodeHealthClient';
import { CodeRepositories } from './_components/CodeRepositories';
import { CodeSections } from './_components/CodeSections';

// THE CODE PAGE (Story MOTIR-1754 · MOTIR-1768) — one room, two sections.
//
// It replaces `/code-health`, which now permanently redirects here, and it is
// the door the `Code` rail row opens (MOTIR-4643 owns the row itself).
//
// ⚠️ THE ROW IS BROWSE-REACHABLE AND EACH SECTION KEEPS ITS OWN GATE
// (design/code-context §2.1). This is the whole reason the collapse is legal.
// `/code-health` asserts `ai:configure`; the old `Git` row was ungated on
// purpose, because connecting your own account is *"the one action nobody can
// take on [a member's] behalf"*. A naive collapse fails either way — one gated
// row takes a capability off every member, one ungated row widens an admin-only
// audit to everyone. So: Repositories is browse-reachable, Health is admin-only
// INSIDE the page, and a member who opens `/code` gets a working repository list
// beside Health's own admin-only empty state rather than a refusal.
//
// ⚠️ WHICH MEANS THE GATE MAY NOT SIT ON THE PAGE. The surface this absorbed
// returned a whole-page `EmptyState` on `NotProjectAdminError`; doing that here
// would take Repositories away from every member, which is the capability loss
// §3.1 forbids. The catch is scoped to the Health read alone.

// ── MOTIR-3446 — THE AWAIT COUNT IS A TRIGGER, NOT THE FINDING ──────────────
//
// Carried forward from the surface this absorbed, and RE-MEASURED for the split
// (MOTIR-1768). It is kept because a measurement in a pull-request body is
// somewhere nobody looks: the next sweep driven by an await count should meet
// this before it starts rather than re-derive it.
//
//   GATE — 3, and they must stay ahead of any paint
//     getSession · getTranslations('code') · getActiveProject
//
//   GENUINELY DEPENDENT — 2, each needing the previous one's output
//     resolveCodeContextState(projectId, ctx)  needs the project → yields repoRefs
//     loadCodeHealthSurfaces(..., repoRefs)    needs repoRefs
//
//   ALREADY CONCURRENT — the fan-out machinery, now in `./_health`
//     the two per-repo leaves (getAudit / getConvention) and the three
//     `allSettledOrThrow` call sites that fan them out. Untouched by the move.
//
// So there is NOTHING LEFT TO PARALLELISE, and that is the honest result rather
// than a gap. The expensive part — an audit and a convention for every indexed
// repository — has been concurrent since MOTIR-3077, and the serial remainder is
// serial because each step consumes the previous step's output.
//
// ⚠️ THE SPLIT DID NOT ADD A ROUND TRIP. `resolveCodeContextState` replaced
// `resolveCodeContext` one for one: both are a single transaction over the same
// database, neither reaches a motir-ai client, and the new one answers a
// STRICTER question (the project's set rather than the workspace's grant list)
// for the same cost.
//
// ⚠️ NO BOUNDARY IS ADDED, and that is a deferral with a named reason.
// `design/coding-convention/design-notes.md` § The streaming allocation at
// ARRIVAL gives this surface verdict NONE: a boundary would buy only the
// `Header` painting ahead of the island, and buying more means handing
// `CodeHealthClient` a pending state nobody has drawn.

export const dynamic = 'force-dynamic';

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

export default async function CodePage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('code');
  const ctx = await getActiveProject();

  // ⚠️ UNREACHABLE for a signed-in reader (MOTIR-4870 seeds a default project at
  // the WORKSPACE tier, and MOTIR-4815 retired every no-project surface). The
  // guard stays because the TYPE does — the only null left is a session-less
  // request — and it redirects rather than rendering a state nobody can reach.
  //
  // Carried from `code-health/page.tsx`, which this route absorbed: main made
  // exactly this change to that file while this branch was turning it into a
  // redirect, so taking "my" side of that conflict would have silently kept the
  // retired branch alive one route over.
  if (!ctx) redirect('/sign-in');

  const svcCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };

  // ⚠️ THE PROJECT'S SET, NOT THE WORKSPACE'S GRANT LIST (§1, and MOTIR-1767's
  // correction). `resolveCodeContextState` resolves `project_repository` and
  // joins each row's freshness from the ONE derivation — so two projects in one
  // workspace with different sets render different lists, which is the property
  // the whole section exists to have.
  const codeContext = await resolveCodeContextState(ctx.projectId, svcCtx);
  const repoRefs = codeContext.repos.map((repo) => repo.repoRef);

  let audits: RepoAuditSurfaceDTO[] = [];
  let selectedRepoKey: string | null = null;
  let selectedAudit: CodeAuditSurfaceDTO | null = null;
  let conventions: ConventionSurfaceDTO[] = [];
  // ⚠️ NOT AN ERROR — the ADMIN-ONLY state, and it is the Health SECTION's, not
  // the page's. `null` means the read succeeded (or there was nothing to read);
  // a string means this member may not see the audit and the section says so
  // while everything else on the page keeps working.
  let healthDenied = false;

  if (repoRefs.length > 0) {
    try {
      const surfaces = await loadCodeHealthSurfaces(ctx.projectId, svcCtx, repoRefs);
      audits = surfaces.audits;
      selectedRepoKey = surfaces.selectedRepoKey;
      selectedAudit = surfaces.selectedAudit;
      conventions = surfaces.conventions;
    } catch (err) {
      if (err instanceof NotProjectAdminError || err instanceof ProjectNotFoundError) {
        healthDenied = true;
      } else {
        // Everything else is a genuine server error and is RETHROWN. There is no
        // `MotirAiError` arm: the per-repo containment in `_health.ts` absorbs
        // every one of them, so such an arm could never execute (MOTIR-3719).
        throw err;
      }
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Header title={t('title')} subtitle={t('subtitle')} />
      <CodeSections
        label={t('sectionsLabel')}
        repositoriesLabel={t('tabs.repositories')}
        healthLabel={t('tabs.health')}
        repositories={<CodeRepositories repos={codeContext.repos} />}
        health={
          healthDenied ? (
            <EmptyState title={t('adminOnlyTitle')} description={t('adminOnlyDescription')} />
          ) : (
            <CodeHealthClient
              projectId={ctx.projectId}
              repoRefs={repoRefs}
              initialAudits={audits}
              initialSelectedRepoKey={selectedRepoKey}
              initialSelectedAudit={selectedAudit}
              initialConventions={conventions}
            />
          )
        }
      />
    </div>
  );
}
