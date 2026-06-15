# The Core ↔ AI boundary

This file is a **pointer**. The authoritative spec of the network boundary between `motir-core`
(this repo — GPL-3.0, open, user-facing) and `motir-ai` (proprietary, headless, server-to-server)
lives on the **closed side**, where it is owned and versioned:

> **`motir-ai/docs/contract.md`** — the `v1` Core ↔ AI API contract: the async job model, the
> request/response envelope, the two auth grants, and the shared error taxonomy.

It is kept there (not here) deliberately: the contract is owned by the closed side, and a copy in
the open repo would drift. Read `motir-ai/docs/contract.md` for the full request/response shapes,
the `jobKind` enum, the `PlanDelta` proposal format, and the environment-key inventory.

## The open-core invariant (the two rules this repo enforces)

Whatever the contract adds, these two invariants hold and this repo is responsible for them:

1. **Browsers never call `motir-ai` directly.** Only `motir-core`'s server-side handlers talk to
   `motir-ai`, over a private service channel. The user sees one app, one domain, one cookie; the
   GPL boundary stays a clean network interface (a network service is not a derivative work — see
   `motir-ai/README.md`, ADR-008, and `vision.html` principle #19). No client component, route
   handler reachable from the browser, or public API ever issues a request to `motir-ai`.
2. **The AI never writes the tree directly.** `motir-core` is the **sole** authority over
   `work_item` rows. `motir-ai` only ever **reads** the plan tree and **proposes** a structured
   tree-delta; this repo validates and applies it through the **same `workItemsService` a route
   calls** (`lib/services/workItemsService.ts`), with the identical permission, workflow, and
   tenancy checks the UI uses. There is no write path that bypasses that service — the AI has no
   endpoint, no credential, and no code path that mutates a `work_item`.

The server-to-server surfaces this repo owns for the boundary are the internal read-back routes
(`/api/internal/ai/*`) — reachable only with the service credential, never from a browser session.
Their shapes are specified in `motir-ai/docs/contract.md` §6.
