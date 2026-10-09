import type { McpSummaryTranslations } from './types';

// MCP tool summaries in this language (MOTIR-8031) — empty until translated.
//
// Add an entry per tool as `name: { summary, source }`. `source` is PASTED from
// `TOOL_SUMMARIES[name].summary` in `lib/apiDocs/mcp.ts`, never retyped: it is how
// the catalogue knows the translation was made from today's English. Keep
// backticked tool and argument names identical to the source. Group labels are
// not translated here — they come from the app catalogue's `permissions.*`.
export const ja: McpSummaryTranslations = {};
