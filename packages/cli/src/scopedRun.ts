import { formatTable, truncate } from './render.js';
import type { DispatchItem, ScopeClaim } from './client.js';

// The PURE half of the SCOPED run (Story MOTIR-3001 · MOTIR-3198): what a scope
// argument MEANS, what each typed claim outcome says to a person, and what the
// run exits with — with no request, no spawn, no git and no stdout. The I/O half
// lives in `commands/scope.ts`.
//
// The split is the one `autoLoop.ts` and `batchPlan.ts` already keep from their
// command files, and it is worth the file here for the same reason: the
// interesting behaviour of this card is a six-way branch over a typed result,
// and a six-way branch tested through a scripted HTTP client is a six-way branch
// tested badly.
//
// ── The surface this file implements is DECIDED, not invented ───────────────
// `docs/decisions/scoped-run-command-surface.md` settles the verb, the
// positional, the reserved word, the flag dispositions and the refusal copy.
// Where this file quotes a message, that ADR is where the wording comes from and
// where it should be changed.

/** The reserved positional that names the project's ACTIVE sprint. */
export const SCOPE_SPRINT = 'sprint';

/** What `motir run <scope>` was pointed at. */
export type ScopeTarget =
  /** The literal word `sprint` — the project's ACTIVE sprint. */
  | { kind: 'sprint' }
  /** A `MOTIR-<n>` work-item key, still unresolved: whether it is a leaf, a
   *  container or an epic is a question only the server can answer. */
  | { kind: 'work_item'; key: string };

/**
 * Read the positional.
 *
 * ⚠️ THE DISAMBIGUATION IS A LITERAL EQUALITY CHECK, NOT A HEURISTIC. A work
 * item key is `<PROJECT>-<digits>` — it always carries a hyphen and ends in
 * digits — and `sprint` carries neither, so there is no overlap to resolve. Even
 * a project whose key were literally `SPRINT` addresses its cards as `SPRINT-7`,
 * which is not equal to `sprint`. Anything that is not the reserved word is
 * passed through as a key and refused downstream if it names nothing; guessing
 * here would put a second opinion about identifiers in a file that has no
 * business having one.
 */
export function parseScopeArgument(raw: string): ScopeTarget {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase() === SCOPE_SPRINT) return { kind: 'sprint' };
  return { kind: 'work_item', key: trimmed.toUpperCase() };
}

/**
 * Whether a target the server has now described is a SCOPE or a single card.
 *
 * ⚠️ THE SHAPE DECIDES, NOT THE KIND — with one deliberate exception. The
 * kind-parent matrix (`lib/issues/parentRules.ts`) permits `story → task →
 * subtask` and `task → bug`, so a `task` and a `bug` can each be a container. A
 * rule keyed on kind would run a container `bug` as one card and a childless
 * `task` as a scope; both are wrong, and "one commit per child" is a total
 * description of a container's work exactly when no child is itself a container
 * — which is a statement about shape.
 *
 * The exception is an `epic`, refused by KIND before any shape analysis. An epic
 * groups STORIES, so running one means a multi-story pull request nobody can
 * review — which contradicts Principle #18 in the same breath as invoking it.
 */
export type ScopeShape =
  /** No children, and not a planning container: today's single-card dispatch. */
  | { kind: 'leaf' }
  /** Children, none of which is itself a container: run its leaves. */
  | { kind: 'scope' }
  /** An epic — never a run target. */
  | { kind: 'refuse_epic' }
  /** A childless `story` / `epic`: a planning item with no work under it. */
  | { kind: 'refuse_unexpanded' };

const CONTAINER_KINDS = new Set(['epic', 'story']);

export function classifyScopeTarget(item: { kind: string; childCount: number }): ScopeShape {
  const kind = item.kind.toLowerCase();
  if (kind === 'epic') return { kind: 'refuse_epic' };
  if (item.childCount > 0) return { kind: 'scope' };
  if (CONTAINER_KINDS.has(kind)) return { kind: 'refuse_unexpanded' };
  return { kind: 'leaf' };
}

/**
 * The refusal for an `epic`, quoted from the ADR so the copy has one home.
 *
 * Returned as `{ message, hint }` rather than as a string because that is the
 * shape `CliError` takes, and the hint is the half that tells a person what to
 * do instead — the difference between a refusal and a wall.
 */
