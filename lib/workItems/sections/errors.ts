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

/** One section the registry refused, by name: the section and why. */
export interface InvalidSectionFinding {
  section: string;
  message: string;
}

/**
 * A work-item write that carried `sections` the registry refuses for the card's
 * FINAL kind × type (MOTIR-9031): a required section missing, a section the cell
 * does not define, or a value of the wrong shape. The findings ride on the error
 * by name, so the MCP tool, the v1 body and a test read the same three lists; the
 * message names every one, so an agent corrects it in one hop. The plan doors
 * refuse the same mistake through their own `INVALID_PROPOSAL` family, in the same
 * words. → 422
 */
export class InvalidSectionsError extends Error {
  readonly code = 'INVALID_SECTIONS' as const;
  constructor(
    message: string,
    readonly missing: readonly string[] = [],
    readonly unknown: readonly string[] = [],
    readonly invalid: readonly InvalidSectionFinding[] = [],
  ) {
    super(message);
    this.name = 'InvalidSectionsError';
  }
}

/**
 * A write that sent `sections` AND `descriptionMd`: the body would be described
 * twice, and two sources contradict each other. Refused before anything is
 * written. → 422
 */
export class SectionsWithDescriptionError extends Error {
  readonly code = 'SECTIONS_AND_DESCRIPTION_CONFLICT' as const;
  constructor() {
    super(
      'Send `sections` or `descriptionMd`, not both — the description is rendered from the ' +
        'sections, and two sources would contradict each other.',
    );
    this.name = 'SectionsWithDescriptionError';
  }
}
