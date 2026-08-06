import type { z } from 'zod/v4';
import type { PayloadDefinition } from './define';
import { sharedResourceSchema, type SharedResourceName } from './sharedResources';

// The DRIFT GUARD (Story 11.6 · Subtask 11.6.6 — MOTIR-2232).
//
// Every other card in this story fixes drift that exists TODAY. This is the only
// one that does anything about drift that has not happened yet — and since the
// tools will keep changing for years, that is where most of the value is.
//
// The work the family cards did DECAYS. Re-basing thirty tools onto shared
// schemas is correct on the day it merges and starts eroding immediately: the
// next person adding a field to a REST response has no reason to think about an
// MCP tool, and the next person adding a tool has no reason to read a story that
// closed months ago. That is not carelessness, it is the normal condition of a
// codebase with two surfaces. A guard is the only thing that survives it.
//
// ⚠️ WHAT THIS FREEZES, AND WHAT IT DELIBERATELY DOES NOT.
// It covers the DATA SHAPE and nothing else — the half with a SECOND consumer.
// Tool NAMES, `tools/list` DESCRIPTIONS, ARGUMENT names and SCOPES are MCP's own
// and SHOULD churn freely: rewording a description is how an agent's behaviour
// gets tuned, and the epic's whole architecture rests on that freedom, because
// only agents read them. **Nothing in this file looks at prose.** If a red check
// here ever seems to forbid rewording a tool description, it is being misread.
// This warning is here rather than only in a card because a contributor who
// concludes the guard forbids it will route AROUND the guard, and that is a
// worse outcome than the drift it prevents. (ADR Amendment 7; Story 11.6
// criterion 3.)
//
// ── WHERE IT RUNS — required, and already so ────────────────────────────────
// `tests/mcp/drift-guard.test.ts` drives this over the whole derived set. It
// needs no bespoke CI job and deliberately does not get one: the sharded
// `Vitest` matrix in `.github/workflows/ci.yml` runs the entire suite against a
// real Postgres, and every job there is gated THROUGH `CI complete` — the ONE
// required context `protect-main` names (see that file's comment for why jobs are
// not required by name). So the guard is a required check by construction, and a
// second lane would be a second thing to keep in sync for no added signal.
//
// ── What it CANNOT catch, by construction ───────────────────────────────────
// Two mappers can satisfy one schema and still disagree: a mapper reading
// `updatedAt` where it should read `createdAt` produces a payload that is
// structurally perfect and factually wrong. No schema check sees that. Closing
// that gap is MOTIR-2234's job — the same row read through BOTH live surfaces
// and diffed. The two checks are not redundant, and 11.6.8 proves it by planting
// a bug this guard cannot see.

/** One way a payload failed to agree with the shared schema it claims. */
export interface DriftViolation {
  /** The v1 component the part was checked against. */
  resource: SharedResourceName;
  /** Which occurrence, when a probe selects a collection. */
  index: number;
  /** The zod message, naming the field and what was wrong with it. */
  detail: string;
}

/**
 * Check ONE payload against every shared schema its definition claims.
 *
 * For each probe: pull the resource-valued parts out and `safeParse` them
 * against the SAME schema `/api/v1` responds with. A field the REST schema
 * requires and the MCP payload lacks fails here — which is the "added on one
 * surface, forgotten on the other" case, caught in the direction that matters.
 *
 * Returns violations rather than throwing, so a run can REPORT every resource it
 * checked and everything that disagreed, instead of stopping at the first.
 */
export function checkPayloadDrift(
  definition: PayloadDefinition<never>,
  payload: unknown,
): DriftViolation[] {
  const violations: DriftViolation[] = [];
  for (const probe of definition.probes) {
    const parts = probe.select(payload as never);
    parts.forEach((part, index) => {
      const schema: z.ZodType = sharedResourceSchema(probe.resource);
      const result = schema.safeParse(part);
      if (!result.success) {
        violations.push({
          resource: probe.resource,
          index,
          detail: result.error.issues
            .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; '),
        });
      }
    });
  }
  return violations;
}

/** Which resources a payload's definition actually checked — the run's receipt. */
export function checkedResources(definition: PayloadDefinition<never>): SharedResourceName[] {
  return definition.probes.map((probe) => probe.resource);
}
