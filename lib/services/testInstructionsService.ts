import { Prisma } from '@/generated/prisma/client';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import {
  testInstructionsRepository,
  type TestInstructionsWithRepos,
} from '@/lib/repositories/testInstructionsRepository';
import { testInstructionsRepoRepository } from '@/lib/repositories/testInstructionsRepoRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workItemsService } from '@/lib/services/workItemsService';
import { toTestInstructionsDto } from '@/lib/mappers/testInstructionsMappers';
import type {
  CurrentTestInstructionsDTO,
  PublishTestInstructionsResultDTO,
  SetupCommandDTO,
  TestInstructionsDTO,
} from '@/lib/dto/testInstructions';
import {
  TEST_INSTRUCTIONS_MAX_COMMAND_CHARS,
  TEST_INSTRUCTIONS_MAX_PRECONDITION_BYTES,
  TEST_INSTRUCTIONS_MAX_REPOS,
  TEST_INSTRUCTIONS_MAX_SETUP_COMMANDS,
  TEST_INSTRUCTIONS_MAX_SHORT_TEXT_CHARS,
  TEST_INSTRUCTIONS_MAX_STEP_CHARS,
  TEST_INSTRUCTIONS_MAX_STEPS,
} from '@/lib/testInstructions/caps';
import {
  TestInstructionsCapExceededError,
  TestInstructionsClickPathError,
  TestInstructionsConflictError,
  TestInstructionsInvalidFieldError,
  TestInstructionsRepoNotInProjectError,
  TestInstructionsWorkItemNotFoundError,
} from '@/lib/testInstructions/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

/**
 * HOW TO TEST — business logic (Story MOTIR-4906 · Subtask MOTIR-5328;
 * `docs/decisions/approval-gates.md` §9 and its 2026-09-13 amendment).
 *
 * HOW TO TEST is per RUN. A run writes ONE record onto its RUN TARGET — the item
 * it was launched against — with one click-path for the run and one section per
 * repository it touched. The target keeps exactly one CURRENT record (the newest
 * run's) and every earlier run's as history — the `design_evidence` shape. This
 * service is the only writer. It ends at a record that can be written and read;
 * the MCP door (MOTIR-5331), the read (MOTIR-5333) and the rendering (MOTIR-5336)
 * sit on top of it.
 */

/** One repository section of a publish. */
export interface PublishTestInstructionsRepoInput {
  /**
   * The repository, as EITHER the `GithubRepo` id (`repoId`) OR how a person
   * names it (`repoRef`: `name` or `owner/name`) — exactly one. Either way it
   * must be one of the item's project repositories.
   */
  repoId?: string | null;
  repoRef?: string | null;
  /** The head commit this repository's section was written for. */
  commitSha: string;
  setupCommands?: readonly SetupCommandDTO[] | null;
}

export interface PublishTestInstructionsInput {
  /** The run target. */
  workItemId: string;
  clickPathSteps?: readonly string[] | null;
  clickPathNotApplicable?: boolean | null;
  clickPathNotApplicableReason?: string | null;
  previewPath?: string | null;
  preconditionMd?: string | null;
  /** One entry per repository the run touched — at least one. */
  repos: readonly PublishTestInstructionsRepoInput[];
  /**
   * Attribute the record to the newest RUNNING dispatch run targeting or
   * carrying this item (the MCP door sets it; MOTIR-5331). Never an id the
   * caller passes: an agent cannot know it, and must not be able to claim
   * another run's.
   */
  attributeToRunningDispatch?: boolean;
}

/** One validated, normalised repository section (its repository not yet resolved). */
interface NormalizedRepoSection {
  repoId: string | null;
  repoRef: string | null;
  commitSha: string;
  setupCommands: SetupCommandDTO[];
}

/** The validated, normalised content a record stores — also what "identical" compares. */
interface NormalizedContent {
  clickPathSteps: string[];
  clickPathNotApplicable: boolean;
  clickPathNotApplicableReason: string | null;
  previewPath: string | null;
  preconditionMd: string | null;
  repos: NormalizedRepoSection[];
}

/** A git object id: SHA-1 (40) or SHA-256 (64), abbreviated to no fewer than 7. */
const COMMIT_SHA = /^[0-9a-f]{7,64}$/;

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function assertChars(field: string, value: string, cap: number): void {
  if (value.length > cap) throw new TestInstructionsCapExceededError(field, cap, 'characters');
}

/**
 * Validate and normalise a publish's content. Every bound is a typed refusal
 * naming the field — never a silent truncation (lib/testInstructions/caps.ts).
 *
 * Exported so the rules are unit-testable without a database.
 */
