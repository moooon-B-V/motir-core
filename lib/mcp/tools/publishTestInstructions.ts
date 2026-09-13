import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import {
  TEST_INSTRUCTIONS_MAX_COMMAND_CHARS,
  TEST_INSTRUCTIONS_MAX_PRECONDITION_BYTES,
  TEST_INSTRUCTIONS_MAX_REPOS,
  TEST_INSTRUCTIONS_MAX_SETUP_COMMANDS,
  TEST_INSTRUCTIONS_MAX_SHORT_TEXT_CHARS,
  TEST_INSTRUCTIONS_MAX_STEP_CHARS,
  TEST_INSTRUCTIONS_MAX_STEPS,
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
// one record, a section per repository). A thin adapter over
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

const setupCommandSchema = z.object({
  label: z
    .string()
    .describe(
      `What the step is, e.g. "Install". At most ${TEST_INSTRUCTIONS_MAX_STEP_CHARS} characters.`,
    ),
  command: z
    .string()
    .describe(
      `The shell command, e.g. "pnpm install --frozen-lockfile". At most ${TEST_INSTRUCTIONS_MAX_COMMAND_CHARS} characters.`,
    ),
});

const repoSectionSchema = z.object({
  repo: z
    .string()
    .min(1)
    .describe(
      'The repository — its name ("web") or "owner/name" ("acme/web"). It must be one of the ' +
        'work item’s project repositories, and appear once.',
    ),
  commitSha: z.string().min(1).describe('The head commit the run pushed to this repository.'),
  setupCommands: z
    .array(setupCommandSchema)
    .optional()
    .describe(
      'What a reviewer runs AFTER checking out this repository’s branch — install, migrate, ' +
        `seed, run — in order, at most ${TEST_INSTRUCTIONS_MAX_SETUP_COMMANDS}. Do NOT include ` +
        'the branch fetch: Motir composes it from the pull request itself.',
    ),
});

const inputSchema = {
  key: workItemKeyField.describe(
    'The RUN TARGET — the work item the run was launched against (e.g. "ACME-7"): the story ' +
      'for a story or scoped run, the card itself for a single-card run. Case-insensitive.',
  ),
  repos: z
    .array(repoSectionSchema)
    .describe(
      'One entry per repository the run pushed to, at most ' +
        `${TEST_INSTRUCTIONS_MAX_REPOS}. The click-path below is ONE for the whole run.`,
    ),
  clickPathSteps: z
    .array(z.string())
    .optional()
    .describe(
      'The click-path a reviewer follows in the running app, in order — what to open, click and ' +
        `expect to SEE. At most ${TEST_INSTRUCTIONS_MAX_STEPS} steps of ` +
        `${TEST_INSTRUCTIONS_MAX_STEP_CHARS} characters. Give these OR set ` +
        '"clickPathNotApplicable", never both.',
    ),
  clickPathNotApplicable: z
    .boolean()
    .optional()
    .describe(
      'Set true when the run touched no rendered surface, and say why in ' +
        '"clickPathNotApplicableReason".',
    ),
  clickPathNotApplicableReason: z
    .string()
    .optional()
    .describe(
      'Why there is no click-path, e.g. "no rendered surface changed: a service and its tests". ' +
        `At most ${TEST_INSTRUCTIONS_MAX_SHORT_TEXT_CHARS} characters.`,
    ),
  previewPath: z
    .string()
    .optional()
    .describe(
      'The path to open on the preview deployment, starting with "/" — e.g. "/items/ACME-7". ' +
        'A path, never a URL: Motir joins it onto the preview the host reported.',
    ),
  preconditionMd: z
    .string()
    .optional()
    .describe(
      'The sign-in, role or data the surface needs, as Markdown. At most ' +
        `${TEST_INSTRUCTIONS_MAX_PRECONDITION_BYTES / 1024} KiB.`,
    ),
};

interface PublishArgs {
  key: string;
  repos: Array<{
    repo: string;
    commitSha: string;
    setupCommands?: Array<{ label: string; command: string }>;
  }>;
  clickPathSteps?: string[];
  clickPathNotApplicable?: boolean;
  clickPathNotApplicableReason?: string;
  previewPath?: string;
  preconditionMd?: string;
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
        repos: (args.repos ?? []).map((entry) => ({
          repoRef: entry.repo,
          commitSha: entry.commitSha,
          setupCommands: entry.setupCommands ?? null,
        })),
        clickPathSteps: args.clickPathSteps ?? null,
        clickPathNotApplicable: args.clickPathNotApplicable ?? null,
        clickPathNotApplicableReason: args.clickPathNotApplicableReason ?? null,
        previewPath: args.previewPath ?? null,
        preconditionMd: args.preconditionMd ?? null,
        attributeToRunningDispatch: true,
      },
      ctx,
    );

    const walk = record.clickPathNotApplicable
      ? 'no click-path (not applicable)'
      : `${record.clickPathSteps.length} click-path step(s)`;
    const sections = args.repos
      .map((entry, i) => `${entry.repo}@${record.repos[i]?.commitSha.slice(0, 7) ?? '?'}`)
      .join(', ');
    return toolOk(
      created
        ? `Published How to test on ${item.identifier} for this run: ${walk}; ` +
            `${record.repos.length} repository section(s) — ${sections}.`
        : `How to test on ${item.identifier} was already published by this run with this ` +
            'content — nothing changed.',
      exempt(PUBLISH_TEST_INSTRUCTIONS_TOOL_NAME, {
        id: record.id,
        workItemKey: item.identifier,
        repos: record.repos.map((r) => ({ repoId: r.repoId, commitSha: r.commitSha })),
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
        "goes to implemented, or before the run's pull requests are marked ready), with one " +
        '"repos" entry per repository the run pushed to — its pushed head commit and the setup ' +
        'commands a reviewer runs after checking out its branch — plus the precondition and ONE ' +
        "click-path for the whole run. It renders on the run target's page and in its " +
        'pull-request approval, beside the preview each repository reported and the checks CI ' +
        'ran; nothing else writes it, and an item without one shows that nobody wrote how to ' +
        'test it. Give "clickPathSteps" when the run creates or changes a rendered surface; ' +
        'otherwise set "clickPathNotApplicable" with a reason. Do not include the branch fetch — ' +
        'Motir adds it from the pull request. The same call repeated by the same run changes ' +
        "nothing; a later run's publish supersedes and the earlier stays as history. Every " +
        'limit is a refusal naming the field, never a truncation. It does not replace the How ' +
        'to test section of a pull-request body. Honors the same access checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runPublishTestInstructions(args as PublishArgs, resolveContext(extra)),
  );
}
