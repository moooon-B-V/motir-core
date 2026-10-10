import type { McpCatalogueToolName } from '@/lib/apiDocs/mcp';

// One tool's summary in a non-English language (MOTIR-8031).
//
// `source` is the FULL English summary the translation was made from — the same
// convention as `messages/sources/<locale>.json` — so a reviewer sees exactly
// what changed when the English moves. A translation is served only while its
// `source` still equals today's `TOOL_SUMMARIES[name].summary`; otherwise the
// tool is served in English. It is deliberately NOT the tool-text fingerprint:
// that pins the summary to the server's tool, this pins a translation to the
// summary — two different edges.
export interface McpSummaryTranslation {
  summary: string;
  source: string;
}

// Partial, because translations land per locale over time. A key that names no
// tool fails typecheck.
export type McpSummaryTranslations = Partial<Record<McpCatalogueToolName, McpSummaryTranslation>>;