export function normalizeTestInstructionsContent(
  input: PublishTestInstructionsInput,
): NormalizedContent {
  const rawSteps = input.clickPathSteps ?? [];
  if (rawSteps.length > TEST_INSTRUCTIONS_MAX_STEPS) {
    throw new TestInstructionsCapExceededError(
      'clickPathSteps',
      TEST_INSTRUCTIONS_MAX_STEPS,
      'items',
    );
  }
  const clickPathSteps = rawSteps.map((step, index) => {
    const trimmed = step.trim();
    if (!trimmed) {
      throw new TestInstructionsInvalidFieldError(
        `clickPathSteps[${index}]`,
        'a step cannot be empty.',
      );
    }
    assertChars(`clickPathSteps[${index}]`, trimmed, TEST_INSTRUCTIONS_MAX_STEP_CHARS);
    return trimmed;
  });

  // Exactly one of: steps given, or declared not applicable (with a reason).
  const clickPathNotApplicable = input.clickPathNotApplicable === true;
  const clickPathNotApplicableReason = blankToNull(input.clickPathNotApplicableReason);
  if (clickPathNotApplicable && clickPathSteps.length > 0) {
    throw new TestInstructionsClickPathError('both');
  }
  if (!clickPathNotApplicable && clickPathSteps.length === 0) {
    throw new TestInstructionsClickPathError('neither');
  }
  if (clickPathNotApplicable && !clickPathNotApplicableReason) {
    throw new TestInstructionsClickPathError('reason_missing');
  }
  if (clickPathNotApplicableReason) {
    assertChars(
      'clickPathNotApplicableReason',
      clickPathNotApplicableReason,
      TEST_INSTRUCTIONS_MAX_SHORT_TEXT_CHARS,
    );
  }

  // A PATH on the preview host, never a URL. A protocol-relative `//host` would
  // change the host once the read joins it onto the preview URL, so it is refused.
  const previewPath = blankToNull(input.previewPath);
  if (previewPath) {
    if (!previewPath.startsWith('/') || previewPath.startsWith('//')) {
      throw new TestInstructionsInvalidFieldError(
        'previewPath',
        'expected a path starting with a single "/", e.g. "/items/ACME-7".',
      );
    }
    assertChars('previewPath', previewPath, TEST_INSTRUCTIONS_MAX_SHORT_TEXT_CHARS);
  }

  const preconditionMd = blankToNull(input.preconditionMd);
  if (
    preconditionMd &&
    Buffer.byteLength(preconditionMd, 'utf8') > TEST_INSTRUCTIONS_MAX_PRECONDITION_BYTES
  ) {
    throw new TestInstructionsCapExceededError(
      'preconditionMd',
      TEST_INSTRUCTIONS_MAX_PRECONDITION_BYTES,
      'bytes',
    );
  }

  const rawRepos = input.repos ?? [];
  if (rawRepos.length === 0) {
    throw new TestInstructionsInvalidFieldError(
      'repos',
      'give one entry per repository the run pushed to — at least one.',
    );
  }
  if (rawRepos.length > TEST_INSTRUCTIONS_MAX_REPOS) {
    throw new TestInstructionsCapExceededError('repos', TEST_INSTRUCTIONS_MAX_REPOS, 'items');
  }
  const repos = rawRepos.map((entry, r) => {
    const field = `repos[${r}]`;
    const commitSha = entry.commitSha.trim().toLowerCase();
    if (!COMMIT_SHA.test(commitSha)) {
      throw new TestInstructionsInvalidFieldError(
        `${field}.commitSha`,
        'expected a hex commit id of 7 to 64 characters.',
      );
    }
    const rawCommands = entry.setupCommands ?? [];
    if (rawCommands.length > TEST_INSTRUCTIONS_MAX_SETUP_COMMANDS) {
      throw new TestInstructionsCapExceededError(
        `${field}.setupCommands`,
        TEST_INSTRUCTIONS_MAX_SETUP_COMMANDS,
        'items',
      );
    }
    const setupCommands = rawCommands.map((cmd, index) => {
      const label = cmd.label.trim();
      const command = cmd.command.trim();
      if (!label || !command) {
        throw new TestInstructionsInvalidFieldError(
          `${field}.setupCommands[${index}]`,
          'both "label" and "command" are required.',
        );
      }
      assertChars(
        `${field}.setupCommands[${index}].label`,
        label,
        TEST_INSTRUCTIONS_MAX_STEP_CHARS,
      );
      assertChars(
        `${field}.setupCommands[${index}].command`,
        command,
        TEST_INSTRUCTIONS_MAX_COMMAND_CHARS,
      );
      return { label, command };
    });
    const repoId = blankToNull(entry.repoId);
    const repoRef = blankToNull(entry.repoRef);
    if ((repoId === null) === (repoRef === null)) {
      throw new TestInstructionsInvalidFieldError(
        `${field}.repo`,
        'name exactly one repository — by id or by name.',
      );
    }
    return { repoId, repoRef, commitSha, setupCommands };
  });

  return {
    clickPathSteps,
    clickPathNotApplicable,
    clickPathNotApplicableReason: clickPathNotApplicable ? clickPathNotApplicableReason : null,
    previewPath,
    preconditionMd,
    repos,
  };
}

