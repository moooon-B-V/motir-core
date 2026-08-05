import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { commentsService } from '@/lib/services/commentsService';
import { projectsService } from '@/lib/services/projectsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { buildDispatchProseAdvisories } from '@/lib/services/proseGraphAdvisoryService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { ReadyItemDispatchDto } from '@/lib/dto/ready';
import { isOrderingAdvisory, isRepoStraddleAdvisory } from '@/lib/dto/workItems';
import type { WorkItemProseAdvisoryDto } from '@/lib/dto/workItems';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import {
  attachCommentCounts,
  commentCountMarker,
  COMMENT_COUNT_DESCRIPTION,
} from '../commentCounts';
import { projectKeyField } from './readyFilters';

// `claim_next_ready` (MOTIR-1330) — ATOMIC, race-safe dispatch claim. Unlike
// `next_ready` (which READS the top ready item without changing it), this CLAIMS:
// it locks the highest-ranked ready Subtask (`FOR UPDATE SKIP LOCKED`), flips it
// to `in_progress`, and returns the same dispatch payload — all in one
// transaction. Two concurrent `motir run` sessions therefore never claim the same
// item: the loser takes the next-best, or gets an empty result and RETRIES. The
// claim IS the dispatch flip, so the caller must NOT also `transition_status`
// afterwards. SCOPE: the active sprint is resolved server-side (one per project)
// and the claim is scoped to it when present; when there is NO active sprint —
// Motir used without sprint planning (plain Kanban) — the claim widens to the
// whole project, so a missing sprint is never an error. No sprint id is passed.
//
// It ALSO returns the claimed card's PROSE-vs-GRAPH advisories (MOTIR-2079) —
// the planner-agent half of "dispatch reads the advisories". ⚠️ Additive and
// never a gate: the SELECTION, the claim, and the returned item are byte-identical
// whether the array is empty or not. It changes what the claimer is TOLD, not
// what it gets. See `buildDispatchProseAdvisories` for why the tier must not gate.

export const CLAIM_NEXT_READY_TOOL_NAME = 'claim_next_ready';

const inputSchema = {
  projectKey: projectKeyField,
};

interface ClaimNextReadyArgs {
  projectKey: string;
}

/** Compact summary of the claimed item. */
function summarize(
  item: ReadyItemDispatchDto,
  commentCount: number,
  advisories: WorkItemProseAdvisoryDto[],
): string {
  const lines = [
    `Claimed (now In Progress): ${item.key} [${item.kind}/${item.priority}] ${item.title}${commentCountMarker(commentCount)}`,
    `Run: ${item.runCommand}`,
  ];
  if (item.parentKey) lines.push(`Parent: ${item.parentKey}`);
  if (item.contextRefs.length > 0) lines.push(`Context refs: ${item.contextRefs.join(', ')}`);
  // The prose-vs-graph advisory (MOTIR-2079). Phrased as a prompt to LOOK, never
  // as a failure: the claim SUCCEEDED and the item is In Progress either way.
  const references = advisories.filter((a) => a.kind !== 'shape');
  const shapes = advisories.filter(isOrderingAdvisory);
  const straddles = advisories.filter(isRepoStraddleAdvisory);
  if (references.length > 0) {
    lines.push(
      `Advisory (NOT a blocker — the claim stands): this card's acceptance criteria name ` +
        `${references.map((a) => `${a.referenced} (${a.referencedStatus})`).join(', ')} ` +
        'with no blocked_by edge to it. Verify each one is on origin/main before you branch; ' +
        'if it lives only on an open PR, wire the blocked_by edge and stop.',
    );
  }
  // The ORDERING advisory (MOTIR-2175) — the one a claimer most needs up front,
  // because it says part of the card is not this run's to finish.
  for (const s of shapes) {
    lines.push(
      `Advisory (NOT a blocker — the claim stands): acceptance criterion ${s.criterionIndex} ` +
        `says "${s.phrase}", which is state that exists only AFTER this card's own PR has ` +
        'merged — and your boundary ends at PR opened. That criterion and everything below it ' +
        'belongs to a follow-on card; build what is above the line and report the split.',
    );
  }
  // The REPO-STRADDLE advisory (MOTIR-2177). The claimer is about to create ONE
  // worktree; a criterion discharged in a second repo is one it cannot satisfy
  // from there, and finding that out after branching is run.md guard #5 firing
  // at the expensive end.
  for (const s of straddles) {
    lines.push(
      `Advisory (NOT a blocker — the claim stands): acceptance criterion ${s.criterionIndex} ` +
        `names ${s.path}, which lives in ${s.repo}` +
        (s.reason === 'contradiction'
          ? " — not this card's pinned repo."
          : ', and this card pins no repo while its criteria name more than one.') +
        ' One subtask, one repo, one PR. CHECK IT before you branch: if the other repo already ' +
        "has that half, or this card's body pins a producer/mirror contract split, proceed — " +
        "otherwise surface the split and stop rather than dropping the other repo's criteria.",
    );
  }
  if (item.descriptionMd) {
    const excerpt = item.descriptionMd.slice(0, 800);
    lines.push('', excerpt + (item.descriptionMd.length > 800 ? '…' : ''));
  }
  return lines.join('\n');
}

