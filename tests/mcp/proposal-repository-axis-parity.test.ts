import { describe, expect, it } from 'vitest';
import { MCP_TOOL_INPUT_SCHEMAS } from '@/lib/apiDocs/mcpToolSchemas';
import type { McpToolInputSchema } from '@/lib/apiDocs/mcpToolSchema';
import { UPDATE_PROPOSAL_KEYS, CORRECT_PROPOSAL_KEYS } from '@/lib/dto/plans';

// ── THE TWO DOORS AGREE ABOUT THE REPOSITORY AXIS (bug MOTIR-4904) ───────────
//
// ── What went wrong ─────────────────────────────────────────────────────────
// A work item's repositories became a SET on the DIRECT write path (Story
// MOTIR-2725 · MOTIR-2727) and the PROPOSAL path was never in that story's
// scope. MOTIR-3540 later gave the correction door the SINGULAR `targetRepo`,
// because the singular was what it was asked for. Two correct passes, neither
// holding the other in scope — and nothing anywhere recorded a decision that a
// proposal may not carry a set, which is the tell that it was an omission.
//
// The consequence is sharper than an awkward API. **A planning pass may not use
// the direct door at all** — the only work item any pass creates directly is a
// `bug` — so for a planner a repository set was not merely inconvenient to
// express, it was INEXPRESSIBLE. The remedy on the record was *approve it, then
// patch it*: a field the approver never saw, written into a card they had
// already approved, with a window in between where the card is dispatchable and
// dispatch routes on the WRONG pin.
//
// ── Why THIS test, and not the integration suite alone ──────────────────────
// The integration suite proves today's three keys work end to end. It cannot see
// the NEXT divergence, which is the shape this whole family of bugs has: a field
// added to one write path and not the parallel one, by a change that is locally
// complete and correct. So this test derives BOTH sides from the shipped
// schemas — the generated `MCP_TOOL_INPUT_SCHEMAS`, which is pinned byte-for-byte
// against a live handshake — and compares the repository-axis key SETS. A key
// added to `create_work_item`'s repository axis and not to `proposedFields` goes
// red here, naming it, with no list to remember to update.

