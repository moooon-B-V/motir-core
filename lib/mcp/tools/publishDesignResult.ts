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

export const PUBLISH_DESIGN_RESULT_TOOL_NAME = 'publish_design_result';

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
    .describe(
      'The file’s media type — "text/html", "image/png" or "text/markdown". Anything else is ' +
        'refused: this is the ONE path on which "text/html" is accepted at all.',
    ),
  contentBase64: z.string().min(1).describe('The file’s bytes, base64-encoded.'),
});

const inputSchema = {
  key: workItemKeyField,
  assets: z
    .array(assetSchema)
    .min(1)
    .describe(
      'The files to publish — normally three: the mock, the `.png`, and the note as a ' +
        '"note_file". At least one is required.',
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
    contentType: string;
    contentBase64: string;
  }>;
  noteMd?: string;
  commitSha?: string;
  producedByKey?: string;
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

/** The adapter: resolve project + item by key, decode, then publish. */
export async function runPublishDesignResult(
  args: PublishArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const decoded: Array<{
      kind: DesignAssetKindDTO;
      sourcePath: string;
      contentType: string;
      bytes: Buffer;
    }> = [];
    for (const asset of args.assets) {
      const bytes = decodeBase64(asset.contentBase64);
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

    const identifier = normalizeIdentifier(args.key);
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    const item = await workItemsService.getWorkItemByIdentifier(project.id, identifier, ctx);

    const evidence = await designEvidenceService.recordFromBytes(
      {
        workItemId: item.id,
        assets: decoded,
        noteMd: args.noteMd ?? null,
        commitSha: args.commitSha ?? null,
        producedByKey: args.producedByKey ?? null,
        withinParentKey: args.withinParentKey ?? null,
      },
      ctx,
    );

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
        'only here; "attach_file" still refuses it. Honors the same access checks, media-type ' +
        'and size limits as the UI.',
      inputSchema,
    },
    async (args, extra) => runPublishDesignResult(args as PublishArgs, resolveContext(extra)),
  );
}
