import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { presentSectionSets } from '@/lib/api/v1/sectionSets/schema';
import { sectionSchemaService } from '@/lib/services/sectionSchemaService';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { derived } from '../payloads/define';
import { sectionSetsPayload } from '../payloads/sectionSets';

// `get_section_sets` (Story MOTIR-9023 · MOTIR-9029) — which sections a work item
// of a given kind and type has, which are required and the heading each renders
// under in the free-text `descriptionMd`. A planner calls it to learn what a card
// needs BEFORE it writes one, instead of guessing and learning from a refusal.
//
// ── No `projectKey` ─────────────────────────────────────────────────────────
// The sets are a product contract, the same for every tenant, so the tool takes
// no project. It is gated on `project:browse` like `whoami`, the other
// project-less read, rather than faking a project argument to get past the gate.
//
// ── `kind` / `type` are plain strings ───────────────────────────────────────
// Deliberately NOT a zod enum: an enum is refused by the SDK with a generic
// validation error before this handler runs. A string reaches
// `sectionSchemaService.describe`, whose `UnknownSectionCellError` names the value
// and lists the legal ones — and never falls back to a default set.

export const GET_SECTION_SETS_TOOL_NAME = 'get_section_sets';

const inputSchema = {
  kind: z
    .string()
    .optional()
    .describe('Only this kind’s sets: epic, story, task, subtask or bug. Omit for every kind.'),
  type: z
    .string()
    .optional()
    .describe(
      'Only this type’s sets (code, design, decision, test, …), one cell per kind (a story and an epic have one set whatever the type). Omit for every type.',
    ),
};

export function runGetSectionSets(args: { kind?: string; type?: string }): CallToolResult {
  try {
    const descriptor = presentSectionSets(sectionSchemaService.describe(args));
    const lines = descriptor.sets.map((set) => {
      const required = set.sections.filter((s) => s.required).map((s) => s.name);
      const optional = set.sections.filter((s) => !s.required).map((s) => s.name);
      return `${set.kind} / ${set.type ?? 'no type'} — required: ${required.join(', ') || 'none'}; optional: ${optional.join(', ') || 'none'}`;
    });
    const text =
      `Section sets ${descriptor.version} — ${descriptor.sets.length} cell(s).\n` +
      (lines.length > 0 ? lines.join('\n') : 'No cell matches that kind and type.');
    return toolOk(text, derived(sectionSetsPayload, descriptor));
  } catch (err) {
    return toToolError(err);
  }
}

export function registerGetSectionSets(
  server: McpServer,
  _resolveContext: McpContextResolver,
): void {
  server.registerTool(
    GET_SECTION_SETS_TOOL_NAME,
    {
      title: 'Get section sets',
      description:
        'Which sections a work item of a given kind and type has, which of them are REQUIRED, and ' +
        'the heading each renders under in the free-text description. Call it before writing a card ' +
        'to learn what it needs. Narrow it with `kind`, `type`, or both; a value that names no kind ' +
        'or type is refused by name (`UNKNOWN_SECTION_CELL`), never answered with a default set. ' +
        'Takes no project: the sets are the same for every tenant. `structuredContent` carries ' +
        'the full descriptor and its `version`. Read-only.',
      inputSchema,
    },
    async (args) => runGetSectionSets(args),
  );
}
