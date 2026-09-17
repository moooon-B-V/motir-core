import { Prisma } from '@/generated/prisma/client';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import {
  testInstructionsRepository,
  type TestInstructionsWithRepos,
} from '@/lib/repositories/testInstructionsRepository';
import { testInstructionsRepoRepository } from '@/lib/repositories/testInstructionsRepoRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workItemsService } from '@/lib/services/workItemsService';
import { normalizeCommitSha } from '@/lib/git/commitSha';
import { liveHeadSha, pickPullRequest } from '@/lib/howToTest/assemble';
import { toTestInstructionsDto } from '@/lib/mappers/testInstructionsMappers';
import type {
  CurrentTestInstructionsDTO,
  HowToTestDraftDTO,
  HowToTestDraftProjectRepoDTO,
  HowToTestDraftSectionDTO,
  PublishTestInstructionsResultDTO,
  TestInstructionsDTO,
} from '@/lib/dto/testInstructions';
import {
  TEST_INSTRUCTIONS_MAX_BODY_BYTES,
  TEST_INSTRUCTIONS_MAX_REPOS,
  TEST_INSTRUCTIONS_MAX_SHORT_TEXT_CHARS,
} from '@/lib/testInstructions/caps';
import {
  TestInstructionsCapExceededError,
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
 * it was launched against — its content RICH TEXT (`bodyMd`, sections allowed,
 * commands in fenced code blocks) and one section per repository it touched. The target keeps exactly one CURRENT record (the newest
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
  /** The head commit the run pushed to this repository. */
  commitSha: string;
}

export interface PublishTestInstructionsInput {
  /** The run target. */
  workItemId: string;
  /** The run's HOW TO TEST as rich text (Markdown). Stored as written, trimmed. */
  bodyMd: string;
  previewPath?: string | null;
  /** One entry per repository the run pushed to — at least one. */
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
}

/** The validated, normalised content a record stores — also what "identical" compares. */
interface NormalizedContent {
  bodyMd: string;
  previewPath: string | null;
  repos: NormalizedRepoSection[];
}

// The commit-id pattern and its normalisation moved to `@/lib/git/commitSha`
// (MOTIR-5619) — this rule was the only one of the three publish paths that had
// it, and the acceptance-receipt path stored whatever it was handed. Defining it
// once is what stops the doors on one card refusing different things.

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
 * The body is NOT parsed: its sections and code blocks are the agent's, and the
 * one Markdown pipeline renders them.
 *
 * Exported so the rules are unit-testable without a database.
 */
export function normalizeTestInstructionsContent(
  input: PublishTestInstructionsInput,
): NormalizedContent {
  const bodyMd = (input.bodyMd ?? '').trim();
  if (!bodyMd) {
    throw new TestInstructionsInvalidFieldError(
      'bodyMd',
      'write How to test as Markdown — sections for the precondition, local setup and click-path, every command in a fenced code block.',
    );
  }
  if (Buffer.byteLength(bodyMd, 'utf8') > TEST_INSTRUCTIONS_MAX_BODY_BYTES) {
    throw new TestInstructionsCapExceededError('bodyMd', TEST_INSTRUCTIONS_MAX_BODY_BYTES, 'bytes');
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
    const sha = normalizeCommitSha(entry.commitSha);
    if (!sha.ok) {
      throw new TestInstructionsInvalidFieldError(`${field}.commitSha`, sha.reason);
    }
    const commitSha = sha.commitSha;
    const repoId = blankToNull(entry.repoId);
    const repoRef = blankToNull(entry.repoRef);
    if ((repoId === null) === (repoRef === null)) {
      throw new TestInstructionsInvalidFieldError(
        `${field}.repo`,
        'name exactly one repository — by id or by name.',
      );
    }
    return { repoId, repoRef, commitSha };
  });

  return { bodyMd, previewPath, repos };
}

/** A section once its repository is resolved to a project `GithubRepo` id. */
interface ResolvedRepoSection {
  repoId: string;
  commitSha: string;
}