export async function runClaimNextReady(
  args: ClaimNextReadyArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  const project = await projectsService.getByKey(args.projectKey, ctx);
  // Prefer the active sprint when one exists (sprint discipline — dispatch only
  // committed work); otherwise claim across the WHOLE project. Motir can be used
  // WITHOUT planning a sprint (plain Kanban), so a missing active sprint is NOT
  // an error — it just widens the claim to the project's ready set.
  const activeSprint = await sprintsService.getActiveSprint(project.id, ctx);
  const item = await workItemsService.claimNextReady(project.id, activeSprint?.id ?? null, ctx);
  if (!item) {
    const scope = activeSprint ? 'the active sprint' : 'this project';
    return toolOk(
      `No ready work item in ${scope} to claim — RETRY (a sibling may have just claimed the last ` +
        'one), or check there is unblocked work to start.',
      // `advisories` is present on BOTH arms so the caller reads one shape and
      // never has to branch on "did I get an item?" before reading it.
      { item: null, reason: 'none_ready', advisories: [] },
    );
  }
  // The DISCUSSION signal on the claimed payload (MOTIR-2001) — the same field
  // `next_ready` attaches, from the same seam, so a CLAIM and a peek never
  // disagree about whether the card has a thread worth reading first.
  //
  // …and the PROSE-vs-GRAPH advisories (MOTIR-2079), resolved AFTER the claim
  // rather than inside it. The claim is a `FOR UPDATE SKIP LOCKED` transaction
  // whose whole value is being short; this is a read that cannot change which
  // item was claimed, so holding the row lock across it would buy nothing and
  // cost every concurrent caller. Selection is untouched by construction.
  const [counts, advisories] = await Promise.all([
    commentsService.getCommentCountsForItems([item.id], ctx),
    buildDispatchProseAdvisories(
      {
        id: item.id,
        identifier: item.key,
        descriptionMd: item.descriptionMd,
        // The ORDERING exemption's inputs (MOTIR-2175) — already on the ready row.
        type: item.type,
        executor: item.executor,
        // The REPO-STRADDLE pin (MOTIR-2177). This is the RESOLVED repo, not the
        // raw column, and the two are interchangeable for this check: they can
        // only differ on an UNPINNED card, where resolution falls back to the
        // workspace's SINGLE connected repo — and with one candidate repo there
        // is nothing to contradict and no second repo to be unpinnable between,
        // so both values emit nothing. With two or more repos an unpinned card
        // resolves to `null`, which is the raw column exactly.
        targetRepo: item.targetRepo,
      },
      ctx,
    ),
  ]);
  const claimed = attachCommentCounts([item], counts)[0]!;
  return toolOk(summarize(item, claimed.commentCount, advisories), {
    item: claimed as unknown as Record<string, unknown>,
    // Additive and ALWAYS present — `[]` when the card names nothing, so a
    // caller reads one shape. It rides beside `item` rather than on it: it is a
    // fact about the card's PLAN GRAPH, not a column of the dispatch payload,
    // and `next_ready` returns the same `item` shape without it.
    advisories,
  });
}

export function registerClaimNextReady(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    CLAIM_NEXT_READY_TOOL_NAME,
    {
      title: 'Claim next ready work item',
      description:
        "ATOMICALLY claim the next ready Subtask in the project's ACTIVE sprint for dispatch: " +
        'locks the highest-ranked ready item, transitions it to In Progress, and returns the full ' +
        'dispatch payload (description, context refs, blocker keys, run command). Two concurrent ' +
        'callers never get the same item — the claim IS the status flip, so do NOT call ' +
        'transition_status afterwards. Returns an empty result (retry) when nothing is ready or no ' +
        'sprint is active. Also returns `advisories` — always present, `[]` when there are none — ' +
        "each naming a work item the claimed card's ACCEPTANCE CRITERIA reference while carrying " +
        'no blocked_by edge to it (the `likely-missing-edge` tier of the prose-vs-graph check). ' +
        'These NEVER gate: the item was claimed and is In Progress regardless, and selection is ' +
        'identical with or without them. Read them before you branch — verify each referenced ' +
        'item’s substrate is already on origin/main; if it lives only on an open pull request, ' +
        'wire the blocked_by edge and stop rather than rebuilding the other half. ' +
        COMMENT_COUNT_DESCRIPTION,
      inputSchema,
    },
    async (args, extra) => {
      try {
        return await runClaimNextReady(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
