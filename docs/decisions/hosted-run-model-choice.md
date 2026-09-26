# ADR: The dispatcher picks a hosted run's model, and credit rates follow the model catalog

- **Status:** Proposed (2026-09-26), for acceptance at MOTIR-6482's `decision_approval` gate
- **Card:** MOTIR-6482 · **Epic:** MOTIR-673 ("Hosted agent")
- **Kind:** a planner-recorded decision. The direction was settled with the person at MOTIR-685's `decision_approval` review on 2026-09-26. This document writes it down; it does not re-open it.
- **Consumed by:**
  - MOTIR-683 (Story 9.1, "A card runs on the hosted agent"), whose body gains the model choice
  - MOTIR-6481 (the AI-economics story "Credit rates follow the model catalog", under MOTIR-4329)
- **Supersedes:**
  - MOTIR-685: its first §7 (one model per deployment) and its criterion 5's four configuration names
  - MOTIR-683: its body, which gains the model choice
  - MOTIR-684, MOTIR-689, MOTIR-690, MOTIR-691, MOTIR-692, MOTIR-6451 and MOTIR-6452: each re-scoped for the picker, the validation and the minted allow-list
  - MOTIR-6453, which drops `MOTIR_HOSTED_AGENT_MODEL`
  - No earlier planner-recorded decision exists on MOTIR-673. The two other decisions under it, MOTIR-695 (Story 9.2) and MOTIR-706 (Story 9.3), are researched decisions and are not touched.
- **Technical contract:** [`hosted-agent-run.md`](hosted-agent-run.md) §7 (MOTIR-685). This document gives the direction and what it replaced. §7 gives the mechanism, and nothing here restates it.

> Structured **Status → Context → Decision → Consequences**, then _What this does NOT decide_, in the shape the other records here use. A bare **§** below always means a section of `hosted-agent-run.md`.

---

## Context

### What the approved plan held

When Story 9.1's plan was approved, a hosted run had **one model per deployment**:

- MOTIR-685's first §7 fixed the model by configuration, `MOTIR_HOSTED_AGENT_MODEL`.
- The approved 9.1 cards minted the run's gateway key with "9.1.2's model", and no card drew a picker.
- MOTIR-684 (the design) said in its criterion 5 that there is no model selector.
- MOTIR-6453 (production configuration) set `MOTIR_HOSTED_AGENT_MODEL` in production.

motir-ai's credit rates were **hand-written migrations**. The gateway's daily catalog refresh (MOTIR-6122) updates the gateway's catalog and nothing in motir-ai. So a model can be served before anyone has priced it. On 2026-09-26, `claude-opus-5-5`, `claude-opus-5` and `claude-sonnet-5` are served by the gateway and cannot be billed.

### What the person asked for

At MOTIR-685's `decision_approval` review on 2026-09-26, the person asked for two things the approved plan did not hold:

1. **Whoever dispatches a hosted run chooses its model**, from the models that can actually run it.
2. **motir-ai's credit rates follow the gateway's daily model catalog**, rather than waiting for somebody to write a migration.

This is a change of requirement, not a technical detail. It moves cards that were already approved: the design, the start path, the gateway wiring, the UI, both test gates, the end-to-end test and a production configuration step.

### Why the two go together

The first request depends on the second. A model is only worth offering if a run on it can be billed, because motir-ai refuses to debit a turn on a model with no `agent`-lane rate (§7 gives the mechanism). With hand-written rates, the offered list trails the catalog by however long it takes somebody to notice. When rates follow the catalog, a newly served model becomes offerable once its generated rates are merged.

---

## Decision

### 1 · The dispatcher chooses the model at Run hosted

The person who presses **Run hosted** chooses the model the run uses. They choose from a list of the models that can run it, with a default already selected. A model is on the list when all three hold:

- the gateway serves it;
- its provider is one the hosted egress contract configures (Anthropic today) and has a recorded transfer basis;
- motir-ai has an effective `agent`-lane rate for it.

What each condition means, where it is read from, and why each is needed is **§7's _The offered set_**. The rule that the list, the run, the card and the key's allow-list all carry the gateway's **bare** model id is **§7's _One id, two spellings, never mixed_**. Both are cited here rather than re-derived.

**motir-ai serves the list and its default. motir-core keeps no copy.** motir-core reads the list to draw the picker, and the start path reads it again on the server and refuses a model that is no longer on it. The default is a motir-ai constant that starts as `claude-opus-5-5`.

### 2 · Credit rates follow the gateway's model catalog

When the gateway's daily catalog adopts a model or moves a price, **motir-ai opens a reviewable pull request** that:

- adds the rate generations for that model in **both lanes**, planning and agent;
- updates the **servable set**, the models the gateway serves with each one's provider.

A person merges it, as they merge the gateway's own catalog refresh. The goal is that **a served model is never unbillable**. This is a new story under AI economics, MOTIR-6481.

