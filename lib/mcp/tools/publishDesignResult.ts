import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { designEvidenceService } from '@/lib/services/designEvidenceService';
import type { DesignAssetKindDTO } from '@/lib/dto/designEvidence';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { normalizeIdentifier, projectKeyOf, workItemKeyField } from './workItemRef';

// `publish_design_result` (Story MOTIR-3780 · Subtask MOTIR-3782) — put a design
// RESULT on a design card: the note's changed sections, the `*.mock.html` mock
// and the `.png` export, in ONE call.
//
// A thin adapter over `designEvidenceService.recordFromBytes` — the same service
// the HTTP register route reaches, with the upload half moved inside because the
// caller is already on the server. The leaf check, the child check, the workspace
// resolution, the media-type allowlist, the per-file cap, `capNoteMd`'s 64 KiB
// section-boundary truncation and the `note_file` companion all run there, once;
// nothing is re-implemented here.
//
// ── ⚠️ WHY A TOOL AND NOT A SCRIPT ─────────────────────────────────────────
// The publisher used to be `scripts/upload-design-assets.mjs`, a CI script that
// had to BE PRESENT in whatever repository the design landed in. That is a
// requirement no repository Motir does not own can meet, and it was met in
// exactly one: a SHA-pinned copy in motir-marketing, a hard fork seventeen days
// stale in the platform starter, and nothing at all in a customer's repository.
// A stale copy is GREEN — nothing imports it, nothing type-checks it, no check
// compares it to anything — so all three read as working.
//
// The script existed to INFER three things the agent already knows: which card
// (from the branch ref), which files (from a diff), and which sections changed
// (from a second diff). Each inference is now a DECLARATION.
// `docs/decisions/design-result.md` AMENDMENT 2 is the record.
//
// ── ⚠️ THE PERMISSION ──────────────────────────────────────────────────────
// `work_item:edit`, which `CLI_TOKEN_GRANT` ALREADY carries — the fact
// `attachFile.ts` names in its own comment, and the reason this needs no new
// credential and no new trust. `CLI_TOKEN_GRANT` is NOT widened by this card,
// and `tests/mcp/publishDesignResultTool.test.ts` asserts membership against the
// constant itself rather than leaving it to be reasoned about.
//
// ── ⚠️ `text/html` HAS EXACTLY ONE ENTRANCE, AND THIS IS IT ────────────────
// A design mock is HTML rendered to a signed-in user, so its whole safety rests
// on `ALLOWED_DESIGN_ASSET_TYPES` being reachable through the design path and
// nowhere else (`design-result.md` §5). This tool routes to
// `designEvidenceService`, never `attachmentsService` — `attach_file` still
// refuses `text/html` with a 415, and its refusal comment stays true.
//
// ── The base64 argument ────────────────────────────────────────────────────
// MCP carries JSON, not multipart, so the bytes arrive base64-encoded — the same
// transport constraint `attach_file` answers the same way. AMENDMENT 2 Q3 fixes
// the ceiling this implies with the measurement behind it: the largest design
// `.png` on `origin/main` is 4.96 MiB (6.61 MiB base64) against a 10 MiB
// per-file cap that admits 7.5 MiB of raw bytes — 1.51x headroom. An asset over
// that is REFUSED, and the surviving mint-then-PUT routes are the door it is
// pointed at, which is the second reason those routes were kept.
//
// ── ⚠️ …AND THAT CEILING MADE THE DOOR UNREACHABLE (bug MOTIR-4750) ────────
// AMENDMENT 2 Q3's headroom is real and it is not the binding constraint. TWO
// independent limits sit under an inline publish, and the second one has no
// headroom at all:
//
//   · THE ROUTE. The MCP endpoint is a serverless function, and
//     `createUploadTokens`'s own note puts its body cap around 4.5 MB. Base64 is
//     1.37x the file, so an inline publish fails at roughly a 3 MB asset.
//   · THE AGENT'S OUTPUT BUDGET. The bytes have to be EMITTED, as a tool
//     argument, by a model. Measured on MOTIR-4742: a 3,929,899-byte board is
//     5.24 MB of base64, and base64 tokenises at ≈0.4 characters per token — so
//     even a 44 KB thumbnail nobody could read costs ~150,000 tokens.
//
// A real multi-sheet design board is over both. `design/ai-chat/planning-workspace.png`
// is 3.9 MB and is not an outlier in the tree, so for that whole population the
// tool the corpus calls MANDATORY could not be called at all — and it failed in
// precisely the shape the door was built to prevent: files written, commit
// landed, checks green, panel empty. The mint-then-PUT routes AMENDMENT 2 kept
// are no answer for an agent: they authenticate a CI job over GitHub OIDC, which
// is a credential a dispatched run does not hold.
//
// So `create_design_upload` is that shape expressed as a tool — the same two
// calls `create_acceptance_upload` + `publish_acceptance_result` already are, for
// the same two reasons, one section away in `docs/mcp.md`. The inline path is
// UNCHANGED and stays the one-call door for a small asset; this ADDS a door
// rather than replacing one. `docs/decisions/design-result.md` AMENDMENT 3 is
// the record.

