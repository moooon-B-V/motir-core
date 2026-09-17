import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { designAccessService } from '@/lib/services/designAccessService';
import type { ApprovedDesignAssetDto, DesignVerdictDto } from '@/lib/dto/designAccess';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import { getDesignPayload } from '../payloads/designs';

// `get_design` (Story MOTIR-5553 · Subtask MOTIR-5561) — the APPROVED DESIGN of
// one design card, with short-lived links to its files.
//
// `docs/decisions/design-result.md` AMENDMENT 5 Q6's *browsing further*. The
// tool exists because an agent that has been handed one design routinely needs
// another: the BASE a delta mock amends, a neighbouring surface, the design of a
// card it is about to depend on. Before this, the only way to read a design was
// to open a repository checkout — which a project that does not commit its
// designs cannot offer, and a hosted agent does not have.
//
// ⚠️ THE ANSWER IS A VERDICT, NOT A DESIGN-OR-NOTHING. Five reasons, so an agent
// can tell *the design card is still in review* (wait, or stop and say so) from
// *this is not a design card* (a mis-wired blocker) from *the result was
// withdrawn* (somebody took it back). An empty answer would collapse all five
// into silence, and the agent's next action differs for each.
//
// ⚠️ AND IT IS NOT "the card's current design". AMENDMENT 5 Q2: the approved
// design is the version the APPROVAL named — a design card approved and then
// republished before its merge would otherwise hand back a version nobody
// approved. The ladder lives in `designAccessService`, once, and this tool does
// not re-derive it.

export const GET_DESIGN_TOOL_NAME = 'get_design';

const inputSchema = {
  key: z
    .string()
    .min(1)
    .describe(
      "The DESIGN CARD's identifier — the project key, a dash, the number " +
        '(e.g. "ACME-7"), case-insensitive. Not the key of the card that waits on ' +
        'the design: for that, call `list_designs` with `blockersOf`.',
    ),
};

interface GetDesignArgs {
  key: string;
}

/**
 * An asset as this TOOL reports it: the service's shape plus the short-lived
 * link, which is minted here rather than in the service because every mint
 * starts a 300-second clock and only a caller that has decided to fetch wants one.
 */
type LinkedAsset = ApprovedDesignAssetDto & { url?: string; expiresAt?: string };

/** A verdict whose assets may carry links — what this tool returns. */
type LinkedVerdict =
  | (Extract<DesignVerdictDto, { verdict: 'approved' }> & {
      design: Extract<DesignVerdictDto, { verdict: 'approved' }>['design'] & {
        assets: LinkedAsset[];
      };
    })
  | Extract<DesignVerdictDto, { verdict: 'not_approved' }>;

/** The prose an agent reads, carrying the same facts as the structured payload. */
function summarize(verdict: LinkedVerdict): string {
  if (verdict.verdict !== 'approved') {
    return [
      `${verdict.designCardKey} — NO APPROVED DESIGN (${verdict.reason}): ${verdict.designCardTitle}`,
      REASON_HELP[verdict.reason],
    ].join('\n');
  }

  const { design } = verdict;
  const lines = [
    `${verdict.designCardKey} — APPROVED: ${verdict.designCardTitle}`,
    `version ${design.evidenceId}, published ${design.publishedAt}` +
      (design.commitSha ? `, commit ${design.commitSha}` : ', no commit behind it'),
    '',
    'Files:',
  ];
  for (const asset of design.assets) {
    if (asset.state === 'unavailable') {
      lines.push(
        `  ${asset.kind}  ${asset.sourcePath}  — UNAVAILABLE (this approved version's ` +
          'files were reclaimed; it is still the design that was approved)',
      );
      continue;
    }
    // ⚠️ THE TWO NULL ARMS BELOW ARE DEFENSIVE AND UNREACHABLE FOR AN
    // `available` ASSET, by the invariant `designAccessService` maintains: a
    // size comes from the asset's Attachment, and an asset HAS an Attachment
    // exactly when it is `available` (`toApprovedDesignAssetDto` derives the
    // state from that same row), so a `null` size here would mean the state and
    // the attachment disagreed. The link is the same shape one layer out —
    // `downloadLinks` mints one per available asset. They are kept because a
    // future door could widen the DTO, and they are IGNORED rather than covered
    // with a fixture that asserts a state the service cannot produce.
    // `tests/mcp/designTools.test.ts` pins the invariant itself instead.
    /* v8 ignore next 3 -- unreachable: an `available` asset always has an attachment and a link */
    const size = asset.byteSize === null ? '' : `  ${asset.byteSize} bytes`;
    lines.push(`  ${asset.kind}  ${asset.sourcePath}${size}`);
    if (asset.url) lines.push(`      ${asset.url}`);
  }
  if (design.assets.some((a: LinkedAsset) => a.url)) {
    lines.push(
      '',
      'The links above EXPIRE within minutes. Download them now, before you start ' +
        'reading or building — e.g. `curl -fsSL -o <fileName> "<url>"` — into a ' +
        'directory OUTSIDE the repository checkout, so the design never lands in ' +
        'your diff. Call this tool again for fresh links if they lapse.',
    );
  }
  return lines.join('\n');
}

