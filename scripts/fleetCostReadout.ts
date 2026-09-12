import { CONTAINER_WORKLOAD_BY_FLEET_KIND } from '@/lib/ciFleet/workloads';
import type { CiContainerWorkload } from '@/lib/repositories/ciContainerUsageRepository';
import type {
  MetaSplitContainerCost,
  WorkloadPeriodContainerCost,
} from '@/lib/repositories/ciContainerPeriodCostRepository';

// The FLEET COST READOUT's pure half (Story MOTIR-4335 · MOTIR-4540) — every
// decision about what the operator sees, with no database and no clock.
//
// WHY IT IS SPLIT FROM `fleet-cost-readout.ts`. The runner reads a database and
// prints; this module decides. Keeping them apart is the same reason
// `generateCliApi.ts` is separate from `generate-cli-api.ts`: the three paths this
// card exists to get right are all SHAPES of the output — a disabled meter, a
// workload that did not run, and a decimal that must not be floated — and none of
// them is testable through a module that opens a connection on import.
//
// ⚠️ THIS FILE ADDS NO ARITHMETIC AND NO AGGREGATION, and that is a scope boundary
// rather than an omission. Every figure it prints arrives from
// `ciFleetCostMeterService` over a stored rollup. It deliberately prints NO TOTAL
// line: a total is an addition, the service's own `getOrgPeriodCost` comment says a
// caller that wants one "asks for the breakdown and adds it up, which at least
// makes the addition visible", and doing it here would put a sum in the readout
// that the table does not hold.
//
// ⚠️ AND MONEY IS A STRING FROM THE REPOSITORY TO THE TERMINAL. `costUsd` is summed
// as a SQL decimal and handed over as `Prisma.Decimal#toFixed()` — a string. The
// only thing done to it here is PADDING. There is no `parseFloat`, no `Number()`
// and no float arithmetic on that value anywhere in this module, because the error
// is invisible per row and systematic across a month.

/**
 * The cost lines a readout can print, in display order, derived from the meter's
 * own total-by-construction map rather than re-listed here.
 *
 * Taking it from {@link CONTAINER_WORKLOAD_BY_FLEET_KIND} is what makes the
 * ABSENT-line report below stay correct when a fourth workload lands: that map is
 * a `Record` over every fleet kind, so a new kind is a compile error there and
 * appears here for free. A hand-written literal would silently keep reporting
 * three lines and call the fourth's absence a fact it never checked.
 */
export const READOUT_WORKLOADS: CiContainerWorkload[] = [
  ...new Set(Object.values(CONTAINER_WORKLOAD_BY_FLEET_KIND)),
];

/** One line as the readout prints it — the repository's row, nothing derived. */
export interface WorkloadLine {
  workload: string;
  containerCount: number;
  containerSeconds: number;
  /** Decimal STRING, exactly as the repository produced it. Never a number. */
  costUsd: string;
}

export interface ReadoutInput {
  /** The period the figures were read for — the meter's own `periodStartFor`. */
  periodStart: Date;
  /** Exclusive — the meter's own `periodEndFor`, printed so the boundary the
   *  readout used is on the page rather than inferred (AC 5). */
  periodEnd: Date;
  /** Present only when the operator named an organization. */
  org?: { organizationId: string; lines: WorkloadPeriodContainerCost[] };
  /** The platform-wide meta-vs-tenant split — the read that answers the ADR's
   *  question without needing an org argument. */
  metaSplit: MetaSplitContainerCost[];
}

/** ISO-8601 to the second, in UTC — the period key's own vocabulary. */
function stamp(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * `YYYY-MM` to an instant inside that month, for `--period`.
 *
 * It lives in this module rather than beside the argument parser for the reason
 * the file header gives: the runner executes on import, so anything a test needs
 * to call has to sit on this side of the split.
 *
 * Built from UTC components for the same reason `periodStartFor` is — a local-time
 * constructor keys by the operator's timezone, so the same `--period` would read
 * different months on two machines.
 */
export function parsePeriodArg(value: string): Date {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`--period must be YYYY-MM (got "${value}")`);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error(`--period month out of range: "${value}"`);
  return new Date(Date.UTC(Number(match[1]), month - 1, 1, 0, 0, 0, 0));
}

/**
 * The workloads that printed NO line, given the ones that did.
 *
 * This is the whole of the absent-vs-zero distinction: the rollup holds rows only
 * for what ran, so a workload missing from the result is a claim that nothing ran
 * under that line — NOT a measured zero. The readout states which ones those were,
 * in words, because an omission a reader has to notice is an omission a reader will
 * read as zero.
 */