/** A section once its repository is resolved to a project `GithubRepo` id. */
interface ResolvedRepoSection {
  repoId: string;
  commitSha: string;
  setupCommands: SetupCommandDTO[];
}

/** Does a stored record carry exactly this content? (The idempotency comparison.) */
function sameContent(
  row: TestInstructionsWithRepos,
  content: NormalizedContent,
  repos: readonly ResolvedRepoSection[],
): boolean {
  const dto = toTestInstructionsDto(row);
  return (
    dto.clickPathNotApplicable === content.clickPathNotApplicable &&
    dto.clickPathNotApplicableReason === content.clickPathNotApplicableReason &&
    dto.previewPath === content.previewPath &&
    dto.preconditionMd === content.preconditionMd &&
    JSON.stringify(dto.clickPathSteps) === JSON.stringify(content.clickPathSteps) &&
    JSON.stringify(dto.repos) === JSON.stringify(repos)
  );
}

/**
 * Translate a lost one-current race into a typed error so a raw `P2002` never
 * escapes the service. Exported so the mapping is testable without a real race.
 */
export function translateTestInstructionsConflict(err: unknown, workItemId: string): unknown {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return new TestInstructionsConflictError(workItemId);
  }
  return err;
}

/**
 * Resolve every section's repository to a `GithubRepo` id that is one of the
 * project's repositories, or refuse naming the valid set. A repository named
 * twice (by any spelling) is refused — a run has one section per repository.
 *
 * `repoRef` matches the realized repository's `name` or `owner/name`,
 * case-insensitively. A bare name shared by two repositories under different
 * owners is ambiguous and refused — the valid set in the message shows the
 * `owner/name` to use instead.
 */
