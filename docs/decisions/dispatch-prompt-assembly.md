# Dispatch-prompt assembly lives on the server, in `motir-core`

**Status:** accepted · **Story 7.9 · MOTIR-1802**

## Context

Motir's execution layer hands a work item to a coding agent as a **prompt**. The
CLI (`motir next`, MOTIR-881) states the requirement plainly: it prints the
**server-generated prompt byte-identical**, with _no client-side prompt
assembly_.

The original producer for that — the 7.7.2 `generate_prompt` job, an LLM-enriched
assembly in `motir-ai` — was **cancelled with the whole of Story 7.7** on
2026-06-30 and re-homed unbuilt to Epic 9. What shipped instead was the dispatch
**data** (`ReadyItemDispatchDto`: body, context refs, blocker keys, parent key,
run command, session branch, target repo) — facts, not an instruction. Every
consumer was therefore left assembling its own prompt, which is exactly what the
CLI contract forbids.

## Decision

**Rebuild the deterministic half of prompt assembly in `motir-core`, and only the
deterministic half.**

1. **Server-side, not client-side.** The grammar lives in
   `lib/dispatch/promptTemplate.ts` and reaches clients through the
   `dispatch_prompt` MCP tool. One grammar for every harness; it versions with the
   product instead of with whichever CLI build a user happens to have.
2. **Deterministic, not generated.** Pure string assembly from server state — no
   LLM call, no `motir-ai` hop, no clock, no randomness. Two calls for an
   unchanged item return byte-identical text, which is what makes the consumer's
   "byte-identical" acceptance criterion testable at all, and what lets a
   self-hosted Motir dispatch work with no AI provider configured.
3. **In `motir-core` (GPL), not `motir-ai`.** The CLI is `packages/cli` of this
   repo and the MCP server is `lib/mcp`; a BYOK user brings their own agent and
   their own key. Dispatch must therefore work in the open-source half alone.
4. **Four sections** — `CONTEXT` / `WHAT TO DO` / `ACCEPTANCE CRITERIA` /
   `GIT WORKFLOW` — productizing the grammar `motir-meta/prompts/run.md` §
   _Prompt structure_ has been applying by hand.

### What varies, and who decides

All three axes are decided **server-side, from state**. None is a caller input —
the tool's whole input schema is `{ key }`.

| Axis           | Source                              | Effect                                                                                                                                                                                                   |
| -------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WHAT TO DO`   | the item's `type`                   | `code` ships code + tests; `design` renders shipped reality and draws the access path; `decision` ends in a decision doc; … (total over the ten types — a new type fails to compile until it is decided) |
| human vs agent | `type: manual` or `executor: human` | the human-instruction form, and **no `GIT WORKFLOW` section**: there is no branch and no PR, so instructing one would be a lie the CLI could act on                                                      |
| `GIT WORKFLOW` | the inherited `sessionBranch`       | `per_item_pr` (branch from `origin/main`, one PR, stop) vs `session_lineage` (branch from / integrate into that branch, then `mark_integrated`)                                                          |

The lineage is inherited from the item's integrated dependencies via
`getReadiness` — the single source that ignores a terminal blocker's stale branch
and collapses the one integrated lineage. An item that was itself already
integrated falls back to its own recorded branch, so re-printing its prompt keeps
it where it lives rather than sending it back to `main`. **A caller cannot select
the variant**: a client that could pick its own lineage could strand a dependency
chain across two branches.

## The extension point (and what is deliberately NOT built here)

Two cards were left waiting on the cancelled assembly point and are still blocked
under Story 9.1:

- **MOTIR-927** — inject the project's STANDARD convention (the productized
  `CLAUDE.md`).
- **MOTIR-1191** — inject the retrieved `coding`-type lessons, so a known past
  mistake is never repeated.

Both are AI-side enrichment: retrieval and generation that live in `motir-ai`.
Building them here would straddle the open-core boundary, so this card ships
**one named seam and nothing behind it**:
`DispatchPromptInjections { conventions: string[]; lessons: string[] }` — named
slots appended to `CONTEXT` in a fixed order (conventions, then lessons). Empty
is the only value `motir-core` ever supplies, and empty renders nothing at all,
so the prompt is unchanged until the injecting card ships.

## Consequences

- The CLI can be a thin printer; the prompt is a product surface Motir owns.
- Prompt-grammar changes are a `motir-core` PR with unit tests, not a model
  change — and they are reviewable as text.
- A self-hosted, AI-free Motir has a complete dispatch loop.
- The AI-enriched prompt remains a real (blocked) plan item; it becomes an
  additive fill of the injection slots, not a rewrite of this assembly.
