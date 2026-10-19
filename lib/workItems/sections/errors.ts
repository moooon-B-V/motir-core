// Typed errors of the sections interface (Story MOTIR-9023). Kept in their own
// file so a route, an MCP tool and a test can import them without pulling in a
// service. Per CLAUDE.md, a service throws a typed error with a stable `code`;
// the transport turns the code into its own refusal.

/**
 * A `kind` or `type` that names no cell of the registry. It names the value it
 * got and lists the legal ones, and it is NEVER answered with a default set: an
 * agent that is handed a plausible default builds on it.
 */
export class UnknownSectionCellError extends Error {
  readonly code = 'UNKNOWN_SECTION_CELL' as const;
  constructor(
    readonly field: 'kind' | 'type',
    readonly value: string,
    legal: readonly string[],
  ) {
    super(`Unknown ${field} '${value}'. Legal values: ${legal.join(', ')}.`);
    this.name = 'UnknownSectionCellError';
  }
}