async function resolveProjectRepoSections(
  projectId: string,
  sections: readonly NormalizedRepoSection[],
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<ResolvedRepoSection[]> {
  const set = await projectRepoRepository.listByProject(projectId, ctx.workspaceId, tx);
  const realized = set.flatMap((row) => (row.githubRepo ? [row.githubRepo] : []));
  const valid = realized.map((r) => `${r.owner}/${r.name}`);
  const seen = new Set<string>();

  return sections.map((section, index) => {
    let repoId: string;
    if (section.repoId !== null) {
      if (!realized.some((r) => r.id === section.repoId)) {
        throw new TestInstructionsRepoNotInProjectError(section.repoId, valid);
      }
      repoId = section.repoId;
    } else {
      const wanted = section.repoRef!.toLowerCase();
      const matches = realized.filter(
        (r) => `${r.owner}/${r.name}`.toLowerCase() === wanted || r.name.toLowerCase() === wanted,
      );
      if (matches.length !== 1)
        throw new TestInstructionsRepoNotInProjectError(section.repoRef!, valid);
      repoId = matches[0]!.id;
    }
    if (seen.has(repoId)) {
      throw new TestInstructionsInvalidFieldError(
        `repos[${index}].repo`,
        'this repository already has a section — give one entry per repository.',
      );
    }
    seen.add(repoId);
    return { repoId, commitSha: section.commitSha, setupCommands: section.setupCommands };
  });
}

export const testInstructionsService = {
  /**
   * Write a run's HOW TO TEST record onto its run target, making it the
   * target's current version.
   *
   * - Asserts `work_item:edit` on the ITEM's project (resolved from the item,
   *   never from the actor's active project — the MOTIR-2365 gate).
   * - Refuses a repository that is not one of that project's repositories, and a
   *   repository named twice.
   * - IDEMPOTENT PER RUN: when the target's current record was written by the
   *   same run (or both by none) with identical content, it is returned and
   *   nothing is written (an agent's retry). Different content from the same
   *   run, or any publish from another run, becomes the new current record and
   *   the previous one stays as history.
   *
   * ⚠️ CONCURRENCY. The write is read-derived — it reads what is current and
   * replaces it — and an agent retries on an unclear result, so two publishes
   * for one target WILL race. Locking the current `test_instructions` row (the
   * `design_evidence` precedent) is not enough: on a target's FIRST publish there
   * is no row to lock, both callers would insert, and one would hit the partial
   * unique index. So the transaction locks the WORK ITEM row, which always
   * exists, before reading; the second publish waits, then sees the first's
   * outcome. The index stays as the backstop, translated to a typed error.
   */
  async publish(
    input: PublishTestInstructionsInput,
    ctx: ServiceContext,
  ): Promise<PublishTestInstructionsResultDTO> {
    const content = normalizeTestInstructionsContent(input);

    const item = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => workItemRepository.findById(input.workItemId, tx),
    );
    if (!item) throw new TestInstructionsWorkItemNotFoundError(input.workItemId);
    await projectAccessService.assertPermission(item.projectId, ctx, 'work_item:edit');

    try {
      return await withWorkspaceContext(
        { userId: ctx.userId, workspaceId: ctx.workspaceId },
        async (tx) => {
          const repos = await resolveProjectRepoSections(item.projectId, content.repos, ctx, tx);
          // Serialise every publish for this item BEFORE the read that decides.
          const locked = await workItemRepository.lockById(item.id, tx);
          if (!locked) throw new TestInstructionsWorkItemNotFoundError(input.workItemId);

          const dispatchRunId = input.attributeToRunningDispatch
            ? await dispatchRunRepository.findLatestRunningIdForWorkItem(item.id, tx)
            : null;

          const current = await testInstructionsRepository.findCurrentForWorkItem(item.id, tx);
          if (
            current &&
            current.dispatchRunId === dispatchRunId &&
            sameContent(current, content, repos)
          ) {
            return { record: toTestInstructionsDto(current), created: false };
          }

          await testInstructionsRepository.clearCurrent(item.id, tx);
          const { id } = await testInstructionsRepository.insert(
            {
              workspaceId: ctx.workspaceId,
              projectId: item.projectId,
              workItemId: item.id,
              clickPathSteps: content.clickPathSteps,
              clickPathNotApplicable: content.clickPathNotApplicable,
              clickPathNotApplicableReason: content.clickPathNotApplicableReason,
              previewPath: content.previewPath,
              preconditionMd: content.preconditionMd,
              dispatchRunId,
              publishedById: ctx.userId,
              isCurrent: true,
            },
            tx,
          );
          await testInstructionsRepoRepository.createMany(
            repos.map((section, position) => ({
              workspaceId: ctx.workspaceId,
              projectId: item.projectId,
              testInstructionsId: id,
              repoId: section.repoId,
              commitSha: section.commitSha,
              setupCommands: section.setupCommands.map((c) => ({
                label: c.label,
                command: c.command,
              })),
              position,
            })),
            tx,
          );
          const row = await testInstructionsRepository.findById(id, tx);
          return { record: toTestInstructionsDto(row!), created: true };
        },
      );
    } catch (err) {
      throw translateTestInstructionsConflict(err, input.workItemId);
    }
  },

  /**
   * The CURRENT record for a run target named by its KEY, with each section's
   * repository `owner/name` — the public read a CLI renders into a session pull
   * request body (MOTIR-5358). `record: null` when no run has written one.
   * Requires `project:browse` on the item's project.
   */
  async getCurrentByIdentifier(
    projectId: string,
    identifier: string,
    ctx: ServiceContext,
  ): Promise<CurrentTestInstructionsDTO> {
    const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx);
    const record = await this.getCurrentForWorkItem(item.id, ctx);
    if (!record) return { workItemKey: item.identifier, record: null };
    const repos = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => projectRepoRepository.listByProject(item.projectId, ctx.workspaceId, tx),
    );
    const nameOf = new Map(
      repos.flatMap((row) =>
        row.githubRepo
          ? [[row.githubRepo.id, `${row.githubRepo.owner}/${row.githubRepo.name}`]]
          : [],
      ),
    );
    return {
      workItemKey: item.identifier,
      record: {
        ...record,
        repos: record.repos.map((section) => ({
          ...section,
          repoName: nameOf.get(section.repoId) ?? null,
        })),
      },
    };
  },

  /**
   * The CURRENT record for one run target (or null), for a reader holding
   * `project:browse` on the item's project.
   */
  async getCurrentForWorkItem(
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<TestInstructionsDTO | null> {
    const item = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => workItemRepository.findById(workItemId, tx),
    );
    if (!item) throw new TestInstructionsWorkItemNotFoundError(workItemId);
    await projectAccessService.assertPermission(item.projectId, ctx, 'project:browse');
    const row = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => testInstructionsRepository.findCurrentForWorkItem(item.id, tx),
    );
    return row ? toTestInstructionsDto(row) : null;
  },
};
