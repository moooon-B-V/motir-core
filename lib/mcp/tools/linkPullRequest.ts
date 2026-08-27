import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { resolveWorkItemByKey, workItemKeyField } from './workItemRef';

// `link_pull_request` (Story MOTIR-3525 · Subtask MOTIR-3526) — the door an
// executing agent has never had: DECLARE which work item a pull request belongs
// to, at the moment the answer is certain.
//
// ── What this replaces, and what it does NOT ───────────────────────────────
// Until this tool the only way an agent could say which card its pull request
// delivered was to put `MOTIR-<n>` in the branch or the title and hope
// `resolveChangeRequestWorkItem` parsed it back out. That guess is wrong in both
// directions and both have been measured on live cards: a title that drops the
// key is invisible to the completion gate, so a card is held open by work that
// shipped; a title that merely MENTIONS a key closes that card whether or not it
// delivered it.
//
// The parse is NOT retired and this tool does not touch it. It stays as the
// FALLBACK for a pull request opened outside a run — by a person, by Dependabot,
// by a script — where a guess is the only thing available and is a reasonable
// one. What changes is which mechanism is PRIMARY.
//
// ── The model was already right; only the door was missing ────────────────
// `github_pull_request.work_item_id` is the link, `linked_manually` is its
// stickiness flag, and `syncChangeRequestStatus` already PREFERS a sticky link
// over the parse (`lib/services/changeRequestStatusSync.ts` — the
// `existingPr?.linkedManually && existingPr.workItemId` short-circuit). Motir
// simply never gave the one actor who knows the answer a way to write it down: a
// human can, from the detail page's "+ Link pull request" picker; the agent that
// just ran `gh pr create` could not.
//
// ── Why not just expose the picker's service ──────────────────────────────
// The picker resolves an INGESTED pull request by Motir's internal cuid. An
// agent has neither — it is the FIRST party to know the pull request exists,
// ahead of GitHub's own webhook, and it addresses it the way the world does: a
// repository and a number. So this tool takes `(owner/name, number)` and writes
// the row when there is none yet. `githubPullRequestService
// .linkPullRequestByCoordinates` carries the whole argument for why the two arms
// are asymmetric; nothing is re-implemented here.
//
// ── ⚠️ THE PERMISSION, AND WHY IT IS A CRITERION AND NOT A LINE TO REMEMBER ─
// This tool asserts `work_item:edit` — linking a pull request to a card is
// editing that card — and `CLI_TOKEN_GRANT` ALREADY CARRIES IT, so it is NOT
// widened by this card. That is worth stating rather than assuming, because the
// opposite failure ships GREEN: the tool registers, every suite passes against a
// workspace PAT, and the one caller the feature exists for gets a refusal it
// reads as an outage. That has happened twice on this constant — MOTIR-3058 and
// MOTIR-3051.

export const LINK_PULL_REQUEST_TOOL_NAME = 'link_pull_request';

/**
 * A pull-request URL as `gh pr create` prints it —
 * `https://github.com/<owner>/<name>/pull/<number>`.
 *
 * Host-agnostic on purpose (a GitHub Enterprise deployment serves the same path
 * shape under its own hostname), and the segment count is pinned so a URL that
 * merely CONTAINS `/pull/` somewhere cannot be misread as a coordinate.
 */
const PULL_REQUEST_URL_RE = /^https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/;

/** `owner/name`, as a repository is connected. */
const REPOSITORY_RE = /^([^/\s]+)\/([^/\s]+)$/;

const inputSchema = {
  key: workItemKeyField,
  repository: z
    .string()
    .trim()
    .optional()
    .describe(
      'The repository as "owner/name", exactly as it is connected in Motir (case-insensitive). ' +
        'Give this WITH `number`, or give `url` instead — not neither.',
    ),
  number: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('The pull-request number, e.g. 2291. Give this with `repository`.'),
  url: z
    .string()
    .trim()
    .optional()
    .describe(
      'The full pull-request URL, e.g. "https://github.com/acme/web/pull/2291" — the line ' +
        '`gh pr create` prints, so it can be passed through verbatim. An alternative to ' +
        '`repository` + `number`, never a supplement: if both are given they must agree.',
    ),
  headRef: z
    .string()
    .trim()
    .min(1)
    .describe(
      'The branch the pull request is FROM, e.g. "subtask/ACME-7-widget". Used only when no ' +
        'webhook delivery has arrived yet and this call is what creates the row; once a ' +
        'delivery has landed, the delivery is authoritative and this is ignored.',
    ),
  baseRef: z
    .string()
    .trim()
    .min(1)
    .describe(
      'The branch the pull request TARGETS, e.g. "main". Same rule as `headRef`: it seeds the ' +
        'row when there is none, and a later delivery overwrites it.',
    ),
  title: z
    .string()
    .trim()
    .optional()
    .describe(
      'The pull request’s title, for the row this call may have to create. Optional — the ' +
        'first webhook delivery supplies the real one either way.',
    ),
};

/** The coordinate a call resolved to, or the argument fault that stopped it. */
type Coordinate =
  | { ok: true; owner: string; name: string; number: number }
  | { ok: false; message: string };

/**
 * Resolve `(owner, name, number)` from either address form.
 *
 * Both forms are accepted and CROSS-CHECKED rather than ranked, because a
 * disagreement between them is a caller mistake with a silent wrong answer: pick
 * one arbitrarily and the link lands on a real pull request that is not the one
 * the caller meant, under a success message.
 */
