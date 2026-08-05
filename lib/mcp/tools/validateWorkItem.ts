import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { isOrderingAdvisory, isRepoStraddleAdvisory } from '@/lib/dto/workItems';
import type { WorkItemValidityDto } from '@/lib/dto/workItems';
import type { ValidityCondition } from '@/lib/dto/sprints';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { conditionField } from './sprintRef';
import { normalizeIdentifier, projectKeyOf, workItemKeyField } from './workItemRef';

// `validate_work_item` (Story 7.8 · Subtask 7.8.23) — is a work item FINISHABLE?
// The single-item analogue of `validate_sprint`, with the target's SUBTREE
// (the item + all its descendants) standing in for the sprint. The target may
// be any non-leaf kind — epic / story / task / bug. VALID ⟺ every not-done item
// in the subtree has its `blocked_by` closure satisfied: each dependency is IN
// the subtree (the target's own work — never gates), or — under `loose` — done.
//
// `condition` (shared with `validate_sprint`, MOTIR-1374) tunes the
// out-of-subtree `done` case: `loose` (default) accepts a done dependency
// anywhere; `tight` requires it to be IN the subtree, else it is reported.
//
// A thin READ adapter over `workItemsService.validateWorkItem` — no business
// logic here; the subtree walk + the validity rule live in the service. READ
// scope (`lib/mcp/scopes.ts`), like `validate_sprint` / `get_work_item`.

export const VALIDATE_WORK_ITEM_TOOL_NAME = 'validate_work_item';

const inputSchema = {
  key: workItemKeyField,
  condition: conditionField,
};

interface ValidateWorkItemArgs {
  key: string;
  condition?: ValidityCondition;
}

/**
 * The prose-vs-graph advisory lines (MOTIR-1969), appended to EITHER verdict.
 * Deliberately phrased as a prompt to look, never as a failure: advisories do
 * not change `valid`, so a VALID item with advisories is still VALID.
 */
function advisoryLines(result: WorkItemValidityDto): string[] {
  if (result.advisories.length === 0) return [];
  const unaffected = `NOT a blocker — ${result.key} is ${
    result.valid ? 'still VALID' : 'unaffected'
  } either way`;

  const references = result.advisories.filter((a) => a.kind !== 'shape');
  const shapes = result.advisories.filter(isOrderingAdvisory);
  const straddles = result.advisories.filter(isRepoStraddleAdvisory);

  const lines: string[] = [];
  if (references.length > 0) {
    lines.push(
      '',
      `Advisory (${unaffected}): these items are NAMED in a card's description but have no ` +
        'blocked_by edge from it:',
      ...references.map(
        (a) =>
          `  ${a.item} names ${a.referenced} (${a.referencedStatus})` +
          `${a.severity === 'likely-missing-edge' ? ' IN ITS ACCEPTANCE CRITERIA — likely a missing blocked_by' : ''}`,
      ),
      'Wire a blocked_by edge if the card consumes it; ignore this if the reference is context only.',
    );
  }
  // The SHAPE family (MOTIR-2175) — a defect in what the card's own criteria ask
  // for, with no second item involved, so it gets its own block and its own
  // remedy rather than being squeezed into the sentence above.
  if (shapes.length > 0) {
    lines.push(
      '',
      `Advisory (${unaffected}): these cards have an acceptance criterion that reads on state ` +
        "which exists only AFTER the card's own PR has merged — and a card's boundary ends at " +
        'PR opened:',
      ...shapes.map(
        (a) => `  ${a.item} criterion ${a.criterionIndex} says "${a.phrase}" (${a.severity})`,
      ),
      'Cut the card at that criterion: everything from it down belongs to a follow-on card, ' +
        'blocked_by this one (gate 14, ORDERING axis). A deploy / human card that legitimately ' +
        'needs the merge — the release trio\'s "cut" leg — is exempt and never reported here.',
    );
  }
  // The REPO-STRADDLE member of the same family (MOTIR-2177) — gate 1's repo
  // column, and a different remedy again: not "cut the card at this line" but
  // "split it per repo", so it gets its own block rather than being folded into
  // the ordering sentence above.
  if (straddles.length > 0) {
    lines.push(
      '',
      `Advisory (${unaffected}): these cards have an acceptance criterion discharged in a repo ` +
        "that is not the card's own — one subtask, one repo, one pull request:",
      ...straddles.map(
        (a) =>
          `  ${a.item} criterion ${a.criterionIndex} names ${a.path} (${a.repo})` +
          (a.reason === 'contradiction'
            ? ', while the card pins a different targetRepo'
            : ', and the card pins no repo while its criteria name more than one — check whether ' +
              'it is UNPINNABLE rather than unpinned') +
          ` (${a.severity})`,
      ),
      'Split the card per repo (gate 1, the criterion-by-criterion repo column). Two knowingly ' +
        'uncovered forms remain: a BOUNDARY-CONTRACT card — a producer plus its mirrored ' +
        'consumer, two coordinated PRs, legitimately one card — is reported here and is an ' +
        'accepted false positive; and the bare-SYMBOL tell (a symbol whose repo you happen to ' +
        "know) is invisible to this check, so gate 1's prose still applies.",
    );
  }
  return lines;
}