export function epicRefusal(key: string): { message: string; hint: string } {
  return {
    message: `${key} is an epic — an epic is never a run target.`,
    hint: `An epic groups stories; run one of its stories instead. \`motir show ${key}\` lists them.`,
  };
}

/** The refusal for a childless container — a planning item, not work. */
export function unexpandedRefusal(key: string): { message: string; hint: string } {
  return {
    message: `${key} has no children to run — it is a planning item, not work.`,
    hint: `Expand it first (\`motir plan ${key}\`), or pass --include-planning to trigger the expansion now.`,
  };
}

// ── the typed claim outcomes ────────────────────────────────────────────────
//
// ⚠️ EVERY REFUSAL BELOW IS A RESULT, NOT AN ERROR, and each has a DIFFERENT
// thing for the reader to do. Rendering them as one "claim failed" line throws
// away precisely the information the endpoint was built to carry — which is why
// the server answers 200 with an `outcome` instead of a status code in the first
// place (`app/api/v1/scope-claims/route.ts`).

/** What the run does after a claim attempt. */
export type ScopeDisposition =
  /** The run owns the scope — proceed. `mine` lands here too: it is a RESUME. */
  | 'proceed'
  /** Stop, and submit a re-plan of the container unless told not to. */
  | 'replan'
  /** Stop. Nothing to submit; the answer is elsewhere in the tree. */
  | 'stop';

export function dispositionOf(outcome: ScopeClaim['outcome']): ScopeDisposition {
  if (outcome === 'claimed' || outcome === 'mine') return 'proceed';
  if (outcome === 'wrong_shape') return 'replan';
  return 'stop';
}

/**
 * What a person is told about a claim that did not proceed.
 *
 * Each branch names what the SERVER named — the offending card and its holder,
 * the container child and its depth, the blocking pairs — rather than
 * paraphrasing them into a generic sentence. A second run against a story the
 * first one holds is then refused BY NAME rather than by silence, which is the
 * whole reason `offender` carries a `transitionedBy`: it names a holder even
 * when a sibling flipped the status without assigning (the MOTIR-2958 shape).
 */
export function renderScopeRefusal(claim: ScopeClaim): string {
  const scope = scopeLabel(claim);
  switch (claim.outcome) {
    case 'taken': {
      const o = claim.offender;
      const holder = o?.assignee?.name ?? o?.transitionedBy?.name ?? null;
      return [
        `${scope}: NOT claimed — a card in it is already held${holder ? ` by ${holder}` : ' by another run'}.`,
        `  ${o?.key ?? 'a member'} — ${o?.title ?? ''} (at ${o?.status.key ?? 'an unknown status'})`,
        'Nothing was locked. Two runs on one story is the failure this refusal exists to',
        'prevent; wait for the other run, or take the card over by hand if you know it is dead.',
      ].join('\n');
    }
    case 'mine':
      // Not reachable through `renderScopeRefusal` in the command — `mine` is a
      // RESUME and dispositions to `proceed`. It is answered here anyway so the
      // function is total over the vocabulary rather than over today's callers.
      return `${scope}: already yours — resuming.`;
    case 'not_claimable': {
      const o = claim.offender;
      return [
        `${scope}: NOT claimed — a card in it is past the point a run may start it.`,
        `  ${o?.key ?? 'a member'} — ${o?.title ?? ''} (at ${o?.status.key ?? 'an unknown status'})`,
        'A run claims from the TO-DO category only, so a card that is implemented, under',
        'review, being re-planned or finished is not work an agent may be started on.',
        'Nothing was locked.',
      ].join('\n');
    }
    case 'wrong_shape': {
      const s = claim.shape;
      return [
        `${scope}: NOT claimed — its shape is not runnable.`,
        `  ${s?.child ?? 'a child'} — ${s?.childTitle ?? ''} is itself a container;` +
          ` the work under it sits ${s?.depth ?? 2} levels from the story.`,
        'A scoped run lands one commit per child, which is only a true description of the',
        'story when no child is a container of its own. Nothing was locked.',
      ].join('\n');
    }
    case 'not_finishable': {
      const lines = claim.blockers.map(
        (b) =>
          `  ${b.item} is blocked by ${b.blockedBy} (${b.blockerStatus}), which is OUTSIDE the scope`,
      );
      return [
        `${scope}: NOT claimed — it cannot be finished from inside itself.`,
        ...(lines.length > 0 ? lines : ['  (the validator named no specific pair)']),
        'A run that took this scope could not finish it, so it did not take it. Finish the',
        'work above, or pull it into the scope. Nothing was locked.',
      ].join('\n');
    }
    default:
      return `${scope}: claimed.`;
  }
}

