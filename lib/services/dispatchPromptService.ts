import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { buildDispatchProseAdvisories } from '@/lib/services/proseGraphAdvisoryService';
import { assembleDispatchPrompt, type FindingsPolicy } from '@/lib/dispatch/promptTemplate';
import type { DispatchPromptDto, DispatchRepoDto } from '@/lib/dto/dispatch';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { listDispatchRepoNames, resolveDispatchRepoForItem } from '@/lib/workItems/dispatchRepo';
import { resolveDispatchRepo } from '@/lib/workItems/targetRepo';
import type { RepoDelivery } from '@/lib/workItems/repoDelivery';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { readProject } from '@/lib/workspaces/tenantRead';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// The DISPATCH-PROMPT read (Story 7.9 · MOTIR-1802) — resolve everything the
// canonical prompt is assembled from, then hand it to the PURE assembler
// (`lib/dispatch/promptTemplate.ts`). This module is the only half that touches
// state; the grammar itself reads nothing, which is what keeps the prompt a pure
// function of server state (two calls for an unchanged item are byte-identical).
//
// It lives in its own service file rather than on `workItemsService` for the
// same reason `lib/workItems/targetRepo.ts` does: that service is already a
// 4000-line, coverage-gated module, and prompt assembly is a self-contained
// read with no write path, no transaction, and no shared state with it.
//
// Access: the item is resolved through `workItemsService.getWorkItemByIdentifier`,
// which enforces the workspace check AND the 6.4 browse gate and raises
// `WorkItemNotFoundError` either way — so an unknown key and another tenant's key
// are indistinguishable to the caller (no existence leak), exactly as every
// sibling read behaves.

/** The blockers of a work item, resolved to their `PROD-<n>` keys in ascending
 *  key order (deterministic — the prompt lists them verbatim). */
async function resolveBlockerKeys(workItemId: string, workspaceId: string): Promise<string[]> {
  // ONE bound transaction for the edge read and the batch it resolves: unbound,
  // both returned nothing and the dispatched prompt listed no blockers at all —
  // which is worse than an empty screen, because the agent then starts work
  // whose prerequisites are unbuilt.
  const rows = await withWorkspaceServiceContext(workspaceId, async (tx) => {
    const links = await workItemLinkRepository.findByFromItem(workItemId, 'is_blocked_by', tx);
    return workItemRepository.findByIds(
      links.map((l) => l.toId),
      tx,
    );
  });
  return rows
    .slice()
    .sort((a, b) => a.key - b.key)
    .map((r) => r.identifier);
}

/**
 * EVERY repository the item ships in, as the dispatch payload's ordered element
 * list (Story MOTIR-2731 · MOTIR-3131 · ADR § *Amendment 2026-08-19* §B1).
 *
 * Composed rather than derived a second time, which is the whole point:
 *
 * - the NAMES and the per-repository DELIVERY state come from
 *   `workItemsService.listRepoDelivery`, the shared classifier the completion
 *   gate and the item-detail panel already answer from (and which resolves the
 *   set through the item's REFERENCES, so a repository renamed on the host is
 *   named correctly here — `lib/workItems/expectedRepos.ts`);
 * - the COORDINATES come from `resolveDispatchRepo` against the project's
 *   domain, the same function that produced the scalar `targetRepo` pair.
 *
 * ⚠️ It therefore THROWS `ArchivedTargetRepoError` for an archived repository
 * ANYWHERE in the set, not only for the primary. A read-only repository can
 * accept no branch and no pull request, so a card carrying one is undispatchable
 * rather than degraded — and a non-primary archived repository is the worse of
 * the two, because the run otherwise appears to succeed while the completion
 * gate holds the card forever on work that can never merge.
 *
 * The `primary` argument is the resolved scalar. When the item carries no
 * repository of its own but the project has exactly one — `resolveDispatchRepo`'s
 * second rung — the set is that one repository with a `null` delivery state, so
 * `targetRepos[0]?.name ?? null === targetRepo` stays total.
 */
