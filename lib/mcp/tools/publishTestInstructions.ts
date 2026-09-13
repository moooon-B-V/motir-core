import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { testInstructionsService } from '@/lib/services/testInstructionsService';
import {
  TEST_INSTRUCTIONS_MAX_COMMAND_CHARS,
  TEST_INSTRUCTIONS_MAX_PRECONDITION_BYTES,
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

// `publish_test_instructions` (Story MOTIR-4906 · Subtask MOTIR-5331) — the door a
// dispatched agent writes HOW TO TEST through, onto the WORK ITEM rather than into
// a pull-request body Motir cannot read. A thin adapter over
// `testInstructionsService.publish` (MOTIR-5328): the caps, the click-path XOR,
// the repository-in-project check and the per-commit idempotency all run there.
//
// ⚠️ THE ACTOR IS THE SANDBOXED AGENT, so the key is `work_item:edit` — the one
// `publish_design_result` / `publish_acceptance_result` assert and one
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

const inputSchema = {
  key: workItemKeyField,
  repo: z
    .string()
    .min(1)
    .describe(
      'The repository these instructions are for — its name ("web") or "owner/name" ' +
        '("acme/web"). It must be one of the work item’s project repositories; call once per ' +
        'repository you opened a pull request in.',
    ),
  commitSha: z
    .string()
    .min(1)
    .describe('The head commit you just pushed — the instructions are recorded against it.'),
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
      'Set true when the change touched no rendered surface, and say why in ' +
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
      'The path to open on the repository’s preview deployment, starting with "/" — e.g. ' +
        '"/items/ACME-7". A path, never a URL: Motir joins it onto the preview the host reported.',
    ),
  setupCommands: z
    .array(setupCommandSchema)
    .optional()
    .describe(
      'What a reviewer runs AFTER checking out the branch — install, migrate, seed, run — in ' +
        `order, at most ${TEST_INSTRUCTIONS_MAX_SETUP_COMMANDS}. Do NOT include the branch fetch: ` +
        'Motir composes it from the pull request itself.',
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
  repo: string;
  commitSha: string;
  clickPathSteps?: string[];
  clickPathNotApplicable?: boolean;
  clickPathNotApplicableReason?: string;
  previewPath?: string;
  setupCommands?: Array<{ label: string; command: string }>;
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
        repoRef: args.repo,
        commitSha: args.commitSha,
        clickPathSteps: args.clickPathSteps ?? null,
        clickPathNotApplicable: args.clickPathNotApplicable ?? null,
        clickPathNotApplicableReason: args.clickPathNotApplicableReason ?? null,
        previewPath: args.previewPath ?? null,
        setupCommands: args.setupCommands ?? null,
        preconditionMd: args.preconditionMd ?? null,
        attributeToRunningDispatch: true,
      },
      ctx,
    );

    const walk = record.clickPathNotApplicable
      ? 'no click-path (not applicable)'
      : `${record.clickPathSteps.length} click-path step(s)`;
    return toolOk(
      created
        ? `Published How to test on ${item.identifier} for ${args.repo} at ${record.commitSha.slice(0, 7)}: ` +
            `${walk}, ${record.setupCommands.length} setup command(s).`
        : `How to test on ${item.identifier} for ${args.repo} at ${record.commitSha.slice(0, 7)} ` +
            'was already published with this content — nothing changed.',
      exempt(PUBLISH_TEST_INSTRUCTIONS_TOOL_NAME, {
        id: record.id,
        workItemKey: item.identifier,
        repoId: record.repoId,
        commitSha: record.commitSha,
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
        'Put HOW TO TEST onto a work item (by identifier, e.g. "ACME-7") for ONE repository — ' +
        'the setup commands a reviewer runs after checking out the branch, the precondition, and ' +
        'the click-path through the running app. Call it after pushing and linking the pull ' +
        'request, before moving the card to implemented, once per repository you opened a pull ' +
        'request in, with the commit you just pushed. It renders under that pull request on the ' +
        'work item, beside the preview the repository reported and the checks CI ran; nothing ' +
        'else writes it, and a card without one shows that nobody wrote how to test it. Give ' +
        '"clickPathSteps" when the change creates or changes a rendered surface; otherwise set ' +
        '"clickPathNotApplicable" with a reason. Do not include the branch fetch — Motir adds ' +
        'it from the pull request. The same call repeated for the same commit changes nothing. ' +
        'Every limit is a refusal naming the field, never a truncation. Honors the same access ' +
        'checks as the UI.',
      inputSchema,
    },
    async (args, extra) => runPublishTestInstructions(args as PublishArgs, resolveContext(extra)),
  );
}