/** `MOTIR-42 "Run a whole story"` / `the active sprint "Sprint 44"`. */
function scopeLabel(claim: ScopeClaim): string {
  return claim.scope.kind === 'sprint'
    ? `The active sprint "${claim.scope.name}"`
    : `${claim.scope.key ?? 'The scope'} "${claim.scope.name}"`;
}

const CLAIMED_HEADERS = ['ITEM', 'STATUS', 'TITLE'];

/**
 * The claimed scope, printed as the plan of the run — the moment a person can
 * still press Ctrl-C.
 *
 * ⚠️ THE ORDER IS THE READY RANK, and the container is not in it. `members`
 * carries every row the claim locked, INCLUDING the container itself and
 * including leaves that are not ready yet (their blockers are elsewhere in the
 * same scope, which is exactly why the claim took them). What the run WORKS is
 * the ready set, in the server's dispatch rank; everything else claimed is
 * listed after it as work this run also owns but cannot start yet.
 *
 * Both halves are shown on purpose. Printing only the ready set would hide the
 * In-Progress-from-t=0 cost — the cards that now read as in progress on the
 * board while nothing is happening to them — which is the one consequence of
 * this design a person has to be told about rather than discover.
 */
export function renderClaimedScope(
  claim: ScopeClaim,
  ready: readonly DispatchItem[],
  titleWidth = 44,
): string {
  const blocks: string[] = [];
  const readyKeys = new Set(ready.map((r) => r.key.toUpperCase()));
  const containerKey = claim.scope.key?.toUpperCase() ?? null;
  const held = claim.members.filter((m) => m.key.toUpperCase() !== containerKey);

  blocks.push(
    `Claimed ${scopeLabel(claim)} — ${held.length} card${held.length === 1 ? '' : 's'}, ` +
      'all of them, or none.',
  );

  if (ready.length === 0) {
    blocks.push('Nothing in it is ready to start.');
  } else {
    blocks.push(
      formatTable(
        CLAIMED_HEADERS,
        // No `?? ''`: `DispatchItem.title` is a non-nullable `string`, so a
        // coalesce here would be an unreachable arm — dead code that exists only
        // to be covered, which is worse than the absent defence it imitates.
        ready.map((r) => [r.key, r.status.key, truncate(r.title, titleWidth)]),
      ),
    );
  }

  const waiting = held.filter((m) => !readyKeys.has(m.key.toUpperCase()));
  if (waiting.length > 0) {
    blocks.push(
      [
        `Also claimed, not startable yet (${waiting.length}) — their blockers are inside this scope:`,
        ...waiting.map((m) => `  ${m.key} — ${truncate(m.title, titleWidth)}`),
      ].join('\n'),
    );
  }

  blocks.push(
    [
      '⚠️ Every card above now reads In Progress, while only one is worked at a time.',
      '   That is the claim, not a bug: "In Progress" here means THIS RUN OWNS IT.',
    ].join('\n'),
  );
  return blocks.join('\n\n');
}

// ── ORDERING the claimed set ────────────────────────────────────────────────
//
// ⚠️ THE ORDER CANNOT COME FROM THE READY SET, and that is the whole reason
// this section exists rather than a `.sort()` at the call site.
//
// A scope claim takes every member in the TO-DO CATEGORY, and `blocked` is in
// that category — so the claimed set includes cards that were not ready when it
// was claimed. Meanwhile a READY row's `blockedBy` is empty by construction
// (`lib/api/v1/ready/schema.ts` says so in its header: it is empty *because*
// the row is ready). So the ready set can say WHICH cards can start now, and it
// can never say what to do second.
//
// The order therefore comes from the intra-scope dependency EDGES, computed
// ONCE from data the run already holds, and the ready set is never consulted
// again. That last clause is the invariant: a mid-flight ready query would
// silently reintroduce exactly the interleaving the up-front claim exists to
// prevent.