async function resolveDispatchRepos(
  delivery: readonly RepoDelivery[],
  projectId: string,
  primary: { name: string; cloneUrl: string | null; defaultBranch: string | null } | null,
  ctx: ServiceContext,
): Promise<DispatchRepoDto[]> {
  if (delivery.length === 0) {
    // No set of its own. Either Motir cannot say where this ships at all (`[]`),
    // or the project's single repository answered for it — carry that one so the
    // scalar stays a projection of this array.
    return primary === null ? [] : [{ ...primary, delivery: null }];
  }
  const domain = await listDispatchRepoNames(projectId, ctx);
  return delivery.map((d) => {
    // TOTAL for a non-null pin: `resolveDispatchRepo` returns the name it was
    // given, with whatever coordinates the domain knows (`null` where it knows
    // none). Its `null` return is the UNPINNED case, which cannot arise from a
    // name — so there is no fallback arm here to write, and writing one would be
    // an untestable branch pretending the contract is weaker than it is. It is
    // also the throw site for the archived refusal above.
    const resolved = resolveDispatchRepo(d.repo, domain)!;
    return {
      name: resolved.name,
      cloneUrl: resolved.cloneUrl,
      defaultBranch: resolved.defaultBranch,
      delivery: d.state,
    };
  });
}

export interface DispatchPromptOptions {
  /**
   * A session branch to fall back to when the item carries NO lineage of its own
   * — the `motir auto` seed (MOTIR-882).
   *
   * It is a FALLBACK, never an override. An item whose dependencies are already
   * integrated somewhere, or that is itself already integrated, keeps THAT
   * branch: a caller that could redirect a live lineage would strand an
   * integrated dependency chain across two branches, which is precisely what
   * {@link DispatchPromptDto.workflowMode} being server-chosen exists to prevent.
   *
   * What it DOES enable is the first item of an unattended run. `motir auto`
   * opens one session branch per repo and integrates every item onto it; without
   * a seed the run's first item — which by definition has no integrated
   * dependency yet — would be told to open a pull request of its own, breaking
   * the one-PR-per-run contract before the run had produced anything.
   */
  sessionBranch?: string | null;
  /**
   * What this run permits its agent to WRITE (MOTIR-3020) — bug filing and
   * re-plan submission, independently.
   *
   * ⚠️ IT HAS TO ARRIVE HERE, not stay in the client. The prompt is the entire
   * contract with a sandboxed agent: a flag the agent never reads changes
   * nothing about what it does. That is why this is a request parameter rather
   * than CLI-side behaviour (`docs/decisions/run-findings-protocol.md` Q1).
   *
   * OMITTED means the COMPLETE protocol — see
   * {@link import('@/lib/dispatch/promptTemplate').FULL_FINDINGS_POLICY}. This
   * service does not default it; the template does, so every caller of the
   * template gets the same answer for an absent policy.
   */
  findingsPolicy?: FindingsPolicy;
}

