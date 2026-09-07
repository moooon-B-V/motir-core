import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { acceptanceEvidenceService } from '@/lib/services/acceptanceEvidenceService';
import { acceptanceVideoEligibilityService } from '@/lib/services/acceptanceVideoEligibilityService';
import { findOwningStoryParent } from '@/lib/acceptanceEvidence/publishAuth';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import {
  normalizeIdentifier,
  projectKeyOf,
  resolveWorkItemByKey,
  workItemKeyField,
} from './workItemRef';

// `create_acceptance_upload` + `publish_acceptance_result` (Bug MOTIR-4704) —
// the MCP door onto a story's ACCEPTANCE RECEIPT: the recording of one green
// run of the story working, which a human then watches and approves.
//
// Thin adapters over `acceptanceEvidenceService.createUploadTokens` and
// `.recordFromPathnames` — the same two service calls the CI-authed HTTP routes
// (MOTIR-1631/1681) reach, which stay exactly where they are. The story hop,
// the eligibility gate, the acceptance prefix check, the authoritative `head`
// of each uploaded blob and the per-file cap all run there, once; nothing is
// re-implemented here.
//
// ── ⚠️ WHY A TOOL AND NOT CI ───────────────────────────────────────────────
// MOTIR-4096 retired `scripts/upload-acceptance-video.mjs` and the Action beside
// it, and the reason generalises the one `publishDesignResult.ts` records: a
// publisher that has to BE PRESENT in the repository the work lands in is a
// requirement no repository Motir does not own can meet. A CI publisher can
// guarantee motir-core's receipts and nobody else's.
//
// What replaces it is the planner/runner PAIR: the planner writes the
// acceptance E2E subtask onto every user-facing story, and the runner is
// prompted to publish what it recorded (`lib/dispatch/promptTemplate.ts`,
// `WHAT_TO_DO.test`). That pair only closes if there is a door to publish
// THROUGH, and the MCP surface is the one door that travels to every repository
// with a credential the runner already holds. Between 4096 and this card there
// was none, and three documents said there was.
//
// ── ⚠️ WHY TWO CALLS AND NOT ONE `contentBase64` ───────────────────────────
// `publish_design_result` takes its assets inline. A receipt cannot, for two
// independent reasons:
//
//   · The MCP route is a serverless function. `createUploadTokens`'s own comment
//     says the direct-to-store path exists "bypassing the ~4.5MB serverless body
//     cap"; base64 is 1.37x the file, so an inline receipt would fail at roughly
//     a 3 MB video — below the ordinary case, and far below the 100 MB per-file
//     limit a cloud `scaled` org is entitled to.
//   · The bytes would have to be EMITTED by the agent. A 5 MB recording is
//     6.7 M characters of tool argument. For a design `.png` that is awkward;
//     for video it is a wall, on every runner.
//
// So this is the mint-then-PUT shape `docs/decisions/design-result.md`
// deliberately KEPT its routes for, expressed as two tools: mint, PUT the bytes
// straight to the store with the returned presigned URL, register the pathname.
// The runner needs no Motir route, no PAT and nothing repo-side.
//
// ── ⚠️ THE PERMISSION ──────────────────────────────────────────────────────
// `ACCEPTANCE_PUBLISH_PERMISSION` IS `work_item:edit` (`lib/tokens/grant.ts`) —
// the same key `publish_design_result` asserts and the same key `CLI_TOKEN_GRANT`
// already carries, so a dispatched agent can call this the day it ships. No new
// credential, and `CLI_TOKEN_GRANT` is NOT widened by this card;
// `tests/mcp/publishAcceptanceResultTool.test.ts` asserts that against the
// constant rather than leaving it to be reasoned about. The gate itself is
// `resolveStory` inside the service, which asserts `work_item:edit` on the
// story's own project.

export const CREATE_ACCEPTANCE_UPLOAD_TOOL_NAME = 'create_acceptance_upload';
export const PUBLISH_ACCEPTANCE_RESULT_TOOL_NAME = 'publish_acceptance_result';

/** One chapter marker, mirroring `AcceptanceEvidenceChapterDTO`. */
const chapterSchema = z.object({
  label: z
    .string()
    .min(1)
    .describe('The step this marker jumps to, in the reviewer’s words (e.g. "Open the item").'),
  tSeconds: z
    .number()
    .min(0)
    .describe('Offset into the recording, in seconds, where that step begins.'),
});