export const PUBLISH_DESIGN_RESULT_TOOL_NAME = 'publish_design_result';
export const CREATE_DESIGN_UPLOAD_TOOL_NAME = 'create_design_upload';

/** The kinds a caller may publish, mirroring `design_asset_kind`. */
const ASSET_KINDS = ['mock', 'image', 'note_file'] as const;

const assetSchema = z.object({
  kind: z
    .enum(ASSET_KINDS)
    .describe(
      'What this file IS: "mock" for the `*.mock.html`, "image" for the `.png` export, ' +
        '"note_file" for the complete `design-notes.md` text.',
    ),
  sourcePath: z
    .string()
    .min(1)
    .describe(
      'The path the file has IN THE REPOSITORY, e.g. "design/work-items/detail.png". The ' +
        'repository stays the source of truth; this records where the published copy came from.',
    ),
  contentType: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The file’s media type — "text/html", "image/png" or "text/markdown". Anything else is ' +
        'refused: this is the ONE path on which "text/html" is accepted at all. Required with ' +
        '`contentBase64`; omit it with `pathname`, where the STORE’s own answer is authoritative.',
    ),
  contentBase64: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The file’s bytes, base64-encoded — the INLINE path, for a small asset. Send this OR ' +
        '`pathname`, never both and never neither.',
    ),
  pathname: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The `pathname` of a `create_design_upload` grant you have already PUT this file to — the ' +
        'path for an asset too large to travel as a tool argument. Send this OR `contentBase64`.',
    ),
});

const createUploadFileSchema = z.object({
  kind: z
    .enum(ASSET_KINDS)
    .describe(
      'What this file IS: "mock" for the `*.mock.html`, "image" for the `.png` export, ' +
        '"note_file" for the complete `design-notes.md` text.',
    ),
  sourcePath: z
    .string()
    .min(1)
    .describe(
      'The path the file has IN THE REPOSITORY, e.g. "design/ai-chat/planning-workspace.png". ' +
        'Its basename is carried into the minted key, so a grant stays recognisable.',
    ),
  contentType: z
    .string()
    .min(1)
    .describe(
      'The media type you will PUT — "text/html", "image/png" or "text/markdown". The grant is ' +
        'BOUND to it: a PUT sending anything else is refused by the store.',
    ),
});

const createUploadInputSchema = {
  key: workItemKeyField,
  files: z
    .array(createUploadFileSchema)
    .min(1)
    .describe('The files you are about to upload — one grant is minted per entry, in this order.'),
  withinParentKey: z
    .string()
    .optional()
    .describe(
      'On a PARENT-RUN publish only: the container whose branch this belongs to. It asserts ' +
        'the target is one of that container’s children, and is not stored.',
    ),
};

