import { getTranslations } from 'next-intl/server';
import {
  JobsPane,
  parseJobsParams,
  type JobsSearchParams,
} from '../../workspace/jobs/_components/JobsPane';

// The `Job runs` FOLD-IN (Story MOTIR-4843 · MOTIR-4861), drawn by
// `design/settings/workspace-settings.mock.html` Panel 4 (MOTIR-4844).
//
// Below the workspace-tier reveal `/settings/workspace/jobs` 404s like its three
// siblings, so this section is where the workspace's background-job dashboard
// lives at one workspace. It sits BESIDE `WorkspaceFoldInSection` rather than
// inside it: that component hosts the workspace-CONFIG cards (name, members,
// require-2FA, danger zone), and this is an operator surface, which is why the
// area rail gives it a group of its own.
//
// ── ⚠️ THE HOST PAGE'S GATE IS NOT THIS SECTION'S GATE ──────────────────────
// `/settings/organization` is org owner/admin gated as a PAGE, and
// `docs/decisions/organization-tier.md` §6d gates it PER SECTION. A workspace
// invitee is a plain org `member` (§5's upward invariant), and the source
// surface — `/settings/workspace/jobs` — checks a session and a workspace
// context and NO ROLE AT ALL. §6d: *relocating a surface preserves its gate.*
//
// So this section is rendered for anyone with a WORKSPACE MEMBERSHIP, exactly as
// `WorkspaceFoldInSection` beside it is, and never on the org role. Copying the
// page's gate would look like the conservative choice and would close the
// dashboard to precisely the smallest customers — the only people who ever see
// the folded-in state — which is MOTIR-3500's original defect one surface over.
//
// ── The three capabilities, and each keeps the gate it asserts ──────────────
//   Runs tab                  any workspace member          (no role)
//   DLQ tab + count badge     any workspace member          (no role)
//   DLQ replay control        workspace OWNER               (`isOwner` prop)
//   System tab                PLATFORM_ADMIN_EMAIL          (`showSystemTab`)
//
// The dashboard itself is NOT redrawn: `JobsDashboard` and everything under
// `workspace/jobs/_components/` are composed exactly as the standalone route
// composes them, and `jobsDashboardService` is untouched.
//
// ── What this section deliberately does NOT carry ───────────────────────────
// The standalone route reads `?tab` / `?status` / `?page` from its own search
// params. This is a SECTION on a page that owns none of those, so it renders the
// dashboard's DEFAULT view — the first page of `runs`, with the DLQ badge — and
// the tab control does the rest client-side. Giving it URL state would mean
// claiming three query keys on a page shared with four other sections.
export async function JobRunsFoldInSection({
  workspaceId,
  actorUserId,
  actorEmail,
  searchParams,
}: {
  workspaceId: string;
  actorUserId: string;
  actorEmail: string;
  /**
   * ⚠️ THE HOST PAGE'S OWN QUERY, and this section is URL-DRIVEN through it
   * (Story MOTIR-4843 · MOTIR-4849).
   *
   * It shipped WITHOUT this and pinned `activeTab="runs"`, `page={1}`, no
   * status — while `JobsDashboard` built every tab, filter and pagination link
   * from a module-level `/settings/workspace/jobs`. So the section rendered, its
   * DLQ badge showed a count, and every link inside it pointed at the route this
   * same story had just made `notFound()` at this workspace count. The
   * relocation §6d asks for was cosmetic: the dead-letter queue — the one thing
   * a tenant actually comes here to do, replay a bounced invite — could not be
   * opened at all.
   */
  searchParams: JobsSearchParams;
}) {
  const t = await getTranslations('settings.organization');

  // The pre-Epic-6 platform-admin escape hatch (Subtask 1.6.3), read exactly as
  // the standalone route reads it so the two doors cannot disagree about who
  // sees the System tab.
  const adminEmail = process.env['PLATFORM_ADMIN_EMAIL'];
  const showSystemTab = Boolean(adminEmail) && actorEmail === adminEmail;

  const params = parseJobsParams(searchParams, showSystemTab);

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="font-sans text-base font-semibold text-(--el-text)">
          {t('jobRunsFoldIn.title')}
        </h2>
        <p className="text-(--el-text-secondary) font-sans text-sm">
          {t('jobRunsFoldIn.subtitle')}
        </p>
      </div>

      {/* ⚠️ `basePath` is THIS page, not the workspace route. That is the whole
          of the fix above: the dashboard's links have to come back HERE, because
          below the reveal this is the only door onto the surface. */}
      <JobsPane
        userId={actorUserId}
        workspaceId={workspaceId}
        {...params}
        showSystemTab={showSystemTab}
        basePath="/settings/organization"
      />
    </>
  );
}