/** What each no-design reason means for what the agent should do next. */
const REASON_HELP: Record<string, string> = {
  not_a_design_card:
    "That card's type is not `design`, so it has no design result. If a card is waiting on " +
    'it for a design, the plan is wrong about which card draws the surface.',
  not_done:
    'The design card is not finished — it may be in review, or approved with a pull request ' +
    'still open. A design is only approved once its card reaches Done. Do NOT build the ' +
    'surface against an unapproved design; stop and say what you are waiting for.',
  cancelled: 'The design card was cancelled, so nothing it drew is going to be built.',
  withdrawn:
    'A design result was published and then TAKEN BACK. That is different from never having ' +
    'had one: somebody judged it wrong. Treat the surface as undesigned.',
  no_result:
    'The design card is Done but never published a design result. The surface is undesigned — ' +
    'propose a design card beside the card you are running rather than improvising it.',
};

export async function runGetDesign(
  args: GetDesignArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const verdict = await designAccessService.getApprovedDesign(args.key, ctx);
  if (verdict.verdict !== 'approved') {
    return toolOk(summarize(verdict), derived(getDesignPayload, { ...verdict }));
  }

  // Links are minted HERE rather than in the service, because they are the part
  // an agent needs only when it has decided to fetch — and every mint starts a
  // 300-second clock.
  const links = await designAccessService.downloadLinks(verdict.design.evidenceId, ctx);
  const bySourcePath = new Map(links.map((link) => [link.sourcePath, link]));
  const withLinks = {
    ...verdict,
    design: {
      ...verdict.design,
      assets: verdict.design.assets.map((asset) => {
        const link = asset.state === 'available' ? bySourcePath.get(asset.sourcePath) : undefined;
        return link ? { ...asset, url: link.url, expiresAt: link.expiresAt } : asset;
      }),
    },
  };
  return toolOk(summarize(withLinks), derived(getDesignPayload, withLinks));
}

export function registerGetDesign(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    GET_DESIGN_TOOL_NAME,
    {
      title: 'Get design',
      description:
        'THE APPROVED DESIGN of one design card, with short-lived links to its files. Call it ' +
        'when you need a design you were not handed: the BASE a delta mock amends (find it by ' +
        'its `sourcePath` through `list_designs`), a neighbouring surface, or the design of a ' +
        'card you are about to depend on. ⚠️ THE ANSWER IS A VERDICT, not a design or nothing: ' +
        '`approved` carries the design, and `not_approved` carries ONE OF FIVE REASONS — ' +
        '`not_done` (the design card has not reached Done; approved-with-an-open-pull-request ' +
        'counts as not done), `cancelled`, `withdrawn` (a result was published and taken back), ' +
        '`no_result` (Done, but nothing was ever published) and `not_a_design_card` (that card ' +
        'does not draw anything). They call for different actions, which is why they are not ' +
        'collapsed into an empty answer. ⚠️ THE VERSION IS THE ONE THE APPROVAL NAMED, never ' +
        "simply the card's current result — a design approved and then republished before its " +
        'merge would otherwise be reported as approved when nobody approved it. ⚠️ THE LINKS ' +
        'EXPIRE WITHIN MINUTES: download every file as soon as you get them (e.g. ' +
        '`curl -fsSL -o <fileName> "<url>"`) into a directory OUTSIDE the repository checkout, ' +
        'so the design never lands in your diff, and call this tool again for fresh links if ' +
        'they lapse. An asset whose `state` is `unavailable` has no link and never will: the ' +
        "approved version's files were reclaimed, which is a real answer rather than an error, " +
        'and it is still the design that was approved. Read-only: it creates nothing and ' +
        'persists nothing.',
      inputSchema,
    },
    async (args, extra) => {
      try {
        return await runGetDesign(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
