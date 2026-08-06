import type { McpToolName } from '../registry';
import type { PayloadDefinition } from './define';
import { isExemptTool } from './exemptions';
import {
  MCP_UNREACHABLE_RESOURCES,
  SHARED_RESOURCE_NAMES,
  type SharedResourceName,
} from './sharedResources';
import {
  addCommentPayload,
  claimNextReadyPayload,
  getWorkItemPayload,
  listReadyPayload,
  nextReadyPayload,
  searchWorkItemsPayload,
  workItemWritePayload,
} from './workItems';
import {
  listProjectsPayload,
  listSprintsPayload,
  membershipMovePayload,
  sprintWritePayload,
  whoamiPayload,
} from './planning';
import {
  activityPagePayload,
  dispatchPromptPayload,
  markIntegratedPayload,
  planJobHandlePayload,
  planOutcomePayload,
  planPayload,
  planSessionPayload,
  planSubmitPayload,
  sessionCloseOutPayload,
} from './workLoop';

// The TOOL → PAYLOAD map (Story 11.6 · Subtask 11.6.6 — MOTIR-2232).
//
// `derived()` is called at each tool, and until now no VALUE recorded which
// tools call it — so "every tool derives" was checkable only by reading
// thirty-odd files. This map is that missing value, and it is what lets the
// drift guard walk `lib/mcp/registry.ts` and report coverage instead of
// asserting over a set nobody defined.
//
// ⚠️ WHAT IS FROZEN AND WHAT IS FREE — read this before reading a red check.
// The guard covers the DATA SHAPE and NOTHING else. Tool NAMES, `tools/list`
// DESCRIPTIONS, ARGUMENT names and SCOPES are MCP's own and SHOULD churn:
// rewording a description is how an agent's behaviour gets tuned, and the whole
// architecture rests on that staying free, because only agents read them. If a
// red check here ever seems to forbid rewording a description, it is being
// misread — nothing in this file or its guard looks at prose. A contributor who
// concludes otherwise will route around the guard, which is a worse outcome than
// the drift it prevents (ADR Amendment 7; Story 11.6 criterion 3).

/**
 * Every tool that DERIVES, and the payload definition it derives through.
 *
 * `Partial` on purpose: the complement is `EXEMPT_TOOLS`, and
 * {@link unresolvedTools} asserts the two PARTITION the registry — so a tool
 * missing here is a failing run rather than a silent gap.
 */
export const TOOL_PAYLOADS: Partial<Record<McpToolName, PayloadDefinition<never>>> = {
  // 11.6.2 — the proving tool
  get_work_item: getWorkItemPayload as unknown as PayloadDefinition<never>,
  // 11.6.3 — the work-item family
  search_work_items: searchWorkItemsPayload as unknown as PayloadDefinition<never>,
  list_ready: listReadyPayload as unknown as PayloadDefinition<never>,
  next_ready: nextReadyPayload as unknown as PayloadDefinition<never>,
  claim_next_ready: claimNextReadyPayload as unknown as PayloadDefinition<never>,
  create_work_item: workItemWritePayload as unknown as PayloadDefinition<never>,
  update_work_item: workItemWritePayload as unknown as PayloadDefinition<never>,
  transition_status: workItemWritePayload as unknown as PayloadDefinition<never>,
  archive_work_item: workItemWritePayload as unknown as PayloadDefinition<never>,
  unarchive_work_item: workItemWritePayload as unknown as PayloadDefinition<never>,
  change_kind: workItemWritePayload as unknown as PayloadDefinition<never>,
  move_to_parent: workItemWritePayload as unknown as PayloadDefinition<never>,
  add_comment: addCommentPayload as unknown as PayloadDefinition<never>,
  // 11.6.4 — project / sprint / backlog / identity
  list_projects: listProjectsPayload as unknown as PayloadDefinition<never>,
  whoami: whoamiPayload as unknown as PayloadDefinition<never>,
  list_sprints: listSprintsPayload as unknown as PayloadDefinition<never>,
  create_sprint: sprintWritePayload as unknown as PayloadDefinition<never>,
  update_sprint: sprintWritePayload as unknown as PayloadDefinition<never>,
  start_sprint: sprintWritePayload as unknown as PayloadDefinition<never>,
  complete_sprint: sprintWritePayload as unknown as PayloadDefinition<never>,
  move_to_sprint: membershipMovePayload as unknown as PayloadDefinition<never>,
  move_to_backlog: membershipMovePayload as unknown as PayloadDefinition<never>,
  // 11.6.5 — the work-loop family
  dispatch_prompt: dispatchPromptPayload as unknown as PayloadDefinition<never>,
  mark_integrated: markIntegratedPayload as unknown as PayloadDefinition<never>,
  complete_session: sessionCloseOutPayload as unknown as PayloadDefinition<never>,
  expand_item: planJobHandlePayload as unknown as PayloadDefinition<never>,
  get_plan_status: planOutcomePayload as unknown as PayloadDefinition<never>,
  get_plan: planPayload as unknown as PayloadDefinition<never>,
  open_plan_session: planSessionPayload as unknown as PayloadDefinition<never>,
  append_plan_turn: planSessionPayload as unknown as PayloadDefinition<never>,
  submit_plan_session: planSubmitPayload as unknown as PayloadDefinition<never>,
  get_work_item_activity: activityPagePayload as unknown as PayloadDefinition<never>,
};

/** Whether a tool derives its payload from a declared shared schema. */
export function isDerivedTool(name: McpToolName): boolean {
  return name in TOOL_PAYLOADS;
}

/**
 * Registered tools that are NEITHER derived NOR exempt.
 *
 * Empty is the invariant. A non-empty result is the defect this whole mechanism
 * exists to make visible: a tool nobody thought about and a tool deliberately
 * left out look identical from every other angle, including a passing suite.
 */
export function unresolvedTools(toolNames: readonly McpToolName[]): McpToolName[] {
  return toolNames.filter((name) => !isDerivedTool(name) && !isExemptTool(name));
}

/** Tools claimed by BOTH columns — a contradiction, and also empty. */
export function doublyResolvedTools(toolNames: readonly McpToolName[]): McpToolName[] {
  return toolNames.filter((name) => isDerivedTool(name) && isExemptTool(name));
}

/** Every shared resource some tool's payload PROBES. */
export function probedResources(): Set<SharedResourceName> {
  const probed = new Set<SharedResourceName>();
  for (const definition of Object.values(TOOL_PAYLOADS)) {
    for (const probe of definition.probes) probed.add(probe.resource);
  }
  return probed;
}

/**
 * Shared resources with NO MCP check and NO written reason.
 *
 * The coverage half of the guard. A resource that no tool probes is legitimate —
 * some resources genuinely have no MCP payload — but the legitimacy has to be
 * WRITTEN in {@link MCP_UNREACHABLE_RESOURCES}, because otherwise "not checked"
 * and "not noticed" are the same thing to every reader.
 */
export function unexplainedResources(): SharedResourceName[] {
  const probed = probedResources();
  return SHARED_RESOURCE_NAMES.filter(
    (name) => !probed.has(name) && !(name in MCP_UNREACHABLE_RESOURCES),
  );
}