/** The keys of one tool's argument schema, or of a nested object property. */
function propertyNames(schema: McpToolInputSchema | undefined, path: string[] = []): Set<string> {
  let node: unknown = schema;
  for (const segment of path) {
    const props = (node as { properties?: Record<string, unknown> } | undefined)?.properties;
    node = props?.[segment];
    // An `add_plan_items` proposal is an array member, so step through `items`.
    const items = (node as { items?: unknown } | undefined)?.items;
    if (items !== undefined) node = items;
  }
  const props = (node as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (props === undefined) throw new Error(`no properties at ${path.join('.') || '<root>'}`);
  return new Set(Object.keys(props));
}

/** The repository-axis members of a key set — the FIELD, in all its spellings,
 *  and nothing else. Written as a prefix match rather than a list so a fourth
 *  spelling is picked up by both sides at once instead of by neither. */
function repositoryAxis(keys: Set<string>): string[] {
  return [...keys].filter((k) => k.toLowerCase().startsWith('targetrepo')).sort();
}

describe('the repository axis: `create_work_item` ⟷ a plan proposal (bug MOTIR-4904)', () => {
  const createKeys = propertyNames(MCP_TOOL_INPUT_SCHEMAS.create_work_item);
  const proposedKeys = propertyNames(MCP_TOOL_INPUT_SCHEMAS.add_plan_items, [
    'proposals',
    'proposedFields',
  ]);
  const patchKeys = propertyNames(MCP_TOOL_INPUT_SCHEMAS.add_plan_items, ['proposals', 'patch']);
  const correctionKeys = propertyNames(MCP_TOOL_INPUT_SCHEMAS.update_plan_proposal);

  it('reads the schemas it thinks it does — a guard over nothing would pass vacuously', () => {
    // Without this, a rename that made any lookup return an empty set would turn
    // every assertion below into a tautology.
    expect(createKeys.has('title')).toBe(true);
    expect(proposedKeys.has('title')).toBe(true);
    expect(patchKeys.has('blockedByAdd')).toBe(true);
    expect(correctionKeys.has('planItemId')).toBe(true);
    expect(repositoryAxis(createKeys).length).toBeGreaterThan(1);
  });

  it('whatever `create_work_item` accepts for the repository axis, `proposedFields` accepts', () => {
    // The assertion the bug is about, stated as itself. `create_work_item` has
    // taken all three spellings since MOTIR-3039; `proposedFields` took one.
    const missing = repositoryAxis(createKeys).filter((k) => !proposedKeys.has(k));
    expect({ missing }).toEqual({ missing: [] });
  });

  it('…and so does a `modify`’s patch, which is how a re-plan moves an existing card', () => {
    const missing = repositoryAxis(createKeys).filter((k) => !patchKeys.has(k));
    expect({ missing }).toEqual({ missing: [] });
  });

  it('…and so does the CORRECTION door, which is the one the bug was found through', () => {
    const missing = repositoryAxis(createKeys).filter((k) => !correctionKeys.has(k));
    expect({ missing }).toEqual({ missing: [] });
  });

  it('names the three spellings, so a SILENT narrowing of the axis fails here too', () => {
    // The assertions above are relative — they would all pass if the axis were
    // reduced to `targetRepo` on both sides. This is the absolute half.
    expect(repositoryAxis(createKeys)).toEqual(['targetRepo', 'targetRepos', 'targetRepositories']);
  });

  it('the proposal side carries TWO MORE — `targetRepoRole` and the singular ROW-ID ref, and the asymmetry is right', () => {
    // ⚠️ THE PARITY IS ONE-DIRECTIONAL ON PURPOSE, and this records why so the
    // next reader does not "finish" it by adding a role (or a row-ref) to
    // `create_work_item`. A ROLE is a PLAN-ONLY addressing mode:
    // `work_item.targetRepoRole` is RETIRED (Story MOTIR-2732 · MOTIR-3040), so
    // there is no column for the direct door to write. It exists because at
    // generation the project's repositories DO NOT EXIST — the set is derived
    // from the tree — so a fresh plan can pin a role and nothing else. A
    // committed card has rows to point at and needs no stand-in for them.
    //
    // The SINGULAR ROW-ID pin (Story MOTIR-2732 · MOTIR-3045, surfaced by
    // MOTIR-4924) is the same PLAN-ONLY shape one spelling over: `create_work_item`
    // expresses a row id as the PLURAL `targetRepositories`, so the direct door
    // has no need of (and no column for) a singular form — while a proposal, whose
    // planner emits the singular, must be able to say it.
    expect(repositoryAxis(proposedKeys)).toEqual([
      'targetRepo',
      'targetRepoRole',
      'targetRepos',
      'targetRepositories',
      'targetRepositoryRef',
    ]);
    expect(createKeys.has('targetRepoRole')).toBe(false);
    expect(createKeys.has('targetRepositoryRef')).toBe(false);
  });
});

describe('the DEEPEN turn still refuses the repository axis (bug MOTIR-4904)', () => {
  const deepenKeys = propertyNames(MCP_TOOL_INPUT_SCHEMAS.update_plan_item);

  // ⚠️ THIS IS THE BOUNDARY THE FIX MUST NOT ERODE, which is why it is pinned
  // rather than left to be inferred from the absence of a line of code.
  //
  // `agent-authored-plans.md` AMENDMENT 3 D3 draws the deepen line as *a deepen
  // may change what a card SAYS and who ACTS on it, never where it SITS or
  // SHIPS* — and the repository axis is SHIPS. Widening the correction door was
  // AMENDMENT 7's deliberate exception for a DIFFERENT act with a different
  // trigger; widening the deepen with it would re-open structure on the path D3
  // was written to protect, silently and for every proposal.
  //
  // The temptation is real and local: the two tools sit beside each other, take
  // overlapping arguments, and the shortest way to "add the field" is to add it
  // to the shared input type. `UpdateProposalInput` is exactly that shared type,
  // and `CorrectProposalInput extends` it — so the field has to go on the CHILD.
  it('`update_plan_item` takes no repository field, in any of its spellings', () => {
    expect(repositoryAxis(deepenKeys)).toEqual([]);
  });

  it('and neither does the input type the deepen and the correction SHARE', () => {
    // The type-level half: the correction's keys are the deepen's PLUS the
    // structural ones, so the axis must appear only in the difference.
    const shared = [...UPDATE_PROPOSAL_KEYS] as string[];
    const structural = [...CORRECT_PROPOSAL_KEYS].filter((k) => !shared.includes(k));
    expect(repositoryAxis(new Set(shared))).toEqual([]);
    expect(repositoryAxis(new Set(structural))).toEqual([
      'targetRepo',
      'targetRepoRole',
      'targetRepos',
      'targetRepositories',
      'targetRepositoryRef',
    ]);
  });
});
