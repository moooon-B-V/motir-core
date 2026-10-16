// ONE ITERATION OF EACH AGENT SCENARIO, WITHOUT k6 (Story MOTIR-8538 · MOTIR-8675).
//
// The scenarios in ../scenarios/ wrap these with k6's transport, clock and sleep.
// Kept pure — `call(tool, args)` is injected and answers `{ outcome, structured }`
// — so the unit tests can assert the exact call sequence an iteration makes: that
// the claim releases what it took, that the write cycle uses only the declared
// transition pair, that a burst is exactly `burstSize` sequential `parentKey` moves.

import { OK } from './outcome.js';
import { pickArgs, TRANSITION_PAIR, weightedPick } from './agents.js';

/** The tools each scenario may call. `claim_next_ready` is deliberately in none. */
export const MIX = Object.freeze({
  read: Object.freeze(['get_work_item', 'search_work_items', 'skeleton', 'get_plan']),
  write: Object.freeze(['update_work_item', 'transition_status', 'add_comment', 'add_plan_items']),
  // claim_work_item on a pool key, then the release: update_work_item (no
  // assignee) and transition_status back to `todo`.
  claim: Object.freeze(['claim_work_item', 'update_work_item', 'transition_status']),
  burst: Object.freeze(['move_to_parent']),
});

/** A read agent's iteration: one weighted read tool. */
export function readIteration(call, manifest, agent, n, weights, r) {
  const tool = weightedPick(weights, r);
  return [call(tool, pickArgs(manifest, agent, tool, n))];
}

/**
 * A write agent's iteration: one weighted write tool. `transition_status` is a
 * PAIR of calls along the declared pair (`todo → in_progress → todo`), so a card
 * this agent cycles is always back at `todo` when the iteration ends.
 */
export function writeIteration(call, manifest, agent, n, weights, r) {
  const tool = weightedPick(weights, r);
  const args = pickArgs(manifest, agent, tool, n);
  if (tool !== 'transition_status') return [call(tool, args)];
  return [
    call(tool, { key: args.key, status: TRANSITION_PAIR[0] }),
    call(tool, { key: args.key, status: TRANSITION_PAIR[1] }),
  ];
}

/**
 * A claim agent's iteration: `claim_work_item` on a pool key, then — only when the
 * claim took the card — release it in the same iteration: `update_work_item` back
 * to no assignee and `transition_status` back to `todo` (`in_progress → todo` is a
 * declared edge). The claim IS the dispatch flip to `in_progress`, so the
 * iteration never transitions a card forward itself; an `empty` claim (`taken`,
 * `not_claimable`) releases nothing, because nothing was taken.
 */
export function claimIteration(call, manifest, agent, n) {
  const { key } = pickArgs(manifest, agent, 'claim_work_item', n);
  const claim = call('claim_work_item', { key });
  if (claim.outcome !== OK) return [claim];
  return [
    claim,
    call('update_work_item', { key, assigneeId: null }),
    call('transition_status', { key, status: 'todo' }),
  ];
}

/**
 * One whole burst (the 2026-10-13 shape, MOTIR-8259): `burstSize` SEQUENTIAL
 * `move_to_parent` calls with `parentKey` (never `folderId`), each moving the next
 * card of this agent's own slot to the other of its own two parents. `round` is the
 * burst's index for this VU, so successive bursts move the cards back and forth.
 */
export function burstIteration(call, manifest, agent, round) {
  const size = agent.burst.cards.length;
  const results = [];
  for (let i = 0; i < size; i++) {
    results.push(
      call('move_to_parent', pickArgs(manifest, agent, 'move_to_parent', round * size + i)),
    );
  }
  return results;
}