export const dispatchPromptService = {
  /**
   * Assemble the canonical dispatch prompt for ONE work item.
   *
   * Reads, in parallel where they are independent: the item (access-gated), its
   * parent, its `is_blocked_by` dependencies, its READINESS (for the inherited
   * session branch — the one thing that picks the GIT WORKFLOW variant), its
   * prose-vs-graph advisories (MOTIR-2079 — told to the agent, never acted on),
   * and the project's repo domain (for `targetRepo` + its coordinates). The repo resolves
   * through the SAME `resolveItemDispatchRepo` the ready dispatch payload uses
   * (MOTIR-1804 · MOTIR-1783), so the two dispatch surfaces can never route
   * differently — including the project → workspace scope ladder.
   *
   * Any work item can be asked for a prompt — not just a ready one. Readiness is
   * the CLI's concern (it dispatches from `claim_next_ready`); this is the
   * printable prompt for whatever key you name, which is what makes
   * `motir next --print <key>` and re-printing an in-progress item work.
   */
  async getDispatchPrompt(
    projectId: string,
    identifier: string,
    ctx: ServiceContext,
    opts: DispatchPromptOptions = {},
  ): Promise<DispatchPromptDto> {
    const project = await readProject(projectId, ctx);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx);

    // MOTIR-3077 — bucket B (peer reads), left on `Promise.all` deliberately.
    // The access gate (`getWorkItemByIdentifier`) is awaited above, and none
    // of these six arms has a refusal path — `resolveDispatchRepoForItem`
    // returns `null` for an unresolvable repo instead of throwing, and
    // `listRepoDelivery` classifies rather than refuses. (The archived refusal
    // over the whole SET is raised AFTER this settles, in
    // `resolveDispatchRepos`, so no arm is ever abandoned mid-flight.)
    const [parentRow, blockerKeys, readiness, dispatchRepo, advisories, repoDelivery] =
      await Promise.all([
        item.parentId
          ? withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
              workItemRepository.findById(item.parentId as string, tx),
            )
          : Promise.resolve(null),
        resolveBlockerKeys(item.id, ctx.workspaceId),
        workItemsService.getReadiness(item.id, ctx),
        resolveDispatchRepoForItem({ id: item.id, targetRepo: item.targetRepo, projectId }, ctx),
        // The prose-vs-graph advisories (MOTIR-2079) — a SIBLING of the reads
        // above, not a second pass, and deliberately independent of `readiness`:
        // nothing below consults it when deciding the workflow variant, so the
        // prompt an item gets is the same prompt whether or not it has one.
        buildDispatchProseAdvisories(item, ctx),
        // The per-repository DELIVERY state (MOTIR-3131) — a sixth peer read with
        // no refusal path of its own, and the source `targetRepos` is built from.
        // It resolves the set through the item's REFERENCES, so it is also what
        // makes the array survive a repository rename on the host.
        workItemsService.listRepoDelivery(item.id, item.targetRepos, ctx),
      ]);

    const targetRepo = dispatchRepo?.name ?? null;
    const targetRepos = await resolveDispatchRepos(repoDelivery, projectId, dispatchRepo, ctx);
    const assembled = assembleDispatchPrompt({
      key: item.identifier,
      title: item.title,
      kind: item.kind,
      type: item.type,
      executor: item.executor,
      priority: item.priority,
      storyPoints: item.storyPoints,
      estimateMinutes: item.estimateMinutes,
      descriptionMd: item.descriptionMd,
      blockerKeys,
      advisories,
      parent: parentRow ? { key: parentRow.identifier, title: parentRow.title } : null,
      projectName: project.name,
      projectKey: project.identifier,
      targetRepo,
      // The SET the multi-repository GIT WORKFLOW is rendered from (MOTIR-3132)
      // — the same resolution the payload publishes, never a second one. Fewer
      // than two elements renders exactly today's text.
      targetRepos: targetRepos.map((repo) => ({
        name: repo.name,
        defaultBranch: repo.defaultBranch,
      })),
      // The lineage this item inherits from its integrated dependencies
      // (`getReadiness` is the single source — it ignores a terminal blocker's
      // stale branch and collapses the one integrated lineage). An item that was
      // ITSELF already integrated falls back to its OWN recorded branch, so
      // re-printing its prompt keeps it on the lineage it already lives on
      // rather than sending it back to `origin/main`. Only when BOTH are absent
      // does the caller's seed apply (see {@link DispatchPromptOptions}) — real
      // lineage always wins, so a seed can never redirect one.
      sessionBranch:
        readiness.inheritedSessionBranch ?? item.sessionBranch ?? opts.sessionBranch ?? null,
      // Passed through UNDEFAULTED. `undefined` is the template's own signal for
      // "the full protocol", so defaulting it here would put a second copy of
      // that decision in a second place.
      ...(opts.findingsPolicy ? { findingsPolicy: opts.findingsPolicy } : {}),
    });

    return {
      key: item.identifier,
      prompt: assembled.prompt,
      // The same row the prompt's `- Parent:` line is rendered from — read once,
      // used twice (MOTIR-2445). Promoting it costs no query.
      parentKey: parentRow?.identifier ?? null,
      targetRepo,
      // The same coordinates the ready dispatch payload carries (MOTIR-1783) —
      // present with a null value whenever Motir cannot say, so a CLI reading
      // either surface handles one shape.
      targetRepoCloneUrl: dispatchRepo?.cloneUrl ?? null,
      targetRepoDefaultBranch: dispatchRepo?.defaultBranch ?? null,
      // The WHOLE set, ordered with the primary first — of which the three
      // scalars above are the projection (MOTIR-3131).
      targetRepos,
      workflowMode: assembled.workflowMode,
      sessionBranch: assembled.sessionBranch,
      // Handed over SEPARATELY as well as rendered into the prompt: the prompt
      // reaches the agent, this reaches the human watching the CLI. Always an
      // array, never omitted.
      advisories,
    };
  },
};
