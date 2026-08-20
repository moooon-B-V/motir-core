import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { planValidityService } from '@/lib/services/planValidityService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  isOrderingAdvisory,
  isReferenceAdvisory,
  isRepoStraddleAdvisory,
  isSelfBlockingDesignAdvisory,
  isSizingAdvisory,
  isSubsumptionAdvisory,
} from '@/lib/dto/workItems';
import type { WorkItemValidityDto } from '@/lib/dto/workItems';
import type { ValidityCondition } from '@/lib/dto/sprints';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { conditionField } from './sprintRef';
import { normalizeIdentifier, projectKeyOf, workItemKeyField } from './workItemRef';
import { TEMP_REF_HELP, normalizeProjectedTarget, planIdField } from './planRef';

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
// `planId` (MOTIR-3095) switches the same question onto the PROJECTED tree —
// the project's live tree ⊕ that plan's `PlanItem` delta — so an agent can
// validate a subtree it has PROPOSED before anybody reviews it. The target may
// then be a `planItem:<id>` temp-ref as well as a committed key, which is the
// case an authoring agent usually has. OMITTING `planId` never reaches the
// projection at all, so an existing caller's result is unchanged by
// construction rather than by test:
// `docs/decisions/agent-authored-plans.md` AMENDMENT 3, Q5–Q8.
//
// A thin READ adapter over `workItemsService.validateWorkItem` /
// `planValidityService.validateProjectedWorkItem` — no business logic here; the
// subtree walk + the validity rule live in the service, and the projected mode
// runs the SAME rule over a different node set. READ scope
// (`lib/mcp/scopes.ts`), like `validate_sprint` / `get_work_item`: the plan is
// read through `plansService.getPlan`, which asserts browse on the same
// project, so the projected reach is the reach of the two calls it replaces.

export const VALIDATE_WORK_ITEM_TOOL_NAME = 'validate_work_item';

const inputSchema = {
  key: workItemKeyField.describe(
    'The work item to validate — the project key, a dash, the number (e.g. "ACME-7"), ' +
      'case-insensitive. With `planId`, this may instead be a `planItem:<id>` temp-ref ' +
      'naming an `add` in that plan (case-SENSITIVE, as `add_plan_items` returned it).',
  ),
  condition: conditionField,
  planId: planIdField,
};

interface ValidateWorkItemArgs {
  key: string;
  condition?: ValidityCondition;
  planId?: string;
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

  const references = result.advisories.filter(isReferenceAdvisory);
  const shapes = result.advisories.filter(isOrderingAdvisory);
  const straddles = result.advisories.filter(isRepoStraddleAdvisory);
  const subsumed = result.advisories.filter(isSubsumptionAdvisory);
  const oversized = result.advisories.filter(isSizingAdvisory);
  const selfBlocking = result.advisories.filter(isSelfBlockingDesignAdvisory);

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
  // The SIZING member of the shape family (MOTIR-3110) — THE ESTIMATION GATE,
  // and this surface is the one the gate's four misses each passed through
  // green. MOTIR-3068 was `valid: true` at 13 SP / 600 min with the split it
  // needed written out in its own description (`notes.html` #323); the number
  // was in a column nothing read, so this block reads it.
  if (oversized.length > 0) {
    lines.push(
      '',
      `Advisory (${unaffected}): these cards are sized OVER the estimation gate — a ` +
        'coding_agent leaf splits at 13+ story points and its run must fit in 60 minutes:',
      ...oversized.map(
        (a) =>
          `  ${a.item} is ${a.storyPoints ?? '—'} points / ${a.estimateMinutes ?? '—'} minutes ` +
          `(over: ${a.threshold === 'both' ? 'both ceilings' : a.threshold === 'story_points' ? 'story points' : 'estimate minutes'})` +
          ` (${a.severity})`,
      ),
      "SPLIT the card before it is dispatched — 13+ is the gate's literal split signal, and a " +
        'run longer than an hour is a card doing more than one thing. Writing "expect this to ' +
        'split" into the description is NOT the remedy: that is the exact shape this check ' +
        'exists to catch, four times over. A card with CHILDREN is sized by rollup and is never ' +
        'reported here, and neither is a human executor — its minutes are human work.',
    );
  }
  // The SELF-BLOCKING-DESIGN member of the shape family (MOTIR-3178) — the
  // planning-time design gate read for its purpose. MOTIR-3154 carried its own
  // `design/ai-planning/` amendment as criterion 1 and the UI built against that
  // drawing as criteria 4-5, and this surface returned `valid: true` with one
  // unrelated advisory (`notes.html` #329; planning bug MOTIR-3158).
  if (selfBlocking.length > 0) {
    lines.push(
      '',
      `Advisory (${unaffected}): these cards are their OWN design blocker — one criterion draws ` +
        'the design, another builds the surface it draws:',
      ...selfBlocking.map(
        (a) =>
          `  ${a.item}: criterion ${a.designCriterionIndex} produces a design asset, ` +
          `criterion ${a.surfaceCriterionIndex} builds a rendered surface (${a.severity})`,
      ),
      'The remedy is a LIFT, not a cut: make the design criterion its OWN type: design card and ' +
        'leave the rest of this one blocked_by it, so somebody sees the drawing before the files ' +
        'written to match it (Principle #13). Read literally the design gate is satisfied here — ' +
        'the design subtask a UI card must be linked to IS this card — which is why a check says ' +
        'it rather than a sentence. A card with CHILDREN is never reported: its design child can ' +
        'be reviewed before its code children run, which is the shape this asks for.',
    );
  }
  // The SUBSUMPTION family (MOTIR-2903) — and this surface is the one whose
  // `advisories: []` is the observation the family exists to invert. MOTIR-2757
  // was `valid: true` with an empty array while its whole deliverable sat merged
  // on `main`.
  if (subsumed.length > 0) {
    lines.push(
      '',
      `Advisory (${unaffected}): these cards name a file that a LATER merge already changed, so ` +
        'their deliverable may already be in the repository:',
      ...subsumed.map(
        (a) =>
          `  ${a.item} names ${a.path}, changed by ${a.pullRequest} (merged ${a.mergedAt}` +
          `${a.pullRequestTitle ? ` — "${a.pullRequestTitle}"` : ''})`,
      ),
      "Read that diff against the card's acceptance criteria. If it delivers them, close the " +
        'card with the merge as the evidence rather than letting it be claimed and rebuilt. Two ' +
        'cards touching one file in sequence is the ordinary case and is why this never gates; a ' +
        'boundary-contract card that shares paths with its sibling by design opts out by saying ' +
        'so in its body (isSubsumptionCheckExempt).',
    );
  }
  return lines;
}

