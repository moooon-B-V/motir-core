import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkItemKind, WorkItemPriority } from '@/generated/prisma/client';
import { InvalidRequestError } from '@/lib/api/v1/errors';
import { parseReadyFilters } from '@/lib/api/v1/ready/schema';
import { REPO_ROOT, specifiersOf } from '../../helpers/importGraph';

// MOTIR-2458 — the `/ready` query-string vocabularies, and where they come from.
//
// `lib/api/v1/ready/schema.ts` used to build its accepted `kind` / `priority`
// sets from `Object.values(WorkItemKind)` — a RUNTIME import of the generated
// Prisma client for two enums. That one line put `@prisma/client/runtime` in
// every module graph reaching the file, and the OpenAPI operation registry
// reaches it, so three published documentation pages shipped a database client
// to render prose (`tests/public-docs-db-imports.test.ts` measures that end).
//
// The sets are now derived from the DTO unions the same file declares, which
// moves the risk: the schema file no longer notices when the Prisma enum grows.
// So the parity it used to get for free is asserted HERE instead, where
// importing the client costs nothing. The two halves together are the guard the
// card asked to preserve:
//
//   * COMPILE TIME, in the schema file — `AssertTotal<WorkItemKindDto, …>`
//     fails to typecheck if the DTO union grows and `READY_KINDS` does not.
//   * RUN TIME, here — this file fails if the PRISMA enum grows and the DTO
//     union does not, which is the direction the type-level assertion cannot
//     see. Adding a work-item kind therefore still breaks something loudly
//     rather than silently widening (or silently narrowing) what `/ready`
//     accepts.

const SCHEMA_FILE = 'lib/api/v1/ready/schema.ts';

/** The filter a bare request parses to, plus the values the vocabulary accepts. */
function parse(query: string) {
  return parseReadyFilters(new Request(`https://motir.test/api/v1/projects/MOTIR/ready${query}`));
}

describe('the /ready filter vocabularies (MOTIR-2458)', () => {
  it('accepts exactly the Prisma `WorkItemKind` values, no more and no fewer', () => {
    const accepted = Object.values(WorkItemKind).filter(
      (kind) => parse(`?kind=${kind}`).kinds?.length === 1,
    );

    expect(
      accepted,
      'The `kind` vocabulary is derived from `WorkItemKindDto` and no longer reads the Prisma ' +
        'enum at runtime. A kind added to `schema.prisma` but not to the DTO union would be ' +
        'rejected by the API with no compile error anywhere — add it to `WorkItemKindDto` and ' +
        '`READY_KINDS` in lib/api/v1/ready/schema.ts.',
    ).toEqual(Object.values(WorkItemKind));
  });

  it('accepts exactly the Prisma `WorkItemPriority` values, no more and no fewer', () => {
    const accepted = Object.values(WorkItemPriority).filter(
      (priority) => parse(`?priority=${priority}`).priority?.length === 1,
    );

    expect(
      accepted,
      'The `priority` vocabulary is derived from `WorkItemPriorityDto` and no longer reads the ' +
        'Prisma enum at runtime. See the `kind` case above for the fix.',
    ).toEqual(Object.values(WorkItemPriority));
  });

  it('still rejects an off-vocabulary value as INVALID_READY_FILTER', () => {
    // The behaviour the derivation must not change: an unknown facet value is a
    // 422, never a silently dropped filter that matches everything.
    expect(() => parse('?kind=nonsense')).toThrow(InvalidRequestError);
    expect(() => parse('?priority=urgent')).toThrow(InvalidRequestError);

    try {
      parse('?kind=nonsense');
      expect.unreachable('an unknown kind must throw');
    } catch (err) {
      expect((err as InvalidRequestError).code).toBe('INVALID_READY_FILTER');
    }
  });

  it('narrows to the requested values, and omits an absent facet entirely', () => {
    expect(parse('?kind=bug&kind=task').kinds).toEqual(['bug', 'task']);
    expect(parse('?priority=high&priority=highest').priority).toEqual(['high', 'highest']);
    expect(parse('')).toEqual({});
  });

  it('imports the generated Prisma client for TYPES only — never as a runtime value', () => {
    // The actual regression guard, and the reason this file exists. Asserted on
    // the SOURCE because that is what traces: `import type` is erased by the
    // compiler and never reaches a bundle, the same line without the keyword
    // ships an ORM. `specifiersOf` strips type-only imports before answering.
    const runtimeSpecifiers = specifiersOf(readFileSync(join(REPO_ROOT, SCHEMA_FILE), 'utf8'));

    expect(
      runtimeSpecifiers.filter((s) => /^@prisma\/client|^\.prisma\/|^@\/generated\/prisma/.test(s)),
      `${SCHEMA_FILE} must not import the generated Prisma client as a runtime value. A ` +
        'generated enum IS a runtime value: importing one to build a Set of five strings pulls ' +
        'the whole client into every page that reaches this module. Derive the values from the ' +
        'DTO unions above, and keep any type usage as `import type`.',
    ).toEqual([]);
  });
});
