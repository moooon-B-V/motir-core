/**
 * E2E helpers for the collaboration-loaded fixture (Subtask 5.6.1) — the
 * accessors the Story 5.6 at-scale specs (5.6.3) assert against.
 *
 * The fixture itself is seeded by `pnpm db:seed:collab` — ALWAYS through
 * `runCollabSeed()` (a child process), never by importing and calling
 * `seedCollabFixture()` from the Playwright runner: the runner process has no
 * Inngest dev server and no blob endpoint, so a service-layer comment write
 * here would throw on its post-commit event (the comments-seed.ts hazard).
 * The runner script (`scripts/seed-collab.ts`) stubs both external seams
 * itself, so the child process works in CI and locally with zero setup.
 *
 * Counts: the specs assert against `collabSeedSizes()` — the SAME env-driven
 * resolver the seed used — so a reduced CI lane (the board-at-scale cap
 * precedent: lower SEED_COLLAB_* env on both the seed step and the spec lane)
 * keeps every assertion consistent. `getCollabFixture()` additionally reports
 * the ACTUAL DB counts for census-style asserts.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from '@/lib/db';
import {
  resolveCollabSeedSizes,
  SEED_COLLAB_LOADED_TITLE,
  SEED_COLLAB_OWNER_EMAIL,
  SEED_COLLAB_PASSWORD,
  SEED_COLLAB_PROJECT_IDENTIFIER,
  SEED_COLLAB_SPREAD_DAYS,
  SEED_COLLAB_WORKSPACE_NAME,
  type CollabSeedSizes,
} from '@/scripts/seedCollabFixture';

const execFileAsync = promisify(execFile);

export {
  SEED_COLLAB_LOADED_TITLE,
  SEED_COLLAB_OWNER_EMAIL,
  SEED_COLLAB_PASSWORD,
  SEED_COLLAB_PROJECT_IDENTIFIER,
  SEED_COLLAB_SPREAD_DAYS,
  SEED_COLLAB_WORKSPACE_NAME,
};
export type { CollabSeedSizes };

/** The env-driven size knobs — the seed and the specs read the same numbers. */
export function collabSeedSizes(): CollabSeedSizes {
  return resolveCollabSeedSizes();
}

/**
 * Run the collab seed as a child process (idempotent — clears and reseeds its
 * own workspace only). Pass `env` to lower the SEED_COLLAB_* knobs for a
 * reduced lane; everything else inherits the runner shell.
 */
export async function runCollabSeed(env: Record<string, string> = {}): Promise<void> {
  await execFileAsync('pnpm', ['db:seed:collab'], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    timeout: 10 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

export interface CollabFixture {
  workspaceId: string;
  projectId: string;
  projectIdentifier: string;
  owner: { id: string; email: string };
  loadedIssue: { id: string; identifier: string; title: string };
  /** Actual DB counts on the loaded issue — the census denominators. */
  counts: {
    comments: number;
    replies: number;
    mentionRows: number;
    panelAttachments: number;
    editorAttachments: number;
    labels: number;
    components: number;
    watchers: number;
    revisions: number;
    customFieldValues: number;
  };
}

/**
 * Resolve the seeded fixture from the DB (run `runCollabSeed()` first). Finds
 * the tenant by its fixed owner email + workspace name and the loaded issue
 * by its canonical title, then reports the actual collection counts the
 * bounded-read census asserts against.
 */
export async function getCollabFixture(): Promise<CollabFixture> {
  const owner = await db.user.findUniqueOrThrow({
    where: { email: SEED_COLLAB_OWNER_EMAIL },
  });
  const workspace = await db.workspace.findFirstOrThrow({
    where: { name: SEED_COLLAB_WORKSPACE_NAME, memberships: { some: { userId: owner.id } } },
  });
  const project = await db.project.findFirstOrThrow({
    where: { workspaceId: workspace.id, identifier: SEED_COLLAB_PROJECT_IDENTIFIER },
  });
  const loaded = await db.workItem.findFirstOrThrow({
    where: { projectId: project.id, title: SEED_COLLAB_LOADED_TITLE },
  });

  const [
    comments,
    replies,
    mentionRows,
    panelAttachments,
    editorAttachments,
    labels,
    components,
    watchers,
    revisions,
    customFieldValues,
  ] = await Promise.all([
    db.comment.count({ where: { workItemId: loaded.id } }),
    db.comment.count({ where: { workItemId: loaded.id, parentCommentId: { not: null } } }),
    db.commentMention.count({ where: { comment: { workItemId: loaded.id } } }),
    db.attachment.count({ where: { workItemId: loaded.id, source: 'panel' } }),
    db.attachment.count({ where: { workItemId: loaded.id, source: 'editor' } }),
    db.workItemLabel.count({ where: { workItemId: loaded.id } }),
    db.workItemComponent.count({ where: { workItemId: loaded.id } }),
    db.watcher.count({ where: { workItemId: loaded.id } }),
    db.workItemRevision.count({ where: { workItemId: loaded.id } }),
    db.customFieldValue.count({ where: { workItemId: loaded.id } }),
  ]);

  return {
    workspaceId: workspace.id,
    projectId: project.id,
    projectIdentifier: project.identifier,
    owner: { id: owner.id, email: owner.email },
    loadedIssue: { id: loaded.id, identifier: loaded.identifier, title: loaded.title },
    counts: {
      comments,
      replies,
      mentionRows,
      panelAttachments,
      editorAttachments,
      labels,
      components,
      watchers,
      revisions,
      customFieldValues,
    },
  };
}
