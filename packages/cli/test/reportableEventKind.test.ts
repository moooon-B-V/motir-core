import { describe, expect, it } from 'vitest';
import type { DispatchEventKind, ReportableEventKind } from '../src/client.js';

// The kinds this CLI may REPORT exclude the SERVER-WRITTEN findings (MOTIR-3981
// · MOTIR-6282, `run-findings-protocol.md` Q5). The assertion is TYPE-level —
// `pnpm --filter @motir/cli typecheck` fails when a `@ts-expect-error` below
// stops being an error, i.e. when one of these kinds becomes reportable.

describe('ReportableEventKind', () => {
  it('excludes every server-written finding, `unbuildable_reported` included', () => {
    // @ts-expect-error — the run-found report's conclusion is appended by the
    // report SERVICE only (MOTIR-6282); the CLI can never report it.
    const report: ReportableEventKind = 'unbuildable_reported';
    // @ts-expect-error — server-written (MOTIR-3981).
    const bug: ReportableEventKind = 'bug_filed';
    // @ts-expect-error — server-written (MOTIR-3981).
    const plan: ReportableEventKind = 'plan_submitted';

    // …while the member is still part of the READ vocabulary a reader types
    // the whole stream over.
    const read: DispatchEventKind = 'unbuildable_reported';
    const reportable: ReportableEventKind = 'card_settled';

    expect([report, bug, plan, read, reportable]).toHaveLength(5);
  });
});