/** Does a stored record carry exactly this content? (The idempotency comparison.) */
function sameContent(
  row: TestInstructionsWithRepos,
  content: NormalizedContent,
  repos: readonly ResolvedRepoSection[],
): boolean {
  const dto = toTestInstructionsDto(row);
  return (
    dto.bodyMd === content.bodyMd &&
    dto.previewPath === content.previewPath &&
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
    return { repoId, commitSha: section.commitSha };
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
              bodyMd: content.bodyMd,
              previewPath: content.previewPath,
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
   * The DRAFT a PERSON's How-to-test form opens on (Story MOTIR-5450 · Subtask
   * MOTIR-5453; `approval-gates.md` §9's 2026-09-17 amendment, point 3).
   *
   * `publish` above is already the one writer for both author kinds — a person
   * calls it with `attributeToRunningDispatch` left false, which is what records
   * `dispatchRunId: null` and `publishedById` the person. What a person is
   * missing is not a write path, it is a FILLED-IN FORM, and that is all this is.
   *
   * SUGGESTED, NEVER FORCED. It offers what Motir already knows:
   *
   * - **Editing** (a current record exists) — that record's body, preview path
   *   and sections, each `source: 'record'`.
   * - **Adding** (no record) — an empty body and one section per repository that
   *   has a LINKED pull request, the item's own before its descendants' (the
   *   read's own `pickPullRequest` tiering, so the form and the block bind the
   *   same pull request), with that pull request's live head as the commit and
   *   `source: 'pull_request'`.
   *
   * `commitSha` is NULL when the bound pull request has no check row yet: the
   * head is only known once a check reports one, and inventing a commit for a
   * field `publish` validates would be worse than asking for it.
   *
   * ⚠️ IT VALIDATES NOTHING, deliberately. Every value here is re-checked by
   * `publish` — the 7-to-64-hex commit, the repository being one of the
   * project's, the same repository not appearing twice, both caps. A draft that
   * suggests nothing at all is still savable, because an agent does not need a
   * linked pull request either, and the form's refusals must be `publish`'s or
   * the two authors have drifted apart.
   *
   * Asserts **`work_item:edit`** rather than `project:browse`: the draft exists
   * only for somebody who may save it, and it is the permission `publish` and
   * the explicit pull-request link both assert.
   *
   * ⚠️ BOUNDED QUERIES, independent of how many repositories, pull requests or
   * descendants the item has: the current record (1), the subtree (1), the
   * project's repositories (1), and the subtree's deliveries with their check
   * rows (1) — four, always. The deliveries read is the one that cannot join the
   * others, because its key set is what the subtree returns.
   */
  async getDraftForWorkItem(workItemId: string, ctx: ServiceContext): Promise<HowToTestDraftDTO> {
    const binding = { userId: ctx.userId, workspaceId: ctx.workspaceId };

    const item = await withWorkspaceContext(binding, (tx) =>
      workItemRepository.findById(workItemId, tx),
    );
    if (!item) throw new TestInstructionsWorkItemNotFoundError(workItemId);
    await projectAccessService.assertPermission(item.projectId, ctx, 'work_item:edit');

    return withWorkspaceContext(binding, async (tx) => {
      const [current, subtree, projectRepos] = await Promise.all([
        testInstructionsRepository.findCurrentForWorkItem(item.id, tx),
        workItemRepository.findSubtree(item.id, tx),
        projectRepoRepository.listByProject(item.projectId, ctx.workspaceId, tx),
      ]);
      const descendantIds = subtree.filter((row) => row.id !== item.id).map((row) => row.id);
      const deliveries = await workItemDeliveryRepository.listByWorkItemsWithChecks(
        [item.id, ...descendantIds],
        tx,
      );

      // `owner/name` for anything either read can name. A record's section whose
      // repository has since been unlinked from the project keeps the same
      // repoId fallback the block uses (`howToTestService.getForWorkItem`), so
      // the form and the block never disagree about one repository.
      const nameOf = new Map<string, string>();
      for (const row of projectRepos) {
        if (row.githubRepo)
          nameOf.set(row.githubRepo.id, `${row.githubRepo.owner}/${row.githubRepo.name}`);
      }
      for (const delivery of deliveries)
        nameOf.set(delivery.repo.id, `${delivery.repo.owner}/${delivery.repo.name}`);

      const projectRepoDtos: HowToTestDraftProjectRepoDTO[] = projectRepos.flatMap((row) =>
        row.githubRepo
          ? [
              {
                repoId: row.githubRepo.id,
                repoName: `${row.githubRepo.owner}/${row.githubRepo.name}`,
              },
            ]
          : [],
      );

      if (current) {
        const record = toTestInstructionsDto(current);
        return {
          bodyMd: record.bodyMd,
          previewPath: record.previewPath,
          sections: record.repos.map((section) => ({
            repoId: section.repoId,
            repoName: nameOf.get(section.repoId) ?? section.repoId,
            commitSha: section.commitSha,
            source: 'record' as const,
          })),
          projectRepos: projectRepoDtos,
        };
      }

      const toPr = (delivery: (typeof deliveries)[number]) => ({
        id: delivery.pullRequest.id,
        repoId: delivery.pullRequest.repoId,
        state: delivery.pullRequest.state,
        checkRuns: delivery.pullRequest.checkRuns,
      });
      const own = deliveries.filter((d) => d.workItemId === item.id).map(toPr);
      const descendants = deliveries.filter((d) => d.workItemId !== item.id).map(toPr);

      // One section per repository, the item's OWN repositories first — the same
      // tiering `pickPullRequest` applies within a repository, applied to the
      // ORDER the rows are offered in.
      const repoIds: string[] = [];
      for (const tier of [own, descendants]) {
        for (const pr of tier) if (!repoIds.includes(pr.repoId)) repoIds.push(pr.repoId);
      }
      const sections: HowToTestDraftSectionDTO[] = repoIds.map((repoId) => {
        const bound = pickPullRequest(repoId, own, descendants);
        return {
          repoId,
          repoName: nameOf.get(repoId) ?? repoId,
          commitSha: bound ? liveHeadSha(bound.checkRuns) : null,
          source: 'pull_request' as const,
        };
      });

      return { bodyMd: '', previewPath: null, sections, projectRepos: projectRepoDtos };
    });
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