const inputSchema = {
  key: workItemKeyField,
  assets: z
    .array(assetSchema)
    .min(1)
    .describe(
      'The files to publish — normally three: the mock, the `.png`, and the note as a ' +
        '"note_file". At least one is required. Each entry carries EITHER `contentBase64` (the ' +
        'bytes inline, for a small asset) OR the `pathname` of a `create_design_upload` grant ' +
        'you have already PUT to. One publish uses one of the two forms for ALL its assets.',
    ),
  noteMd: z
    .string()
    .optional()
    .describe(
      'The SECTIONS of the design note this work CHANGED, as Markdown — not the whole file. ' +
        'You wrote them, so you know which they are; a whole area note runs to hundreds of ' +
        'kilobytes and is not what a reviewer wants to read. Over 64 KiB it is truncated at a ' +
        '"##" boundary for display, and the complete text still ships as the "note_file" asset.',
    ),
  commitSha: z
    .string()
    .optional()
    .describe('The commit the assets were published from. Also the idempotency key.'),
  producedByKey: z
    .string()
    .optional()
    .describe('The work item whose pull request produced this result, e.g. "ACME-7".'),
  withinParentKey: z
    .string()
    .optional()
    .describe(
      'On a PARENT-RUN publish only: the container whose branch this belongs to. It asserts ' +
        'the target is one of that container’s children, and is not stored.',
    ),
};

interface PublishArgs {
  key: string;
  assets: Array<{
    kind: (typeof ASSET_KINDS)[number];
    sourcePath: string;
    contentType?: string;
    contentBase64?: string;
    pathname?: string;
  }>;
  noteMd?: string;
  commitSha?: string;
  producedByKey?: string;
  withinParentKey?: string;
}

interface CreateUploadArgs {
  key: string;
  files: Array<{
    kind: (typeof ASSET_KINDS)[number];
    sourcePath: string;
    contentType: string;
  }>;
  withinParentKey?: string;
}

/** Compact human-readable summary of a published design result. */
function summarize(identifier: string, assetCount: number, truncated: boolean): string {
  const note = truncated
    ? ' The inline note was truncated for display; the full text is the `note_file`.'
    : '';
  return `Published a design result to ${identifier} with ${assetCount} asset(s).${note}`;
}

/**
 * Decode one asset's base64 payload, refusing anything that is not base64.
 *
 * ⚠️ `Buffer.from(s, 'base64')` NEVER throws — it discards characters outside
 * the alphabet and returns a shorter buffer. The same trap `attach_file` guards,
 * and worse here: a silently-salvaged mock would publish as a real design result
 * with a real evidence id, and only fail when a reviewer opens the panel.
 */
function decodeBase64(value: string): Buffer | null {
  const normalized = value.replace(/\s+/g, '');
  const bytes = Buffer.from(normalized, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== normalized) return null;
  return bytes;
}

/** Resolve a `<KEY>-<n>` identifier to the work item it names. */
async function resolveTargetItem(
  key: string,
  ctx: ServiceContext,
): Promise<{ id: string; identifier: string }> {
  const identifier = normalizeIdentifier(key);
  const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
  return workItemsService.getWorkItemByIdentifier(project.id, identifier, ctx);
}

/**
 * The adapter: mint one upload grant per file, for the assets that cannot travel
 * as a tool argument (bug MOTIR-4750).
 *
 * A thin pass over `designEvidenceService.createUploadTokens` — the same call the
 * CI-authed HTTP mint route makes. The leaf / child resolution, the design
 * allowlist, the per-file cap and the collision-safe key composition all run
 * there, once; nothing is re-implemented here.
 */