/** Human-readable summary for the dual-content text block.
 *
 * `planId` is present ⟺ the verdict was computed over the PROJECTION, and the
 * text says so: the same `{ key, valid, blockers, advisories }` shape means two
 * different things depending on which tree it was computed over, and a reader
 * watching the session has only this block to tell them apart. */
function summarize(result: WorkItemValidityDto, planId?: string): string {
  const over = planId
    ? ` once plan ${planId} materializes (nothing was created — approving the plan in Motir is ` +
      'still the only path from a proposal to a work item)'
    : '';
  if (result.valid) {
    return [
      `Work item ${result.key} is VALID — its whole subtree can be finished within itself${over}.`,
      ...advisoryLines(result),
    ].join('\n');
  }
  return [
    `Work item ${result.key} is INVALID${over} — ${result.blockers.length} item(s) in its ` +
      'subtree are gated by out-of-subtree, unsatisfied work:',
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
    // `conditionField` fills the default (`loose`) when omitted, and both
    // service params default too — so no `??` on either path (it would add a
    // never-taken branch).
    if (args.planId !== undefined) {
      // PROJECTED. No project lookup here: `buildProjection` resolves the
      // project FROM the plan (and asserts browse on it), and a `planItem:<id>`
      // target has no project-key prefix to derive one from anyway.
      const projected = await planValidityService.validateProjectedWorkItem(
        args.planId,
        normalizeProjectedTarget(args.key),
        ctx,
        args.condition,
      );
      return toolOk(
        summarize(projected, args.planId),
        exempt('validate_work_item', projected as unknown as Record<string, unknown>),
      );
    }
    const identifier = normalizeIdentifier(args.key);
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    const result = await workItemsService.validateWorkItem(
      project.id,
      identifier,
      ctx,
      args.condition,
    );
    return toolOk(
      summarize(result),
      exempt('validate_work_item', result as unknown as Record<string, unknown>),
    );
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
        'criteria, else `advisory`); a `shape` advisory (`kind: "shape"`) names a card that ' +
        'contradicts ITSELF — `likely-ordering-violation` when a criterion reads ' +
        'on post-merge state (with the matched phrase), `likely-repo-straddle` when it names a ' +
        "path in a repo that is not the card's `targetRepo` (with the path, that repo, and " +
        '`reason: "contradiction"`, or `"unpinnable"` when the card pins no repo and its criteria ' +
        'name two or more) — both with the 1-based criterion index to cut at — ' +
        '`likely-over-gate-sizing` when a CHILDLESS coding_agent card is sized over the estimation ' +
        'gate, at 13+ story points or more than 60 estimated minutes (with `threshold`, the ' +
        'observed `storyPoints` and `estimateMinutes`, and no criterion index, because the remedy ' +
        'is to SPLIT the card rather than cut it at a line), or `likely-self-blocking-design` when ' +
        'a CHILDLESS card is its OWN design blocker — one criterion produces a design asset and ' +
        'another builds the rendered surface that drawing decides (with BOTH 1-based indices, ' +
        '`designCriterionIndex` and `surfaceCriterionIndex`, because the remedy LIFTS the design ' +
        'criterion onto its own card rather than cutting the list at a line). Advisories ' +
        'never affect `valid` or `blockers` — a card with advisories is still valid and ready. ' +
        'Pass `planId` to ask the SAME question over a plan you are authoring: the verdict is ' +
        'then computed over the project’s live tree ⊕ that plan’s proposals, so you can check a ' +
        'subtree you have PROPOSED before anybody reviews it. ' +
        TEMP_REF_HELP +
        ' Use `validate_plan` for the whole plan at once — do not loop this call per root, ' +
        'because an edge between two sibling roots is valid there and a false positive here. ' +
        'Read-only, projected or not: it creates nothing and persists nothing.',
      inputSchema,
    },
    async (args, extra) => runValidateWorkItem(args, resolveContext(extra)),
  );
}