/** Human-readable summary for the dual-content text block. */
function summarize(result: WorkItemValidityDto): string {
  if (result.valid) {
    return [
      `Work item ${result.key} is VALID — its whole subtree can be finished within itself.`,
      ...advisoryLines(result),
    ].join('\n');
  }
  return [
    `Work item ${result.key} is INVALID — ${result.blockers.length} item(s) in its subtree are ` +
      'gated by out-of-subtree, unsatisfied work:',
    ...result.blockers.map(
      (b) =>
        `  ${b.item} is blocked by ${b.blockedBy} (${b.blockerStatus}, ` +
        `${b.blockerSprintId ? `sprint ${b.blockerSprintId}` : 'backlog'})`,
    ),
    'Pull these into the subtree (or finish them), or drop the dependency.',
    ...advisoryLines(result),
  ].join('\n');
}

export async function runValidateWorkItem(
  args: ValidateWorkItemArgs,
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const identifier = normalizeIdentifier(args.key);
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    // `conditionField` fills the default (`loose`) when omitted, and the service
    // param defaults too — so no `??` here (it would add a never-taken branch).
    const result = await workItemsService.validateWorkItem(
      project.id,
      identifier,
      ctx,
      args.condition,
    );
    return toolOk(summarize(result), result as unknown as Record<string, unknown>);
  } catch (err) {
    return toToolError(err);
  }
}

export function registerValidateWorkItem(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    VALIDATE_WORK_ITEM_TOOL_NAME,
    {
      title: 'Validate work-item finishability',
      description:
        'Check whether a work item (any non-leaf kind — epic / story / task / bug) is FINISHABLE: ' +
        'every not-done item in its SUBTREE (the item + all descendants) has each blocked_by ' +
        'dependency either inside the subtree (its own work) or done. A blocker inside the subtree ' +
        'never gates; only out-of-subtree work can. `condition` defaults to `loose` (a done ' +
        'dependency outside the subtree counts as satisfied); pass `tight` to require every ' +
        'dependency to be IN the subtree (a done item outside it is then reported as a blocker). ' +
        'Returns `{ key, valid, blockers: [...], advisories: [...] }` — `blockers` naming each ' +
        'in-subtree item and the out-of-subtree, unsatisfied work gating it. `advisories` is a ' +
        'SEPARATE, NEVER-BLOCKING channel with two families: a `reference` advisory names an ' +
        'in-subtree card whose DESCRIPTION names a not-done work item it has no blocked_by edge ' +
        "to (severity `likely-missing-edge` when the reference sits in the card's own acceptance " +
        'criteria, else `advisory`); a `shape` advisory (`kind: "shape"`) names a card whose own ' +
        'acceptance criterion is mis-shaped — `likely-ordering-violation` when the criterion reads ' +
        'on post-merge state (with the matched phrase), or `likely-repo-straddle` when it names a ' +
        "path in a repo that is not the card's `targetRepo` (with the path, that repo, and " +
        '`reason: "contradiction"`, or `"unpinnable"` when the card pins no repo and its criteria ' +
        'name two or more) — both with the 1-based criterion index to cut at. Advisories ' +
        'never affect `valid` or `blockers` — a card with advisories is still valid and ready. ' +
        'Read-only.',
      inputSchema,
    },
    async (args, extra) => runValidateWorkItem(args, resolveContext(extra)),
  );
}
