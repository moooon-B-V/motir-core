/**
 * `pnpm db:stamp:onboarding -- --project=<KEY> [--workspace=<slug>] [--dry-run]`
 *
 * One-off operator tooling (MOTIR-1799): stamp a single project's
 * `Project.onboardingRanAt` marker, so it reads as an ESTABLISHED project on
 * every marker-gated surface (`/onboarding` + `/onboarding/discovery` redirect
 * to `/roadmap`; `/planning` opens the planning workspace; the
 * resume-onboarding door hides; `/roadmap`'s planning-origin cluster renders).
 *
 * WHY A SCRIPT AND NOT THE SEED. The seed change shipped alongside this
 * (`plan-seed/dogfoodProject.ts`) covers FUTURE fresh environments only.
 * `pnpm db:seed` clear-and-rebuilds its tenant and cascade-deletes every
 * MCP-created work item and every workspace-scoped PAT, so it MUST NEVER be run
 * against the live tenant — which is exactly where the live MOTIR project needs
 * the marker. Hence a targeted, idempotent script that writes one column on one
 * project and touches nothing else.
 *
 * SAFETY PROPERTIES
 *   - `--dry-run` resolves and prints what it WOULD stamp, and writes nothing.
 *   - IDEMPOTENT: the write is `projectRepository.markOnboardingRan`, a
 *     null-guarded `updateMany`, so it is set-once. A second consecutive run
 *     reports zero writes and never overwrites the existing timestamp.
 *   - SCOPED to ONE project resolved by key. An ambiguous key (the same key in
 *     several workspaces) is REFUSED, not guessed at.
 *   - No raw Prisma write and no raw SQL: the write goes through the repository
 *     layer inside `withWorkspaceContext`, so the workspace GUC is bound and the
 *     write passes under production's non-bypass `prodect_app` role.
 *
 * ⚠️ TWO CONSEQUENCES THIS ACCEPTS KNOWINGLY (Yue, MOTIR-1799)
 *
 *   1. `firstOnboarding` IS SPENT FOR THIS PROJECT — FOREVER. In
 *      `plansService.approvePlan`, the RETURN COUNT of `markOnboardingRan` (1 on
 *      the first approve, 0 after) *is* the onboarding-completion signal:
 *      `const firstOnboarding = (await markOnboardingRan(...)) === 1`. Stamping
 *      outside that flow means a later real approve finds the marker already set,
 *      writes nothing, returns 0 — so `firstOnboarding` is false forever here.
 *      Today that costs nothing: its only consumer is the fresh-establish
 *      convention trigger (`conventionEstablishService.establishForFreshProject`),
 *      which is FRESH-gated and defers for a repo-backed project, and MOTIR is
 *      repo-backed. Accepted deliberately — the meta project has no onboarding
 *      journey. **If you ever hang a NEW hook off `firstOnboarding`, know that it
 *      is silently dead for any project stamped by this script.**
 *
 *   2. THE TIMESTAMP IS THE STAMP MOMENT, NOT A REAL APPROVAL TIME. Nothing was
 *      approved when this ran, so `onboardingRanAt` records when an operator ran
 *      this script. Treat it as "established at or before this instant", never as
 *      evidence of a plan approval.
 */
/* eslint-disable no-console -- a CLI operator script: console IS its output surface */
import './_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads
import { db } from '@/lib/db';
import { stampOnboardingRan } from './stampOnboardingRan';

const TAG = '[stamp-onboarding]';

function parseArgs(argv: string[]): {
  projectKey?: string;
  workspaceSlug?: string;
  dryRun: boolean;
} {
  let projectKey: string | undefined;
  let workspaceSlug: string | undefined;
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--project=')) projectKey = arg.slice('--project='.length);
    else if (arg.startsWith('--workspace=')) workspaceSlug = arg.slice('--workspace='.length);
  }
  return { projectKey, workspaceSlug, dryRun };
}

async function main() {
  const { projectKey, workspaceSlug, dryRun } = parseArgs(process.argv.slice(2));
  if (!projectKey) {
    console.error(
      `${TAG} --project=<KEY> is required.\n` +
        `  usage: pnpm db:stamp:onboarding -- --project=MOTIR [--workspace=moooon] [--dry-run]`,
    );
    process.exitCode = 1;
    return;
  }

  if (dryRun) console.log(`${TAG} DRY RUN — resolving only, nothing will be written.`);

  const outcome = await stampOnboardingRan({ projectKey, workspaceSlug, dryRun });

  switch (outcome.kind) {
    case 'project_not_found':
      console.error(`${TAG} no project with key "${outcome.projectKey}" exists. Nothing written.`);
      process.exitCode = 1;
      return;
    case 'workspace_not_found':
      console.error(`${TAG} no workspace with slug "${outcome.workspaceSlug}". Nothing written.`);
      process.exitCode = 1;
      return;
    case 'ambiguous':
      console.error(
        `${TAG} key "${outcome.projectKey}" exists in ${outcome.candidates.length} workspaces — ` +
          `REFUSING to guess. Re-run with --workspace=<slug>:`,
      );
      for (const c of outcome.candidates) {
        console.error(`${TAG}   --workspace=${c.workspaceSlug}  (project ${c.projectId})`);
      }
      process.exitCode = 1;
      return;
    case 'no_actor':
      console.error(
        `${TAG} workspace ${outcome.workspaceId} has no owner to bind a context as. Nothing written.`,
      );
      process.exitCode = 1;
      return;
    case 'already_stamped':
      console.log(
        `${TAG} ${outcome.project.identifier} (${outcome.project.id}) is ALREADY established — ` +
          `onboardingRanAt=${outcome.onboardingRanAt.toISOString()}. 0 writes.`,
      );
      return;
    case 'would_stamp':
      console.log(
        `${TAG} WOULD stamp ${outcome.project.identifier} — project ${outcome.project.id}, ` +
          `workspace ${outcome.project.workspaceId}, onboardingRanAt: null -> <now>. 0 writes (dry run).`,
      );
      return;
    case 'stamped':
      console.log(
        `${TAG} stamped ${outcome.project.identifier} (${outcome.project.id}) — ` +
          `onboardingRanAt=${outcome.at.toISOString()}. 1 write.`,
      );
      return;
  }
}

main()
  .catch((err) => {
    console.error(`${TAG} failed:`, err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