export async function runCreateDesignUpload(
  args: CreateUploadArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const item = await resolveTargetItem(args.key, ctx);
    const tokens = await designEvidenceService.createUploadTokens(
      {
        workItemId: item.id,
        files: args.files.map((file) => ({
          kind: file.kind as DesignAssetKindDTO,
          sourcePath: file.sourcePath,
          contentType: file.contentType,
        })),
        withinParentKey: args.withinParentKey ?? null,
      },
      ctx,
    );

    return toolOk(
      `Minted ${tokens.targets.length} upload grant(s) on ${item.identifier}. PUT each file’s ` +
        'bytes to its `uploadUrl` with its `contentType` — the grant is bound to both and expires ' +
        `in minutes — then call \`${PUBLISH_DESIGN_RESULT_TOOL_NAME}\` with the \`pathname\`(s).`,
      exempt(CREATE_DESIGN_UPLOAD_TOOL_NAME, {
        workItemKey: item.identifier,
        targets: tokens.targets.map((target) => ({
          kind: target.kind,
          sourcePath: target.sourcePath,
          pathname: target.pathname,
          uploadUrl: target.token,
          contentType: target.contentType,
          maxBytes: target.maxBytes,
        })),
      }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

/** The adapter: resolve project + item by key, decode, then publish. */
export async function runPublishDesignResult(
  args: PublishArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    // ⚠️ ONE publish uses ONE form for all its assets, and a MIX is refused
    // rather than reconciled. The two forms reach two different service methods
    // — bytes are uploaded here, a pathname was uploaded by the caller — and
    // splitting one publish across both would make this the only place in the
    // system that decides how a design result is assembled, which is exactly the
    // policy this adapter is written not to own. The refusal names the fix, and
    // the fix is cheap: mint a grant for every asset.
    const inline = args.assets.filter((asset) => asset.contentBase64 !== undefined);
    const minted = args.assets.filter((asset) => asset.pathname !== undefined);
    const both = args.assets.find(
      (asset) => asset.contentBase64 !== undefined && asset.pathname !== undefined,
    );
    const neither = args.assets.find(
      (asset) => asset.contentBase64 === undefined && asset.pathname === undefined,
    );

    if (both) {
      return toolError(
        'AMBIGUOUS_ASSET_SOURCE',
        `"${both.sourcePath}" carries BOTH \`contentBase64\` and \`pathname\`. Send exactly one: the bytes inline, or the \`pathname\` of the grant you PUT them to.`,
      );
    }
    if (neither) {
      return toolError(
        'MISSING_ASSET_SOURCE',
        `"${neither.sourcePath}" carries neither \`contentBase64\` nor \`pathname\`. Send the bytes inline for a small asset, or mint a grant with \`${CREATE_DESIGN_UPLOAD_TOOL_NAME}\`, PUT the file to it, and send the \`pathname\` it returned.`,
      );
    }
    if (inline.length > 0 && minted.length > 0) {
      return toolError(
        'MIXED_ASSET_SOURCES',
        `This publish mixes ${inline.length} inline asset(s) with ${minted.length} uploaded one(s). One publish uses one form for all of them — mint a grant for every asset with \`${CREATE_DESIGN_UPLOAD_TOOL_NAME}\`, PUT each file, and send only \`pathname\`s.`,
      );
    }

    const item = await resolveTargetItem(args.key, ctx);
    const common = {
      workItemId: item.id,
      noteMd: args.noteMd ?? null,
      commitSha: args.commitSha ?? null,
      producedByKey: args.producedByKey ?? null,
      withinParentKey: args.withinParentKey ?? null,
    };

    let evidence;
    if (minted.length > 0) {
      // The bytes are already in the store. `recordFromPathnames` refuses a
      // pathname outside this item's design prefix and HEADs each object for its
      // AUTHORITATIVE size and media type, so nothing the caller merely declares
      // is trusted — which is why this path needs no `contentType` at all.
      evidence = await designEvidenceService.recordFromPathnames(
        {
          ...common,
          assets: minted.map((asset) => ({
            kind: asset.kind as DesignAssetKindDTO,
            sourcePath: asset.sourcePath,
            pathname: asset.pathname!,
          })),
        },
        ctx,
      );
    } else {
      const decoded: Array<{
        kind: DesignAssetKindDTO;
        sourcePath: string;
        contentType: string;
        bytes: Buffer;
      }> = [];
      for (const asset of inline) {
        if (asset.contentType === undefined) {
          return toolError(
            'MISSING_CONTENT_TYPE',
            `"${asset.sourcePath}" sends \`contentBase64\` with no \`contentType\`. The inline path cannot ask a store what it holds, so the media type has to be declared.`,
          );
        }
        const bytes = decodeBase64(asset.contentBase64!);
        if (bytes === null) {
          // A TOOL error, not a throw: the agent can fix this in one hop, and it
          // names WHICH asset so a three-asset publish does not have to be
          // bisected.
          return toolError(
            'INVALID_BASE64',
            `\`contentBase64\` for "${asset.sourcePath}" is not valid base64. Encode the file’s bytes and send the result.`,
          );
        }
        decoded.push({
          kind: asset.kind as DesignAssetKindDTO,
          sourcePath: asset.sourcePath,
          contentType: asset.contentType,
          bytes,
        });
      }
      evidence = await designEvidenceService.recordFromBytes({ ...common, assets: decoded }, ctx);
    }

    return toolOk(
      summarize(item.identifier, evidence.assets.length, evidence.noteTruncated),
      exempt(PUBLISH_DESIGN_RESULT_TOOL_NAME, {
        id: evidence.id,
        workItemKey: item.identifier,
        assetCount: evidence.assets.length,
        noteTruncated: evidence.noteTruncated,
        createdAt: evidence.createdAt,
      }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerPublishDesignResult(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    PUBLISH_DESIGN_RESULT_TOOL_NAME,
    {
      title: 'Publish design result',
      description:
        'Put the DESIGN RESULT on a design work item (by identifier, e.g. "ACME-7") — the note ' +
        'sections you changed, the "*.mock.html" mock and the ".png" export, in ONE call. This ' +
        'is the last step of a design card and the deliverable a reviewer actually opens: the ' +
        'pull request is not it, and a card whose panel is empty reads as a design nobody did. ' +
        'Call it yourself once the three files are committed — nothing else will, and a missing ' +
        'publish looks exactly like a successful run (files written, commit landed, checks ' +
        'green, card empty). Send only the note SECTIONS this work changed, never a whole area ' +
        'note. The REPOSITORY stays the source of truth: the published result is the card’s ' +
        'view of assets that are still committed. Targets a LEAF — a design result belongs to ' +
        'the card that produced it, so a container is refused. "text/html" is accepted HERE and ' +
        'only here; "attach_file" still refuses it. EACH ASSET CARRIES ONE OF TWO FORMS: ' +
        '"contentBase64" for a small file, or the "pathname" of a "create_design_upload" grant ' +
        'you already PUT the bytes to — which is the form a real design board needs, because a ' +
        'multi-megabyte .png is larger than a tool argument can carry. One publish uses one form ' +
        'for all of its assets. Honors the same access checks, media-type and size limits as the UI.',
      inputSchema,
    },
    async (args, extra) => runPublishDesignResult(args as PublishArgs, resolveContext(extra)),
  );

  server.registerTool(
    CREATE_DESIGN_UPLOAD_TOOL_NAME,
    {
      title: 'Create design upload',
      description:
        'STEP 1 OF 2 for a design asset TOO LARGE to send inline — mints a short-lived (~5 min) ' +
        'presigned PUT URL per file, each bound to one exact object and one media type. PUT each ' +
        'file’s bytes straight to its "uploadUrl" (a plain HTTP PUT with that "Content-Type" — ' +
        'nothing about that step goes through Motir), then call "publish_design_result" with the ' +
        '"pathname" each grant returned. THE BYTES NEVER PASS THROUGH A TOOL ARGUMENT, which is ' +
        'the whole point: a design board is routinely several megabytes, base64 is 1.37x that, ' +
        'and no agent can emit it — so for those assets the inline form is not slow, it is ' +
        'impossible. Use the inline "contentBase64" form for a small file and this pair for ' +
        'anything a full-page .png export produces. Targets a LEAF, exactly as the publish does. ' +
        'Honors the same access checks, media-type allowlist and per-file cap as the UI.',
      inputSchema: createUploadInputSchema,
    },
    async (args, extra) => runCreateDesignUpload(args as CreateUploadArgs, resolveContext(extra)),
  );
}
