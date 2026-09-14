import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import {
  TEST_INSTRUCTIONS_MAX_BODY_BYTES,
  TEST_INSTRUCTIONS_MAX_REPOS,
  TEST_INSTRUCTIONS_MAX_SHORT_TEXT_CHARS,
} from '@/lib/testInstructions/caps';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { normalizeIdentifier, projectKeyOf, workItemKeyField } from './workItemRef';

// `publish_test_instructions` (Story MOTIR-4906 · Subtask MOTIR-5331) — the door an
// agent writes a RUN's HOW TO TEST through, onto the RUN TARGET (the item the run
// was launched against) rather than into a pull-request body Motir cannot read
// (`docs/decisions/approval-gates.md` §9 and its 2026-09-13 amendment: per RUN,
// one record, its content RICH TEXT, a section per repository — the way
// `publish_design_result` takes a design note). A thin adapter over
// `testInstructionsService.publish` (MOTIR-5328): the caps, the click-path XOR,
// the repository-in-project check and the per-run idempotency all run there.
//
// ⚠️ THE ACTOR IS A SANDBOXED AGENT — a single-card dispatched agent, a scoped
// run's close-out agent, or a runbook session — so the key is `work_item:edit`,
// the one `publish_design_result` / `publish_acceptance_result` assert and one
// `CLI_TOKEN_GRANT` already carries. A key outside that grant would make the door
// unreachable for exactly the caller it exists for.
//
// ⚠️ THE OWING RUN IS RESOLVED SERVER-SIDE (`attributeToRunningDispatch`), never
// taken as an argument: an agent cannot know its run's id, and must not be able
// to attribute a record to somebody else's.
//
// ⚠️ THE CAPS ARE STATED IN THE SCHEMA'S DESCRIPTIONS, NOT ENFORCED AS zod BOUNDS.
// A zod `.max()` would refuse an over-cap call at argument parsing with the SDK's
// generic validation error; leaving the bound to the service refuses it with
// `TEST_INSTRUCTIONS_CAP_EXCEEDED` naming the field and the limit, which is the
// sentence an agent can act on. The numbers come from the shared constants either way.
//
// EXEMPT from payload derivation (`payloads/exemptions.ts`): no `/api/v1`
// operation exposes a How-to-test record, so there is no shared shape to derive from.

export const PUBLISH_TEST_INSTRUCTIONS_TOOL_NAME = 'publish_test_instructions';

const repoSectionSchema = z.object({
  repo: z
    .string()
    .min(1)
    .describe(
      'The repository — its name ("web") or "owner/name" ("acme/web"). It must be one of the ' +
        'work item’s project repositories, and appear once.',
    ),
  commitSha: z.string().min(1).describe('The head commit the run pushed to this repository.'),
});

const inputSchema = {
  key: workItemKeyField.describe(
    'The RUN TARGET — the work item the run was launched against (e.g. "ACME-7"): the story ' +
      'for a story or scoped run, the card itself for a single-card run. Case-insensitive.',
  ),
  bodyMd: z
    .string()
    .describe(
      'How to test this run, as Markdown. Use SECTIONS — e.g. "## Precondition" (the sign-in, ' +
        'role or data the surface needs), "## Locally" (setup after checking out the branch: ' +
        'install, migrate, seed, run) and "## Click-path" (what to open, click and expect to SEE) ' +
        'when the run creates or changes a rendered surface; otherwise say why there is none. ' +
        'Put EVERY command in its own fenced code block — the page renders each with a ' +
        'click-to-copy control. Do NOT include the branch fetch: Motir composes it from each ' +
        `pull request. At most ${TEST_INSTRUCTIONS_MAX_BODY_BYTES / 1024} KiB.`,
    ),
  repos: z
    .array(repoSectionSchema)
    .describe(
      'One entry per repository the run pushed to, at most ' +
        `${TEST_INSTRUCTIONS_MAX_REPOS}, each with its pushed head commit.`,
    ),
  previewPath: z
    .string()
    .optional()
    .describe(
      'The path to open on the preview deployment, starting with "/" — e.g. "/items/ACME-7". ' +
        `A path, never a URL: Motir joins it onto the preview the host reported. At most ${TEST_INSTRUCTIONS_MAX_SHORT_TEXT_CHARS} characters.`,
    ),
};

interface PublishArgs {
  key: string;
  bodyMd: string;
  repos: Array<{ repo: string; commitSha: string }>;
  previewPath?: string;
}

/** The adapter: resolve the item by key, then publish. */
export async function runPublishTestInstructions(
  args: PublishArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const identifier = normalizeIdentifier(args.key);
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    const item = await workItemsService.getWorkItemByIdentifier(project.id, identifier, ctx);

    const { record, created } = await testInstructionsService.publish(
      {
        workItemId: item.id,
        bodyMd: args.bodyMd ?? '',
        repos: (args.repos ?? []).map((entry) => ({
          repoRef: entry.repo,
          commitSha: entry.commitSha,
        })),
        previewPath: args.previewPath ?? null,
        attributeToRunningDispatch: true,
      },
      ctx,
    );

    const bodyBytes = Buffer.byteLength(record.bodyMd, 'utf8');
    const sections = args.repos
      .map((entry, i) => `${entry.repo}@${record.repos[i]?.commitSha.slice(0, 7) ?? '?'}`)
      .join(', ');
    return toolOk(
      created
        ? `Published How to test on ${item.identifier} for this run: ${bodyBytes} bytes of Markdown; ` +
            `${record.repos.length} repository section(s) — ${sections}.`
        : `How to test on ${item.identifier} was already published by this run with this ` +
            'content — nothing changed.',
      exempt(PUBLISH_TEST_INSTRUCTIONS_TOOL_NAME, {
        id: record.id,
        workItemKey: item.identifier,
        repos: record.repos.map((r) => ({ repoId: r.repoId, commitSha: r.commitSha })),
        bodyBytes,
        created,
        isCurrent: record.isCurrent,
        dispatchRunId: record.dispatchRunId,
        createdAt: record.createdAt,
      }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerPublishTestInstructions(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    PUBLISH_TEST_INSTRUCTIONS_TOOL_NAME,
    {
      title: 'Publish How to test',
      description:
        'Put a RUN\'s HOW TO TEST onto its RUN TARGET (by identifier, e.g. "ACME-7") — the work ' +
        'item the run was launched against: the story for a story or scoped run, the card itself ' +
        'for a single-card run. Call it ONCE per run, before the run finishes (before the card ' +
        'goes to implemented, or before the run\'s pull requests are marked ready). "bodyMd" is ' +
        'RICH TEXT (Markdown) with sections — the precondition, local setup and, when the run ' +
        'creates or changes a rendered surface, the click-path — and EVERY command in its own ' +
        'fenced code block, which the page renders click-to-copy. "repos" names each repository ' +
        "the run pushed to with its head commit. It renders on the run target's page inside the " +
        'Development block with its pull requests — the evidence of the one approve-to-merge ' +
        'decision — beside the preview each repository reported and the checks CI ran; nothing ' +
        'else writes it. Do not include the branch fetch — Motir adds it from the pull request. ' +
        "The same call repeated by the same run changes nothing; a later run's publish " +
        'supersedes and the earlier stays as history. Every limit is a refusal naming the field. ' +
        'It does not replace the How to test section of a pull-request body. Honors the same ' +
        'access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runPublishTestInstructions(args as PublishArgs, resolveContext(extra)),
  );
}