### What was set aside

- **One model per deployment, set by configuration.** This is what the approved plan held. It hides from the dispatcher a choice that decides both what the run costs and how capable it is. The person asked for that choice to be theirs. §7's _Rejected_ list keeps the technical reasons, and the reference products it checked.
- **Rates written by hand, as today.** A catalog that refreshes daily with nobody pricing what it adopts leaves served models unbillable. That already happened with three models on 2026-09-26.

---

## What changed

**Change:** more requirement.

|                                | Before (the approved plan)                                                    | Now                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Who picks the model**        | Nobody at run time. One model per deployment, from `MOTIR_HOSTED_AGENT_MODEL` | The dispatcher, at **Run hosted**                                                                                |
| **What they pick from**        | Nothing; there was no picker (MOTIR-684 criterion 5)                          | The offered set: servable, from a configured provider with a transfer basis, and rated in the agent lane         |
| **Where the list lives**       | Nowhere; the model was a configuration value                                  | motir-ai, which serves the list and its default                                                                  |
| **What the start path checks** | Nothing about the model; it came from configuration                           | That the chosen model is still offered, before the run is opened; the choice is recorded on the run and the card |
| **How rates are written**      | Hand-written motir-ai migrations                                              | Generated from the gateway's catalog as a pull request a person merges, in both lanes                            |
| **Production configuration**   | `MOTIR_HOSTED_AGENT_MODEL` set by MOTIR-6453                                  | No model variable (`hosted-agent-run.md` §6)                                                                     |

---

## Resulting direction

This is the whole direction of MOTIR-673 after this decision, so a reader does not have to combine it with earlier ones.

Motir runs **OpenCode** and nothing else, on **one card**, in a **fresh metered container** on Motir's own fleet. The run uses a per-run Motir gateway key that bills the dispatcher's organization at the agent lane. It is authenticated to git and to Motir **as the dispatcher**, and it ends in a **pull request** authored as them.

- **The lane is per card**, and any card can still run locally.
- **The model** is the dispatcher's choice at Run hosted, from the list motir-ai serves:
  - the list holds the models that are servable, from a configured provider with a transfer basis (Anthropic today), and rated in the agent lane;
  - the default is a motir-ai constant, `claude-opus-5-5`;
  - there is no per-organization or per-project list, and no provider beyond the egress contract's.
- **Rates follow the catalog** through a generated motir-ai pull request, in both lanes, that a person merges.
- **The run** is one `DispatchRun` on the shared statuses and events. Its three credentials all expire with the run. Its cost (tokens, credits and machine time) is shown on the run.
- **Out of scope for this epic's first story:** several runs at once, a queue, and choosing among agents.

The technical contract is `hosted-agent-run.md` §1–§7.

---

## Consequences

- **The dispatcher decides what a run costs.** A dearer model is one click away. The default and the cost block on the run (tokens, credits and machine time) are what keep that visible; there is no per-organization list to narrow the choice in 9.1.
- **Starting a hosted run now needs motir-ai.** motir-ai serves the list, so when it cannot be reached no model can be validated and Run hosted cannot start. §7's state table says what the person sees.
- **A newly served model is not offered until its rates are merged.** That delay is chosen: an unmerged rate PR keeps the model off the list, and a run can never start on a model it cannot bill. Until MOTIR-6481 ships, the offered set is the Anthropic models already rated (§7 names them).
- **Every re-scoped card carries this direction.** The superseded cards in the header were re-scoped in the same re-plan that laid this card: MOTIR-684 designs the picker, MOTIR-690 validates the choice at start, MOTIR-689 mints the key with the chosen model as its allow-list, MOTIR-691 builds the picker, MOTIR-692 and MOTIR-6451 test the list and the validation, MOTIR-6452 records it end to end, and MOTIR-6453 no longer sets a model variable.
- **The planning model picker still has its own copy in motir-core.** §7 describes that list as the counter-example this direction avoids. This document names it and does not fix it.

---

## What this does NOT decide

- **The mechanism.** The offered-set conditions, the list endpoint, the default's fallback, the bare-id rule, the start-path refusal and what each state shows are `hosted-agent-run.md` §7. This document does not restate or amend them.
- **How rates are derived from catalog prices.** That derivation already exists in `credit-model.md` §2a and `prompt-cache-pricing.md` §2, and MOTIR-6481 decides how the generator applies it.
- **What the picker looks like.** That is MOTIR-684's design.
- **Which model is the default in the long run.** It starts as `claude-opus-5-5`. The dogfood story (MOTIR-714) measures real runs, and the default is revisited if they disagree.
- **A model list per organization or project, or a provider other than Anthropic.** There is one list, the same for everyone.
- **Several hosted runs at once, a queue, or choosing among agents.** None of these is in Story 9.1.
- **The planning model picker's own list.** It is named in Consequences, not changed.
