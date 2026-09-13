import { Prisma, type TestInstructions } from '@/generated/prisma/client';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { testInstructionsRepository } from '@/lib/repositories/testInstructionsRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { toTestInstructionsDto } from '@/lib/mappers/testInstructionsMappers';
import type {
  PublishTestInstructionsResultDTO,
  SetupCommandDTO,
  TestInstructionsDTO,
} from '@/lib/dto/testInstructions';
import {
  TEST_INSTRUCTIONS_MAX_COMMAND_CHARS,
  TEST_INSTRUCTIONS_MAX_PRECONDITION_BYTES,
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
 * `docs/decisions/approval-gates.md` §9).
 *
 * A work item carries ONE CURRENT record per repository its pull requests land
 * in, and keeps every earlier version as history — the `design_evidence` shape.
 * This service is the only writer. It ends at a record that can be written and
 * read; the MCP door (MOTIR-5331), the per-pull-request read (MOTIR-5333) and
 * the rendering (MOTIR-5336) sit on top of it.
 */

export interface PublishTestInstructionsInput {
  workItemId: string;
  /** The `GithubRepo` id — must be one of the item's project repositories. */
  repoId: string;
  /** The head commit the instructions were written for. */
  commitSha: string;
  clickPathSteps?: readonly string[] | null;
  clickPathNotApplicable?: boolean | null;
  clickPathNotApplicableReason?: string | null;
  previewPath?: string | null;
  setupCommands?: readonly SetupCommandDTO[] | null;
  preconditionMd?: string | null;
  /** The run that wrote it. The MCP door resolves this server-side; never agent-supplied. */
  dispatchRunId?: string | null;
}

/** The validated, normalised content a record stores — also what "identical" compares. */
interface NormalizedContent {
  commitSha: string;
  clickPathSteps: string[];
  clickPathNotApplicable: boolean;
  clickPathNotApplicableReason: string | null;
  previewPath: string | null;
  setupCommands: SetupCommandDTO[];
  preconditionMd: string | null;
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
  const commitSha = input.commitSha.trim().toLowerCase();
  if (!COMMIT_SHA.test(commitSha)) {
    throw new TestInstructionsInvalidFieldError(
      'commitSha',
      'expected a hex commit id of 7 to 64 characters.',
    );
  }

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

  const rawCommands = input.setupCommands ?? [];
  if (rawCommands.length > TEST_INSTRUCTIONS_MAX_SETUP_COMMANDS) {
    throw new TestInstructionsCapExceededError(
      'setupCommands',
      TEST_INSTRUCTIONS_MAX_SETUP_COMMANDS,
      'items',
    );
  }
  const setupCommands = rawCommands.map((entry, index) => {
    const label = entry.label.trim();
    const command = entry.command.trim();
    if (!label || !command) {
      throw new TestInstructionsInvalidFieldError(
        `setupCommands[${index}]`,
        'both "label" and "command" are required.',
      );
    }
    assertChars(`setupCommands[${index}].label`, label, TEST_INSTRUCTIONS_MAX_STEP_CHARS);
    assertChars(`setupCommands[${index}].command`, command, TEST_INSTRUCTIONS_MAX_COMMAND_CHARS);
    return { label, command };
  });

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

  return {
    commitSha,
    clickPathSteps,
    clickPathNotApplicable,
    clickPathNotApplicableReason: clickPathNotApplicable ? clickPathNotApplicableReason : null,
    previewPath,
    setupCommands,
    preconditionMd,
  };
}

