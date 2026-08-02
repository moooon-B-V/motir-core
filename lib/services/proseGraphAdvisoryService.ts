import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workflowsService } from '@/lib/services/workflowsService';
import { bodyReferenceSeverities } from '@/lib/workItems/proseVsGraph';
import type { WorkItemProseAdvisoryDto } from '@/lib/dto/workItems';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// The PROSE-vs-GRAPH advisory (MOTIR-1969) — the service half of the check whose
// pure string work lives in `lib/workItems/proseVsGraph.ts`.
//
// The rule. For a card, let **N** = the work items its `descriptionMd` NAMES via
// `motir:` link tokens and **E** = the work items it carries a `blocked_by` edge
// to. Emit one advisory per member of `N \ E` that is not `done` (and not the
// card itself, and not one of its ancestors).
//
// ⚠️ This is an ADDITION beside the existing finishability rules, NOT an
// extension of them. `gatingItemSatisfied` (lib/workItems/validity.ts) is a pure
// EDGE-AND-STATUS walk that never reads a description; this compares the NAMED
// set against the EDGE set. The next reader will otherwise try to route it
// through `gatingItemSatisfied` — it shares no input with it.
//
// ⚠️ ADVISORY, NEVER A BLOCKER. Advisories ride a SEPARATE channel in the
// verdict: `valid` / `blockers` (and the issue-detail `ready` / `openBlockers`)
// are byte-identical whether or not advisories are emitted, at BOTH severities.
// See `WorkItemProseAdvisoryDto` for why a gate here would be actively harmful.
//
// ⚠️ KNOWN BLIND SPOT — a `type: decision` card's deferrals are invisible to
// this check (`notes.html` #202). Its only input is `descriptionMd`, and a
// decision card's deliverable is a DOCUMENT in a repository; the deferrals it
// writes live there, outside the graph and outside every plan-side validator, so
// N is empty for exactly the reference that mattered (MOTIR-1980's §11 deferral
// against MOTIR-1918, whose own body never named it). That gap is covered by a
// planner RULE (MOTIR-1975 W3), NOT by this code — parsing ADRs from the plan
// side needs repo access and is a much larger surface. Documentation only; no
// behaviour follows from it.

/** One card whose body is scanned, plus the references that must NOT warn. */
export interface ProseAdvisorySubject {
  /** The scanned card's identifier — the advisory's `item`. */
  item: string;
  /** Its body. `null` / empty simply yields no references. */
  descriptionMd: string | null;
  /**
   * References that are legitimately edge-free: the card ITSELF, its ANCESTORS,
   * and everything already in its `blocked_by` set. Keyed the same way
   * {@link bodyReferenceSeverities} keys a reference — a real work-item id, or a
   * `planItem:<id>` temp-ref on the projected path.
   */
  exemptIds: ReadonlySet<string>;
}

/**
 * A reference the CALLER can already resolve without a DB read — the projected
 * path passes its whole in-project node set (real nodes AND not-yet-materialized
 * `planItem:<id>` adds), so a projected body can name a projected sibling.
 */
export interface ProseAdvisoryLocalRef {
  identifier: string;
  /** Raw workflow status key. */
  status: string;
  /** Terminal (`category = 'done'`) in the reference's OWN project. */
  done: boolean;
}

/**
 * Build the prose-vs-graph advisories for a set of scanned cards.
 *
 * Resolution, in order: a reference the caller supplied in `localRefs` is taken
 * from there; every other reference is resolved in ONE batched workspace read
 * and judged against ITS OWN project's terminal set (a reference can be
 * cross-project — finding #21).
 *
 * Dropped, never reported:
 *  - an exempt reference (self / ancestor / already `blocked_by`);
 *  - a `done` reference — the prose is satisfied, nothing to warn about;
 *  - a reference that resolves to NOTHING (a malformed or unknown id, a deleted
 *    or cross-workspace target) — body text, never an error;
 *  - a reference in a project the caller cannot BROWSE. It is omitted entirely
 *    rather than reported as an opaque row: naming it would leak the existence
 *    of an item the caller may not see. This reuses the exact
 *    `projectAccessService.filterBrowsable` gate the ref-chip resolver and
 *    auto-relate ride — not a new permission check.
 *
 * Returns a deterministically ordered list (by scanned card, then reference) so
 * the wire shape is stable.
 */
export async function buildProseVsGraphAdvisories(
  subjects: ProseAdvisorySubject[],
  ctx: ServiceContext,
  localRefs?: ReadonlyMap<string, ProseAdvisoryLocalRef>,
): Promise<WorkItemProseAdvisoryDto[]> {
  // Scan every body once, dropping the exempt references as we go.
  const scanned = subjects.map((s) => {
    const refs = new Map(bodyReferenceSeverities(s.descriptionMd));
    for (const id of s.exemptIds) refs.delete(id);
    return { item: s.item, refs };
  });

  const unresolved = new Set<string>();
  for (const s of scanned) {
    for (const id of s.refs.keys()) {
      if (!localRefs?.has(id)) unresolved.add(id);
    }
  }

  // ONE batched read for everything the caller could not resolve locally, then
  // the browse gate, then per-project done-ness.
  const resolved = new Map<string, ProseAdvisoryLocalRef>();
  if (unresolved.size > 0) {
    const rows = await workItemRepository.findByIdsInWorkspace([...unresolved], ctx.workspaceId);
    if (rows.length > 0) {
      const projects = await projectRepository.findByWorkspace(ctx.workspaceId);
      const browsable = await projectAccessService.filterBrowsable(projects, ctx);
      const browsableProjectIds = new Set(browsable.map((p) => p.id));
      const visible = rows.filter((r) => browsableProjectIds.has(r.projectId));
      const terminalByProject = await workflowsService.getTerminalStatusKeysByProjects(
        visible.map((r) => r.projectId),
        ctx.workspaceId,
      );
      for (const row of visible) {
        resolved.set(row.id, {
          identifier: row.identifier,
          status: row.status,
          done: terminalByProject.get(row.projectId)?.has(row.status) ?? false,
        });
      }
    }
  }

  const advisories: WorkItemProseAdvisoryDto[] = [];
  for (const s of scanned) {
    for (const [id, severity] of s.refs) {
      const ref = localRefs?.get(id) ?? resolved.get(id);
      if (!ref || ref.done) continue;
      advisories.push({
        item: s.item,
        referenced: ref.identifier,
        referencedStatus: ref.status,
        severity,
      });
    }
  }
  advisories.sort(
    (a, b) => a.item.localeCompare(b.item) || a.referenced.localeCompare(b.referenced),
  );
  return advisories;
}
