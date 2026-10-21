/**
 * The one-shot connected-org runner-group sync, as a function (Story MOTIR-8699 ·
 * MOTIR-8712). `sync-project-runner-groups.ts` is its CLI; the tests call this.
 *
 * WHY IT EXISTS. `projectRunnerGroupService.syncForProject` runs when a project's
 * repository establishes. Repositories that were established long before the
 * connected-org pass existed — project MOTIR's, all `connected` — fire no such
 * event, so their groups are created by running this once.
 *
 * It resolves the project key ACROSS workspaces (operator tooling, the
 * `stampOnboardingRan` posture) and refuses an ambiguous or unknown key rather
 * than guessing. A key is unique per WORKSPACE only — production holds two
 * projects keyed MOTIR — so `--project-id` names one by primary key, and an
 * ambiguous `--project` lists every candidate as the `--project-id` line to
 * re-run with (MOTIR-8814). The sync bypasses the "App not installed" negative
 * cache so a just-installed App is seen at once.
 */
import type { Project } from '@/generated/prisma/client';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import {
  projectRunnerGroupService,
  type RunnerGroupSyncOutcome,
} from '@/lib/services/projectRunnerGroupService';

export interface SyncScriptResult {
  exitCode: 0 | 1;
  lines: string[];
}

const USAGE = 'usage: --project <KEY> | --project-id <id>';

function parseFlag(argv: readonly string[], flag: string): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1) || null;
    if (arg === flag) return argv[i + 1] ?? null;
  }
  return null;
}

type Resolved = { project: Project } | { refusal: SyncScriptResult };

async function resolveProject(argv: readonly string[]): Promise<Resolved> {
  const key = parseFlag(argv, '--project');
  const id = parseFlag(argv, '--project-id');
  if (!key === !id) return { refusal: { exitCode: 1, lines: [USAGE] } };
  if (id) {
    const project = await withSystemContext((tx) => projectRepository.findById(id, tx));
    if (!project) return { refusal: { exitCode: 1, lines: [`no project has the id ${id}`] } };
    return { project };
  }
  const matches = await withSystemContext((tx) => projectRepository.findAllByIdentifier(key!, tx));
  if (matches.length === 1) return { project: matches[0]! };
  if (matches.length === 0) {
    return { refusal: { exitCode: 1, lines: [`no project has the key ${key}`] } };
  }
  return {
    refusal: {
      exitCode: 1,
      lines: [
        `${matches.length} projects share the key ${key}; refusing to guess`,
        ...matches.map((p) => `  --project-id ${p.id}  (workspace ${p.workspaceId})`),
      ],
    },
  };
}

/** One line per org: the provisioning org's pass, then each connected org. */
export function renderSyncOutcome(result: RunnerGroupSyncOutcome): SyncScriptResult {
  const lines: string[] = [];
  let pending = false;
  if (result.outcome === 'synced') {
    lines.push(
      `provisioning org: synced group=${result.runnerGroupId} repos=[${result.repositoryIds.join(',')}]`,
    );
  } else if (result.outcome === 'sync_pending') {
    pending = true;
    lines.push(`provisioning org: sync_pending (${result.detail})`);
  } else {
    lines.push(`provisioning org: ${result.outcome}`);
  }
  for (const org of result.connectedOrgs ?? []) {
    if (org.outcome === 'sync_pending') pending = true;
    const group = org.runnerGroupId !== undefined ? ` group=${org.runnerGroupId}` : '';
    const repos = org.repositoryIds ? ` repos=[${org.repositoryIds.join(',')}]` : '';
    const detail = org.detail ? ` (${org.detail})` : '';
    lines.push(`${org.org}: ${org.outcome}${group}${repos}${detail}`);
  }
  return { exitCode: pending ? 1 : 0, lines };
}

export async function runSyncProjectRunnerGroups(
  argv: readonly string[],
): Promise<SyncScriptResult> {
  const resolved = await resolveProject(argv);
  if ('refusal' in resolved) return resolved.refusal;
  const { project } = resolved;
  const result = await projectRunnerGroupService.syncForProject(
    { projectId: project.id, workspaceId: project.workspaceId },
    { bypassInstallationCache: true },
  );
  return renderSyncOutcome(result);
}