export function resolveCoordinate(args: {
  repository?: string;
  number?: number;
  url?: string;
}): Coordinate {
  let fromUrl: { owner: string; name: string; number: number } | null = null;
  if (args.url !== undefined) {
    const m = PULL_REQUEST_URL_RE.exec(args.url);
    if (!m) {
      return {
        ok: false,
        message:
          '`url` is not a pull-request URL. Expected ' +
          '"https://<host>/<owner>/<name>/pull/<number>", the form `gh pr create` prints.',
      };
    }
    fromUrl = { owner: m[1]!, name: m[2]!, number: Number(m[3]!) };
  }

  let fromPair: { owner: string; name: string; number: number } | null = null;
  if (args.repository !== undefined || args.number !== undefined) {
    if (args.repository === undefined || args.number === undefined) {
      return {
        ok: false,
        message: '`repository` and `number` go together — give both, or give `url` instead.',
      };
    }
    const m = REPOSITORY_RE.exec(args.repository);
    if (!m) {
      return { ok: false, message: '`repository` must be "owner/name", e.g. "acme/web".' };
    }
    fromPair = { owner: m[1]!, name: m[2]!, number: args.number };
  }

  const resolved = fromUrl ?? fromPair;
  if (!resolved) {
    return {
      ok: false,
      message:
        'Address the pull request: either `url`, or `repository` + `number`. ' +
        'After `gh pr create`, `url` is the line it printed.',
    };
  }
  if (
    fromUrl &&
    fromPair &&
    (fromUrl.number !== fromPair.number ||
      fromUrl.owner.toLowerCase() !== fromPair.owner.toLowerCase() ||
      fromUrl.name.toLowerCase() !== fromPair.name.toLowerCase())
  ) {
    return {
      ok: false,
      message:
        `\`url\` names ${fromUrl.owner}/${fromUrl.name}#${fromUrl.number} but ` +
        `\`repository\` + \`number\` name ${fromPair.owner}/${fromPair.name}#${fromPair.number}. ` +
        'Send one address, not two that disagree.',
    };
  }
  return { ok: true, ...resolved };
}

/** The adapter: resolve the item + the coordinate, then declare the link. */
export async function runLinkPullRequest(
  args: {
    key: string;
    repository?: string;
    number?: number;
    url?: string;
    headRef: string;
    baseRef: string;
    title?: string;
  },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const coordinate = resolveCoordinate(args);
    // A TOOL error, not a throw: the agent can fix this in one hop, and an
    // opaque internal error would tell it nothing about which argument is wrong.
    if (!coordinate.ok) return toolError('INVALID_PULL_REQUEST_REF', coordinate.message);

    const item = await resolveWorkItemByKey(args.key, ctx);
    const result = await githubPullRequestService.linkPullRequestByCoordinates(
      {
        workItemId: item.id,
        projectId: item.projectId,
        owner: coordinate.owner,
        name: coordinate.name,
        number: coordinate.number,
        headRef: args.headRef,
        baseRef: args.baseRef,
        title: args.title ?? null,
      },
      ctx,
    );

    const where = `${result.link.repo}#${result.link.number}`;
    const note = result.movedFrom
      ? ` (MOVED from ${result.movedFrom} — that is the SINGULAR link, the one the completion` +
        ` gate reads; ${result.movedFrom} KEEPS its delivery row, which only the item page removes)`
      : result.created
        ? ' (no delivery had arrived yet — the row was created by this call)'
        : '';
    return toolOk(
      `Linked ${where} to ${item.identifier}${note}.`,
      exempt(LINK_PULL_REQUEST_TOOL_NAME, {
        key: item.identifier,
        created: result.created,
        movedFrom: result.movedFrom,
        pullRequest: { ...result.link },
      }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerLinkPullRequest(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    LINK_PULL_REQUEST_TOOL_NAME,
    {
      title: 'Link pull request',
      description:
        'Declare which work item a pull request belongs to — call it IMMEDIATELY after opening ' +
        'the pull request, once per pull request. You know the answer with certainty at that ' +
        'moment; nothing else does. The link is what the completion gate and the status sync ' +
        'read, so a merge moves the card whether or not any title ever named it. ' +
        '⚠️ IT WRITES TWO LINKS AND THEY BEHAVE DIFFERENTLY. The link a work item CARRIES is ' +
        'SINGULAR, so calling this again naming a DIFFERENT work item takes it off the first one ' +
        '— the result says which item it was moved from. The call ALSO records the (work item, ' +
        'pull request) pair in a delivery table, and THAT one pull request may fill for several ' +
        'work items; it is what the item page’s Development panel lists. ' +
        '⚠️ The completion gate and the status sync still read the SINGULAR link, so ONE pull ' +
        'request delivering a parent and its children is linked to the PARENT, once — link the ' +
        'children instead and every call walks the link off the last, the merge closes only ' +
        'whichever card it happened to end on, and the siblings are stranded. The merge cascades ' +
        'DOWN from the parent on its own. ' +
        'Address the pull request as `repository` ("owner/name") + `number`, or as the `url` ' +
        '`gh pr create` printed. It works BEFORE GitHub’s webhook has delivered anything — ' +
        'that is the case it exists for — writing the row from the `headRef` / `baseRef` / ' +
        '`title` you supply; a later delivery refreshes those and leaves the link alone. ' +
        'Putting the key in the branch is still worth doing for a human reading a branch list, ' +
        'but it is a label now, not the mechanism. Honors the same access checks as the UI: an ' +
        'unknown or cross-workspace repository, and an unknown item key, are both refused.',
      inputSchema,
    },
    async (args, extra) => runLinkPullRequest(args, resolveContext(extra)),
  );
}