/** `key → the keys it is blocked by`, for the members of one scope. */
export type ScopeEdges = Record<string, string[]>;

/**
 * The claimed leaves in dependency order — a stable topological sort.
 *
 * ⚠️ STABLE, and ties break by INPUT ORDER, which is the server's dispatch
 * rank. Two cards with no edge between them are genuinely unordered by the
 * graph, and the rank is the answer the rest of the product already gives to
 * "which of these first". Sorting by anything else here would be a second
 * opinion about dispatch priority living in a client.
 *
 * ⚠️ AND IT IS TOTAL. A cycle, or an edge naming a card outside this scope,
 * cannot remove a card from the result: whatever is still unplaced when no
 * candidate's blockers are all placed is appended in input order. A run that
 * silently dropped a card it had CLAIMED would leave it In Progress forever
 * with nobody working it — strictly worse than working it in a debatable order.
 * The caller still refuses to dispatch a card whose blockers are unsatisfied,
 * so a genuine cycle is reported rather than built.
 */
export function orderClaimedSet(keys: readonly string[], edges: ScopeEdges): string[] {
  const inScope = new Set(keys);
  const placed = new Set<string>();
  const out: string[] = [];
  let remaining = [...keys];

  while (remaining.length > 0) {
    const ready = remaining.filter((key) =>
      (edges[key] ?? []).every((dep) => !inScope.has(dep) || placed.has(dep)),
    );
    // Nothing can be placed: a cycle, or edges we cannot satisfy. Append the
    // rest in input order rather than losing them.
    const batch = ready.length > 0 ? ready : remaining;
    for (const key of batch) {
      out.push(key);
      placed.add(key);
    }
    const done = new Set(batch);
    remaining = remaining.filter((key) => !done.has(key));
  }
  return out;
}

/**
 * The IN-SCOPE blockers of `key` that are not yet satisfied.
 *
 * ⚠️ IN-SCOPE ONLY. An out-of-scope blocker was already settled by the claim:
 * `not_finishable` is precisely the verdict "work outside this scope gates work
 * inside it", and a scope that got past it has none. Re-checking them here would
 * mean either a second read or a guess, and both would second-guess a validator
 * that already ran inside the claiming transaction.
 *
 * A non-empty answer is a card to SKIP and NAME — never to force. The run owns
 * the card, which is not the same as being allowed to build it out of order.
 */
export function unsatisfiedBlockers(
  key: string,
  edges: ScopeEdges,
  satisfied: ReadonlySet<string>,
  inScope: ReadonlySet<string>,
): string[] {
  return (edges[key] ?? []).filter((dep) => inScope.has(dep) && !satisfied.has(dep));
}

// ── the CLOSE-OUT gate: the container's CURRENT children (Bug MOTIR-3268) ───
//
// ⚠️ THE CLAIM IS TAKEN AT t=0 AND THE PULL REQUEST IS OPENED AT t=END, and
// between those two moments the container's child set can GROW. `motir run`
// may file a bug (MOTIR-3017) and it parents it under the in-flight card's
// parent — which, on a scoped run, is the container this run is about to open a
// pull request for. Neither feature is wrong alone: MOTIR-3001 claims the scope
// up front on purpose, and MOTIR-3017 inserts children on purpose. What was
// missing is the one read that reconciles them.
//
// ⚠️ AND THE SERVER'S GATE IS NOT THAT READ. MOTIR-3229 made the container's
// move into `implemented` / `in_review` REFUSABLE (`CONTAINER_HAS_OPEN_CHILDREN`,
// 422), so the false claim can no longer be made — but the run opens the pull
// request BEFORE anything transitions, so the refusal lands on a pull request
// that already exists. The point of MOTIR-3229's fourth clause is that the
// parent's pull request should not EXIST while the story is not implemented, and
// only a check on this side of the `gh pr create` can deliver that.