export function absentWorkloads(lines: Array<{ workload: string }>): CiContainerWorkload[] {
  const present = new Set(lines.map((line) => line.workload));
  return READOUT_WORKLOADS.filter((workload) => !present.has(workload));
}

/**
 * The readout for a build where the meter does not run.
 *
 * Off-cloud there is no fleet, `ciFleetCostMeterService` is inert by `MOTIR_CLOUD`
 * (§8.5), and the rollup is empty because nothing ever wrote to it. Printing `0.00`
 * here would be the single most misleading thing this command could do: it would
 * state that the fleet ran and cost nothing, on a build that has no fleet. So the
 * disabled path prints NO FIGURES AT ALL — not a zero, not an empty table.
 */
export function renderMeterDisabled(): string {
  return [
    'FLEET COST READOUT',
    '',
    '  The fleet cost meter is DISABLED on this build (MOTIR_CLOUD is not "true").',
    '  There is no fleet here, so there are no figures to report — this is NOT a',
    '  reading of zero cost. No figure is printed, deliberately.',
    '',
  ].join('\n');
}

function renderLines(lines: WorkloadLine[]): string[] {
  const costWidth = Math.max(8, ...lines.map((line) => line.costUsd.length));
  const secondsWidth = Math.max(8, ...lines.map((line) => String(line.containerSeconds).length));
  const countWidth = Math.max(10, ...lines.map((line) => String(line.containerCount).length));

  return [
    `    ${'workload'.padEnd(8)}  ${'containers'.padStart(countWidth)}  ` +
      `${'seconds'.padStart(secondsWidth)}  ${'cost usd'.padStart(costWidth)}`,
    ...lines.map(
      (line) =>
        `    ${line.workload.padEnd(8)}  ${String(line.containerCount).padStart(countWidth)}  ` +
        // ⚠️ `costUsd` is padded and NOTHING else. No parse, no re-serialise.
        `${String(line.containerSeconds).padStart(secondsWidth)}  ${line.costUsd.padStart(costWidth)}`,
    ),
  ];
}

function renderAbsence(lines: Array<{ workload: string }>, subject: string): string[] {
  const absent = absentWorkloads(lines);
  if (absent.length === 0) return [];
  return [
    `    ABSENT from ${subject} — no container ran under ${absent.length === 1 ? 'this line' : 'these lines'}`,
    `    in this period. This is an ABSENCE, not a measured zero: ${absent.join(', ')}`,
  ];
}

/**
 * The whole readout, as the operator sees it.
 *
 * Ordering is deliberate: the period boundary and what the `index` line contains
 * are stated BEFORE any figure, because both change how every figure below them is
 * read, and a footer is the part of a report that gets scrolled past.
 */
export function renderReadout(input: ReadoutInput): string {
  const out: string[] = [
    'FLEET COST READOUT',
    '',
    `  Period: ${stamp(input.periodStart)} … ${stamp(input.periodEnd)} (exclusive), UTC calendar month.`,
    '  The `index` line COUNTS CONTAINERS THAT FAILED. Every path out of index',
    '  supervision writes a usage row — indexed, failed and never-started alike — so',
    '  this is what indexing COST, not what indexing achieved.',
    "  Figures are Motir's own internal COGS. Nothing here is charged to anyone.",
    '',
  ];

  if (input.org) {
    out.push(`  PER-WORKLOAD — organization ${input.org.organizationId}`);
    if (input.org.lines.length === 0) {
      out.push('    No fleet activity for this organization in this period.');
    } else {
      out.push(...renderLines(input.org.lines));
    }
    out.push(...renderAbsence(input.org.lines, 'this organization'));
    out.push('');
  }

  out.push('  META vs TENANT — platform-wide, this period');
  if (input.metaSplit.length === 0) {
    out.push('    No fleet activity at all in this period.');
  } else {
    for (const isMeta of [true, false]) {
      const rows = input.metaSplit.filter((row) => row.isMeta === isMeta);
      if (rows.length === 0) continue;
      out.push(`    ${isMeta ? "META (Motir's own)" : 'TENANT (paying orgs)'}`);
      out.push(...renderLines(rows));
    }
    out.push(...renderAbsence(input.metaSplit, 'the platform-wide split'));
  }
  out.push('');

  return out.join('\n');
}