const createUploadInputSchema = {
  key: workItemKeyField,
  hasTrace: z
    .boolean()
    .optional()
    .describe(
      'True to ALSO mint a grant for the Playwright trace (a dev diagnostic beside the video). ' +
        'Defaults to false — mint it only if you actually captured one.',
    ),
};

const publishInputSchema = {
  key: workItemKeyField,
  videoPathname: z
    .string()
    .min(1)
    .describe('The `pathname` of the video grant you uploaded to, exactly as it was returned.'),
  tracePathname: z
    .string()
    .optional()
    .describe('The trace grant’s `pathname`, when one was minted and uploaded to.'),
  chapters: z
    .array(chapterSchema)
    .optional()
    .describe(
      'The chapter markers, from the run’s `chapters.json` — what the reviewer scrubs by. A ' +
        'receipt with none is watchable but not navigable, so send them when the spec wrote them.',
    ),
  commitSha: z
    .string()
    .optional()
    .describe(
      'The commit the run recorded at. ALSO THE IDEMPOTENCY KEY: re-publishing the same ' +
        'commit + producedByKey returns the existing receipt instead of superseding it.',
    ),
  producedByKey: z
    .string()
    .optional()
    .describe('The E2E work item that produced the recording, e.g. "ACME-7".'),
};

/** The resolved STORY a receipt hangs on — its id for the service, its key for
 *  the summary line, so the agent sees which card the hop landed on. */
interface AcceptanceTarget {
  id: string;
  identifier: string;
}

interface CreateUploadArgs {
  key: string;
  hasTrace?: boolean;
}

interface PublishArgs {
  key: string;
  videoPathname: string;
  tracePathname?: string;
  chapters?: Array<{ label: string; tSeconds: number }>;
  commitSha?: string;
  producedByKey?: string;
}

/**
 * Resolve the key to the STORY its receipt hangs on, then apply the publish
 * eligibility gate — the two steps between an identifier and the service.
 *
 * Returns the story, or a ready tool error.
 *
 * ⚠️ BOTH HALVES ARE SHARED WITH THE HTTP DOOR RATHER THAN RESTATED. The hop is
 * `publishAuth.findOwningStoryParent` (MOTIR-4144: two copies let the publisher
 * and the status read disagree about which card's receipt is under discussion,
 * and the disagreement is silent). The gate is
 * `acceptanceVideoEligibilityService.resolve`, which its own header calls "the
 * ONE place the ADR decision-1 rule is computed" so the panel, the endpoint and
 * the settings card cannot diverge — this is a fourth caller of that one place,
 * not a second rule. Skipping it here would make MCP the door on which an
 * ineligible org can publish, which is the only way a gate that exists stops
 * meaning anything.
 */