/**
 * The status KEYS at which a child has cleared the container-completeness bar —
 * `implemented`-or-better (`lib/workItems/statusLadder.ts`).
 *
 * ⚠️ RESTATED HERE, NOT IMPORTED, and by KEY rather than by category. The CLI is
 * a standalone package that cannot reach into the Next app — the same reason
 * `classifyReadyItem` restates the server's `isManualReadyItem` — and the child
 * rows `/api/v1` publishes carry a status KEY with no category beside it, so
 * ranking by category is not available to this side at all.
 *
 * ⚠️ SO THE TWO CAN DISAGREE, IN EXACTLY ONE DIRECTION, and that is the safe one.
 * The server ranks a `done`-CATEGORY status as cleared, so a project that added
 * its own done-category status clears the bar there and not here: this side holds
 * a pull request the server would have allowed. A hold is a stop the operator can
 * act on in one command; the opposite error is the defect this card exists to
 * remove. Nothing here can permit what the server refuses.
 */
export const CHILD_CLAIM_BAR_KEYS: ReadonlySet<string> = new Set([
  'implemented',
  'in_review',
  'done',
  'cancelled',
]);

/**
 * The container's children that have NOT reached the bar, by key.
 *
 * Keys rather than rows because that is what the report needs: a stop that names
 * WHICH cards are open is one the reader can act on in one hop, and this fires at
 * the moment somebody believes the run is finished.
 */
export function childrenBelowClaimBar(
  children: readonly { identifier: string; status: string }[],
): string[] {
  return children
    .filter((child) => !CHILD_CLAIM_BAR_KEYS.has(child.status.toLowerCase()))
    .map((child) => child.identifier);
}

/**
 * The one-line reason a held pull request carries into the summary's PR block.
 *
 * ⚠️ IT MIRRORS THE SERVER'S OWN SENTENCE (`ContainerHasOpenChildrenError`) on
 * purpose. The two surfaces answer the same question — which children are open —
 * and a run that paraphrased would leave an operator comparing two descriptions
 * of one fact and wondering which is current.
 */
export function openChildrenHoldReason(
  containerKey: string,
  openChildren: readonly string[],
): string {
  const named = openChildren.slice(0, 5).join(', ');
  const rest = openChildren.length > 5 ? ` (+${openChildren.length - 5} more)` : '';
  return (
    `${containerKey} cannot claim to be implemented while ${openChildren.length} of its ` +
    `children ${openChildren.length === 1 ? 'has' : 'have'} not been: ${named}${rest}.`
  );
}

/**
 * What a person is told when the close-out re-read found the set had grown.
 *
 * ⚠️ THREE DISPOSITIONS, AND THE RUN PICKS NONE OF THEM. Each is a decision about
 * SCOPE — is this card part of the story or not — which is the one question an
 * unattended run has no standing to answer. Naming all three is what makes this a
 * stop the operator chose rather than a failure they have to diagnose.
 */
export function renderOpenChildrenHold(
  containerKey: string,
  openChildren: readonly string[],
): string {
  return [
    `${containerKey}: NO pull request was opened — its child set grew while this run was working.`,
    ...openChildren.map((key) => `  ${key} — not implemented`),
    'A parent pull request is opened on the claim that everything under it is built, and these',
    'cards were not in the set this run claimed. Nothing was reverted and nothing was lost: the',
    'work IS pushed, and the branch is named below.',
    'Three ways forward — this run may not pick one for you:',
    `  • LAND them — \`motir run ${openChildren[0] ?? '<key>'}\` — then re-run ${containerKey} to open the pull request.`,
    `  • RE-PARENT them out of ${containerKey} if they are no longer in its scope.`,
    `  • Take it by hand — open the pull request yourself, or move ${containerKey} to Done, which`,
    '    completes its children deliberately rather than as a side effect.',
  ].join('\n');
}

/**
 * What a scope with nothing to do is told.
 *
 * ⚠️ DISTINGUISHABLE FROM A REFUSAL, and exit 0. A story nobody has decomposed
 * yet, or one whose every leaf is already in flight, is a PLAN STATE — nothing
 * went wrong, and a stack trace here would teach an operator that an ordinary
 * tree is an error.
 */
export function renderEmptyScope(label: string): string {
  return [
    `${label}: nothing is ready to start.`,
    'Every card under it is either already in flight, finished, or waiting on work',
    'outside it. Nothing was claimed and nothing was changed.',
  ].join('\n');
}
