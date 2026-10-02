// Each MCP tool's link to its OWN entry in the published tool reference
// (MOTIR-7391).
//
// ── Why every description carries one ───────────────────────────────────────
// Claude's connector directory reviews a server's `tools/list` and, on the
// release that cleared its title and `$ref` findings (MOTIR-7189), still raised
// one suggestion on six write tools: "Reference the target API docs in the
// description." The reference already exists — `/docs/mcp/tools`, one entry per
// tool — so the registration seam (`lib/mcp/toolAnnotations.ts`'s
// `annotatedServer`) appends this sentence to EVERY tool's description, not just
// the six, so the next tool added cannot reintroduce the suggestion.
//
// ── Why the url is the hosted one on every build ────────────────────────────
// The page is not served by this application. It is rendered by
// `motir-marketing` from this app's `/api/docs/mcp-tools.json`, and the hosted
// application's `/docs/*` paths redirect there (path and fragment preserved). A
// self-hosted build serves no `/docs/mcp/tools` of its own, so the app's origin
// accessor would point its tools at a 404 — and the published reference is the
// same catalogue for that build's version. The description must also be the
// SAME text on every deployment: `tests/mcp/tool-doc-truth.test.ts` pins it and
// `tests/mcp/tool-schema-truth.test.ts` regenerates beside it, neither of which
// can depend on an environment variable.
//
// ── The anchor ──────────────────────────────────────────────────────────────
// `motir-marketing/app/docs/(guides)/mcp/tools/page.tsx` gives each tool's entry
// `id={`tool-${tool.name}`}`, for each tool in the catalogue this app serves.
// {@link mcpToolDocAnchor} is that rule held once on this side, and
// `tests/mcp/tool-reference-links.test.ts` holds every shipped tool to it.
//
// A LEAF with no imports, so `lib/mcp/` (the seam) and `lib/apiDocs/` (the
// public catalogue) can both reach it without either dragging the other in.

/** The published per-tool MCP reference page. */
export const MCP_TOOL_REFERENCE_PAGE_URL = 'https://app.motir.co/docs/mcp/tools';

/** The id of one tool's entry on the reference page — the page's own `tool-<name>`. */
export function mcpToolDocAnchor(toolName: string): string {
  return `tool-${toolName}`;
}

/** The absolute link to one tool's entry on the reference page. */
export function mcpToolReferenceUrl(toolName: string): string {
  return `${MCP_TOOL_REFERENCE_PAGE_URL}#${mcpToolDocAnchor(toolName)}`;
}

/** The closing sentence a tool's description ends with. */
export function mcpToolReferenceSentence(toolName: string): string {
  return `Reference: ${mcpToolReferenceUrl(toolName)}`;
}

/** `description` with the tool's reference sentence appended as its own paragraph. */
export function withMcpToolReference(toolName: string, description: string | undefined): string {
  const sentence = mcpToolReferenceSentence(toolName);
  const authored = description?.trimEnd() ?? '';
  return authored === '' ? sentence : `${authored}\n\n${sentence}`;
}

/**
 * The AUTHORED part of a shipped description — the inverse of
 * {@link withMcpToolReference}. The doc-truth fingerprint is taken over this, so
 * a summary is sent back for a re-read when its tool's own words change, not
 * when the reference url does. A description without the exact sentence is
 * returned unchanged, so a missing link still moves the pin.
 */
export function withoutMcpToolReference(toolName: string, description: string): string {
  const suffix = mcpToolReferenceSentence(toolName);
  if (!description.endsWith(suffix)) return description;
  return description.slice(0, -suffix.length).trimEnd();
}