async function resolveEligibleStory(
  key: string,
  ctx: ServiceContext,
): Promise<{ ok: true; story: AcceptanceTarget } | { ok: false; refusal: CallToolResult }> {
  const item = await resolveWorkItemByKey(key, ctx);
  const parent = await findOwningStoryParent(item, ctx);
  // The parent is same-project by construction (`CrossProjectParentError`), so
  // its identifier is the caller's own project prefix and the parent's number.
  const story: AcceptanceTarget = parent
    ? { id: parent.id, identifier: `${projectKeyOf(normalizeIdentifier(key))}-${parent.key}` }
    : { id: item.id, identifier: item.identifier };

  const eligibility = await acceptanceVideoEligibilityService.resolve({
    actorUserId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  if (!eligibility.eligible) {
    return {
      ok: false,
      refusal: toolError(
        'ACCEPTANCE_VIDEO_INELIGIBLE',
        `This workspace may not publish an acceptance video (${eligibility.reason}). The recording is still in the run’s Playwright report; nothing is lost by stopping here.`,
      ),
    };
  }
  return { ok: true, story };
}

/** The adapter: resolve + gate, then mint the upload grants. */
export async function runCreateAcceptanceUpload(
  args: CreateUploadArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const resolved = await resolveEligibleStory(args.key, ctx);
    if (!resolved.ok) return resolved.refusal;
    const story = resolved.story;

    const tokens = await acceptanceEvidenceService.createUploadTokens(
      { workItemId: story.id, hasTrace: args.hasTrace === true },
      ctx,
    );

    const targets = tokens.trace ? 'the video and the trace' : 'the video';
    return toolOk(
      `Minted an upload grant for ${targets} on ${story.identifier}. PUT the bytes to each \`uploadUrl\` with its \`contentType\`, then call \`${PUBLISH_ACCEPTANCE_RESULT_TOOL_NAME}\` with the \`pathname\`(s).`,
      exempt(CREATE_ACCEPTANCE_UPLOAD_TOOL_NAME, {
        workItemKey: story.identifier,
        video: {
          pathname: tokens.video.pathname,
          uploadUrl: tokens.video.token,
          contentType: tokens.video.contentType,
          maxBytes: tokens.video.maxBytes,
        },
        trace: tokens.trace
          ? {
              pathname: tokens.trace.pathname,
              uploadUrl: tokens.trace.token,
              contentType: tokens.trace.contentType,
              maxBytes: tokens.trace.maxBytes,
            }
          : null,
      }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

/** The adapter: resolve + gate, then register the uploaded pathnames. */
export async function runPublishAcceptanceResult(
  args: PublishArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const resolved = await resolveEligibleStory(args.key, ctx);
    if (!resolved.ok) return resolved.refusal;
    const story = resolved.story;

    const evidence = await acceptanceEvidenceService.recordFromPathnames(
      {
        workItemId: story.id,
        videoPathname: args.videoPathname,
        tracePathname: args.tracePathname ?? null,
        chapters: args.chapters ?? [],
        commitSha: args.commitSha ?? null,
        producedByKey: args.producedByKey ?? null,
      },
      ctx,
    );

    return toolOk(
      `Published the acceptance receipt for ${story.identifier} (${evidence.chapters.length} chapter(s), status ${evidence.status}). A person watches it and approves — the story is not accepted until they do.`,
      exempt(PUBLISH_ACCEPTANCE_RESULT_TOOL_NAME, {
        id: evidence.id,
        workItemKey: story.identifier,
        status: evidence.status,
        chapterCount: evidence.chapters.length,
        sizeBytes: evidence.sizeBytes,
        createdAt: evidence.createdAt,
      }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerPublishAcceptanceResult(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    CREATE_ACCEPTANCE_UPLOAD_TOOL_NAME,
    {
      title: 'Create acceptance upload',
      description:
        'STEP 1 OF 2 of publishing a story’s ACCEPTANCE RECEIPT — the recording of one green run ' +
        'of the story working, which a person then watches and approves. Mints a short-lived ' +
        '(~5 min) presigned PUT URL bound to one exact object and one content type: PUT the ' +
        'recording’s bytes straight to `video.uploadUrl` with `Content-Type: video/webm`, then ' +
        'call `publish_acceptance_result` with the `pathname` it returned. The bytes never pass ' +
        'through this tool — a recording is far larger than a tool argument can carry, which is ' +
        'why this is two calls and not one. Pass the E2E work item’s key or the story’s: a ' +
        'receipt belongs to the STORY, so a leaf resolves UP to its parent story. Honors the ' +
        'same access checks, eligibility gate and per-file size limit as the UI.',
      inputSchema: createUploadInputSchema,
    },
    async (args, extra) =>
      runCreateAcceptanceUpload(args as CreateUploadArgs, resolveContext(extra)),
  );

  server.registerTool(
    PUBLISH_ACCEPTANCE_RESULT_TOOL_NAME,
    {
      title: 'Publish acceptance result',
      description:
        'STEP 2 OF 2 — register the recording you uploaded as the story’s ACCEPTANCE RECEIPT, ' +
        'with its chapters and the commit it ran at. This is the deliverable the acceptance ' +
        'gate rests on and the thing a reviewer actually watches: the merged pull request is ' +
        'not it, and a story whose panel is empty reads as a story nobody saw work. Call it ' +
        'yourself in the same run that recorded the video — NOTHING ELSE WILL, and a missing ' +
        'publish looks exactly like a successful run (spec green, checks green, PR merged, ' +
        'story with no receipt). The receipt lands `pending`; a person approves it, and an ' +
        'approved one is FROZEN — a later publish is refused, not superseded. Re-sending the ' +
        'same `commitSha` + `producedByKey` returns the existing receipt rather than making a ' +
        'second one. Targets the STORY, so a leaf key resolves UP to its parent story.',
      inputSchema: publishInputSchema,
    },
    async (args, extra) => runPublishAcceptanceResult(args as PublishArgs, resolveContext(extra)),
  );
}