/** Does a stored row carry exactly this content? (The idempotency comparison.) */
function sameContent(row: TestInstructions, content: NormalizedContent): boolean {
  const dto = toTestInstructionsDto(row);
  return (
    dto.commitSha === content.commitSha &&
    dto.clickPathNotApplicable === content.clickPathNotApplicable &&
    dto.clickPathNotApplicableReason === content.clickPathNotApplicableReason &&
    dto.previewPath === content.previewPath &&
    dto.preconditionMd === content.preconditionMd &&
    JSON.stringify(dto.clickPathSteps) === JSON.stringify(content.clickPathSteps) &&
    JSON.stringify(dto.setupCommands) === JSON.stringify(content.setupCommands)
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

export const testInstructionsService = {
  /**
   * Write a HOW TO TEST record for one (work item, repository), making it the
   * pair's current version.
   *
   * - Asserts `work_item:edit` on the ITEM's project (resolved from the item,
   *   never from the actor's active project — the MOTIR-2365 gate).
   * - Refuses a repository that is not one of that project's repositories.
   * - IDEMPOTENT on `(workItemId, repoId, commitSha)`: identical content for a
   *   commit already recorded returns that row and writes nothing (an agent's
   *   retry); different content for the same commit becomes the new current row.
   *
   * ⚠️ CONCURRENCY. The write is read-derived — it reads what is current and
   * replaces it — and an agent retries on an unclear result, so two publishes
   * for one pair WILL race. Locking the current `test_instructions` row (the
   * `design_evidence` precedent) is not enough here: on a pair's FIRST publish
   * there is no row to lock, both callers would insert, and one would hit the
   * partial unique index. So the transaction locks the WORK ITEM row, which
   * always exists, before reading; the second publish waits, then sees the
   * first's outcome. The index stays as the backstop, translated to a typed error.
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
          const member = await projectRepoRepository.findByProjectAndGithubRepoId(
            item.projectId,
            input.repoId,
            tx,
          );
          if (!member) {
            const set = await projectRepoRepository.listByProject(
              item.projectId,
              ctx.workspaceId,
              tx,
            );
            const valid = set.flatMap((row) =>
              row.githubRepo ? [`${row.githubRepo.owner}/${row.githubRepo.name}`] : [],
            );
            throw new TestInstructionsRepoNotInProjectError(input.repoId, valid);
          }

          // Serialise every publish for this item BEFORE the read that decides.
          const locked = await workItemRepository.lockById(item.id, tx);
          if (!locked) throw new TestInstructionsWorkItemNotFoundError(input.workItemId);

          const existing = await testInstructionsRepository.findLatestByCommit(
            item.id,
            input.repoId,
            content.commitSha,
            tx,
          );
          if (existing && sameContent(existing, content)) {
            return { record: toTestInstructionsDto(existing), created: false };
          }

          await testInstructionsRepository.markNotCurrentByPair(item.id, input.repoId, tx);
          const row = await testInstructionsRepository.create(
            {
              workspaceId: ctx.workspaceId,
              projectId: item.projectId,
              workItemId: item.id,
              repoId: input.repoId,
              commitSha: content.commitSha,
              clickPathSteps: content.clickPathSteps,
              clickPathNotApplicable: content.clickPathNotApplicable,
              clickPathNotApplicableReason: content.clickPathNotApplicableReason,
              previewPath: content.previewPath,
              setupCommands: content.setupCommands.map((c) => ({
                label: c.label,
                command: c.command,
              })),
              preconditionMd: content.preconditionMd,
              dispatchRunId: input.dispatchRunId ?? null,
              publishedById: ctx.userId,
              isCurrent: true,
            },
            tx,
          );
          return { record: toTestInstructionsDto(row), created: true };
        },
      );
    } catch (err) {
      throw translateTestInstructionsConflict(err, input.workItemId);
    }
  },

  /**
   * Every CURRENT record for one work item — one per repository — for a reader
   * holding `project:browse` on the item's project.
   */
  async listCurrentForWorkItem(
    workItemId: string,
    ctx: ServiceContext,
  ): Promise<TestInstructionsDTO[]> {
    const item = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => workItemRepository.findById(workItemId, tx),
    );
    if (!item) throw new TestInstructionsWorkItemNotFoundError(workItemId);
    await projectAccessService.assertPermission(item.projectId, ctx, 'project:browse');
    const rows = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => testInstructionsRepository.listCurrentByWorkItem(item.id, tx),
    );
    return rows.map(toTestInstructionsDto);
  },
};
