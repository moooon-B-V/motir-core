# Code access for planning — the closed layer ingests REPOS, never a client-uploaded bundle

**Status:** accepted · **Date:** 2026-07-29 · **Card:** MOTIR-1833 (Story 7.9 · the Motir
CLI), carved out of MOTIR-887 by its replan · **Evidence pinned at:** `motir-core`
`origin/main` @ `1b6255a5`, `motir-ai` `origin/main` @ `7003c49`

## Context

MOTIR-887 (`motir plan` — terminal planning) carried, as if it were one flag on a CLI
card, a whole code-access architecture:

> Before triggering, [the CLI] gathers a planning-context bundle from the linked
> checkouts … the bundle MANIFEST prints first and nothing uploads without confirmation
> … the server side treats it as REQUEST-SCOPED (the 7.5 code-access decision — never
> persisted).

There is no such decision. `ls docs/decisions/` has never held one, and the citation
survived a card review only because a citation reads like a satisfied precondition
(`motir-meta/notes.html` #170 — _"a citation is not a decision"_). This ADR is the
record that should have existed before any card leaned on it.

The question it answers: **does the closed AI layer ingest client-supplied code at
all — and if not, what grounds terminal planning instead?**

### What is actually shipped

| Fact                                                                                                                                                                                                      | Where                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The planning envelope's code slot is `JobCodeContext = { repos: [{ provider, repoRef, defaultBranch }] }` — repo **references**, never file content                                                       | `lib/ai/codeContext.ts:25-36`, typed into the envelope at `lib/ai/types.ts:137`                                                                                                                           |
| It is resolved **server-side** from the persisted GitHub-installation grant mirror (MOTIR-891), a DB read with no client input at all                                                                     | `resolveCodeContext({ userId, workspaceId })`, `lib/ai/codeContext.ts:38`                                                                                                                                 |
| Every planning submit populates it that way — generation, plan-edits, both convention paths, the migrate journey, the code-health page                                                                    | `aiGenerationService.ts:64`, `aiPlanEditsService.ts:107`, `aiConventionService.ts:203`, `conventionEstablishService.ts:62`, `migrateOnboardingService.ts:138,486`, `app/(authed)/code-health/page.tsx:54` |
| The closed side reads that slot through `parseCodeRepoRefs`, which accepts only string refs and `{ repoRef }` objects, skips anything else silently, and grounds every handler on its per-repo code graph | `motir-ai/src/envelope.ts:153`; consumers `generateTree.ts:207`, `codeAudit.ts:91`, `securityAudit.ts:139`                                                                                                |
| There is **no envelope field, no route, and no consumer** anywhere for inline file CONTENT                                                                                                                | grep, both repos                                                                                                                                                                                          |

So the "7.5 code-access decision" the card cited does not exist, and the decision that
_was_ made — GitHub App grant → code graph keyed on `repoRef` — says the opposite.

### Code bytes DO reach the closed layer — through exactly one door

This is the fact that sharpens the question, and it is easy to miss:
`POST /v1/code-graph/index` (`motir-ai/src/app.ts:361`) takes a **raw gzipped tarball**
of a repo's source. Its shape is the point:

- **Service-auth gated**, not user-auth — a core→ai channel, never reachable from a
  client (open-core invariant #1, `docs/ai-boundary.md`).
- **Produced by `motir-core`**, which holds the GitHub installation token, fetches
  `/tarball` itself, and hands over bytes: motir-ai never clones and never sees a
  token (`lib/services/codeGraphIndexService.ts`, `lib/ai/motirAiClient.ts:558`).
- **Tenant ids ride in headers** (`x-core-{organization,workspace,project}-id`,
  `x-repo-ref`) because the body is the tarball.
- **Bounded at 200 MB** (`CODE_GRAPH_MAX_BODY_BYTES`, `motir-ai/src/app.ts:35`).
- **Deliberately persistent**: the temp extraction dir is deleted, the SQLite graph +
  snapshot are kept. A durable derived index is the whole purpose.

The closed layer therefore already ingests code. What it does not ingest — and what
887 assumed — is a _second_, _client-supplied_, _request-scoped_ path.

> **SUPERSEDED IN MECHANISM, NOT IN CONCLUSION (2026-08-05, MOTIR-2138).** The bullets
> above describe the door as it stood at MOTIR-1500 and are kept because the decision they
> support was reasoned from them. **`motir-core` no longer POSTs bytes to motir-ai** — the
> upload client is deleted, and this repo has no method that can. Since MOTIR-2027 /
> MOTIR-2057 both code-graph jobs dispatch a CONTAINER (`docs/decisions/code-graph-index-fleet.md`):
> `motir-core` resolves a pre-signed tarball URL and mints a run-scoped credential
> (`mintCodeGraphRunCredential`), and the container fetches the repo and builds the graph
> itself. The ingest route survives on the motir-ai side with no caller anywhere; deleting
> it is MOTIR-2139.
>
> Every property the decision leans on is unchanged: the channel is still service-auth
> gated and unreachable from a client, motir-ai still never receives a host credential,
> the ingress is still ONE door, and the derived index is still durable. So the answer to
> 887 stands — what moved is which process reads the bytes, not whether a second,
> client-supplied path exists. It still does not. Point 5 of the decision below should now
> be read as naming the FLEET dispatch, not the byte upload, as the extension point.

## Decision

**NO. The closed AI layer does not ingest a CLI-uploaded, request-scoped code bundle.
There is one code-ingestion path — the core-mediated code-graph index — and planning
grounds on repo REFERENCES resolved server-side.**

Concretely:

1. **No bundle field on the job envelope.** `context.code` stays `{ repos: [...] }`,
   resolved by `resolveCodeContext` from the installation mirror. A client cannot
   supply, extend, or override it.
2. **Terminal planning grounds on two things, and neither is an upload.** _Intent_
   comes from the plan-change conversation — `open_plan_session` / `append_plan_turn` /
   `submit_plan_session` (MOTIR-1832), the same `PlanChangeSession` row the web panel
   shows. _Code_ comes from the workspace's connected repos via the GitHub App, indexed
   into the code graph. The CLI supplies neither; it addresses a thread by scope and the
   server resolves the rest.
3. **`motir link` stays a purely local dispatch concern.** It binds a directory to a
   server + workspace + project and records repo checkout paths
   (`packages/cli/src/commands/link.ts`). It holds no secret, and it uploads nothing.
   Nothing in this decision changes it.
4. **The "pre-GitHub fallback" premise is dead.** A user whose repo is not connected does
   not get a degraded upload path; they connect the repo. Planning without a code graph
   is already a supported, clean state — `parseCodeRepoRefs` returns empty, the
   code-graph tools stay reachable and report "no code graph yet", and a start-fresh
   project's envelope is byte-identical to a code-less one. Ungrounded planning is a
   first-class mode, not a failure to work around.
5. **If this is ever revisited, the extension point is the existing ingress — not the
   envelope.** Should a local-only checkout become a real ICP, the sanctioned shape is a
   `motir-core` producer that tarballs a linked checkout and POSTs it to
   `/v1/code-graph/index` under the same service credential, headers, and 200 MB bound
   the GitHub path uses. That reuses the whole consumer side unchanged. Adding a
   parallel content channel to the job envelope is not on the table.

### Why

- **A second ingestion path buys nothing the first does not already do.** The code graph
  is the thing every handler actually queries; a bundle would have to be indexed to be
  useful, at which point it is the existing path with a worse door.
- **The consumer would ignore it.** `parseCodeRepoRefs` is defensive by design — a
  `files[]` sibling on `context.code` is skipped, not rejected. Shipping a producer
  without the closed-repo consumer card yields a silent no-op that looks like a feature.
- **The transports are not comparable.** The code-graph ingress is a service-auth binary
  POST bounded at 200 MB. The CLI reaches the server only over the public MCP endpoint —
  a stateless Next.js Node function (`app/api/mcp/route.ts`) with no application-level
  body cap, i.e. bounded by whatever the deployment platform enforces (on the hosted
  deployment, Vercel's serverless request-body limit), with file content JSON-encoded
  inside a JSON-RPC frame. That is the wrong pipe for source code by two orders of
  magnitude.
- **"Request-scoped, never persisted" was an assertion with no enforcement mechanism.**
  Nothing in the shipped job model gives a payload a lifetime: a `JobRequest` is
  persisted as `requestJson` on the job row, so envelope content is durable by
  construction. Honouring the promise would mean a new redaction/expiry mechanism on the
  closed side — real work, invisible on a 3-point CLI card, and unverifiable from the
  open repo.
- **It cannot be built as one card anyway.** A producer in `motir-core` plus a consumer
  in `motir-ai` is a cross-repo contract; under ONE SUBTASK = ONE REPO = ONE PR it is at
  minimum two coordinated cards behind a decision — which is precisely why this ADR
  exists instead of a flag on MOTIR-887.

### The consent posture — pre-decided, so it is not re-derived

Under this decision the CLI uploads no code, so there is nothing to consent to today.
The posture is recorded anyway, as a **standing requirement on any future
client-supplied code path** (the §5 extension included), so the question is settled
before it is asked again:

- **Manifest first.** Enumerate what would be sent — file count, total bytes, the
  top-level paths — and print it BEFORE any transfer. No silent collection.
- **Nothing leaves the machine without an explicit yes.** Interactive confirmation by
  default; `--yes` is the only way to pre-authorise it, and a non-TTY invocation without
  `--yes` is an error, never an implied consent.
- **`--no-context` is always available** and always wins: it runs the same command with
  no code attached.
- **Empty means empty.** An empty or unresolvable checkout sends no bundle and says so;
  it never falls back to a broader directory.
- **Respect the repo's own exclusions** (`.gitignore` and friends) — a consent prompt
  the user cannot reason about is not consent.

## Consequences

- **A local-only-checkout user connects their repo.** Code grounding requires the GitHub
  App; until then `motir plan` still works — turns, submits, proposals — just without a
  code graph behind the planner. There is no half-way upload mode, by decision.
- **MOTIR-887 ships as a CLI command only.** Its bundle language is already gone (the
  card was re-scoped on 2026-07-29 and re-verified against this ADR: no bundle,
  manifest, upload, or "7.5 code-access decision" text remains in its body), so nothing
  is left as a dormant premise.
- **No implementation cards are filed, deliberately.** A "NO" decision has no
  implementation, and nothing in the current plan depends on the §5 extension — filing a
  card for it would be inventing work, the mirror of the orphaned-deferral defect. The
  trigger that WOULD justify one is explicit: a user whose repo genuinely cannot be
  connected via the GitHub App (or GitLab, MOTIR-1470) and for whom planning must still
  be code-grounded. That is a product question about ICP, not an engineering gap.
- **The reserved hole stays reserved.** `context.code` remains loosely typed on both
  sides; this ADR constrains what may legitimately go in it, not the type.

## Adjacent question, recorded (not re-decided here)

`lib/mcp/tools/planSession.ts:58-62` points at "MOTIR-887 / MOTIR-1833's ADR" for a
second question — whether `motir plan` should drive `generate_tree` for an EMPTY
project. That was decided on MOTIR-887 (Yue, 2026-07-29) and is recorded here so the
pointer resolves: **it should not.** The session submit path reaches `augment` /
contextual only; generation belongs to the onboarding discovery interview, a designed
web flow. `motir plan` detects an un-onboarded project, exits with the onboarding URL,
and appends nothing.

## References

- `lib/ai/codeContext.ts`, `lib/ai/types.ts` — the shipped `context.code` contract.
- `lib/services/codeGraphIndexService.ts`, `lib/ai/motirAiClient.ts` — the core half of
  the one ingestion path; `motir-ai/src/app.ts` `POST /v1/code-graph/index` — the other.
- `docs/ai-boundary.md` — the four open-core invariants this decision keeps.
- `docs/decisions/dispatch-prompt-assembly.md` — the sibling Story-7.9 decision that
  server state, not the client, drives what the CLI sends.
- `motir-meta/notes.html` #170 — the planning mistake that produced this card.
