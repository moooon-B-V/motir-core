# Indexing the code graph on the container fleet

**Status:** accepted · **Date:** 2026-08-03 · **Card:** MOTIR-1987 (Story MOTIR-1981 — index
the code graph on the fleet orchestrator) · **Implemented by:** MOTIR-1986, MOTIR-1988,
MOTIR-1989, MOTIR-1990, MOTIR-1995 · **Evidence pinned at:** `motir-core` `origin/main` @
`7df65d66` · `motir-ai` `origin/main` @ `a4bc960`

`docs/decisions/ci-runner-fleet.md` decided that Motir runs its own container fleet and what
isolates the containers on it. This record decides the **second workload** to land on that
fleet — the **code-graph index** — and, in doing so, generalizes two of that document's
arguments from "CI runners" to "every container Motir boots."

This is a `decision` card: **it fixes shapes and ships no behaviour.** Per `notes.html` #50 —
_a decision card is not an implementation_ — **nothing described here is a precondition any
sibling card may assume is present.** §12 names which card wires each part.

---

## §0 — What this record is, and the one rule for reading it

Nine decisions, all settled at plan time on MOTIR-1981 (2026-08-02) with their evidence. This
document is their durable home, because a work-item description is not where an architecture
lives: sibling cards cite this by path instead of each carrying the argument in its own body.
It **records** those decisions. It does not re-open them.

**A TENTH decision was added later — §14, offboarding (MOTIR-2162, 2026-08-05).** It is not one
of the nine and does not pretend to be: it answers a question §11 left open, on evidence read two
days after the nine were settled, and it carries its own dated evidence block rather than being
retrofitted into §13. **Section numbers are append-only in this file** — §11, §12 and §13 are
cited by cards, by `notes.html` #223 and by comments in both repos, so a later decision is
appended rather than slotted into the numeric run.

**It records the REJECTED alternatives with equal weight, and that is the point.** Three of
the nine were **proposed, pinned, and then reversed** during a single day's planning. An
argument that was strong enough to win once is strong enough to be re-proposed by the next
reader, and a record that lists only winners cannot tell that reader whether their idea was
rejected or simply never considered. §3.1, §5.1 and §8.1 are those three.

**Two corrections to the source card's own rationale are recorded inline**, because verifying
the evidence is what an ADR is for and the alternative is a document that reads as settled
while resting on a false premise:

- **§7.2** — the card justified the shared spend exposure as "one org means one provider spend
  cap … the provider cap is a backstop." **There is no provider spend cap.** Fly offers
  neither a cap nor a billing alert (`ci-runner-fleet.md` §9), and MOTIR-1997 has already
  shipped the product-side ceiling that actually holds the invoice.
- **§8.3** — the card rejected production-placement partly because the per-workspace admission
  cap "bounds `moooon` like any tenant." The **shipped** per-tenant CI cap **exempts** the meta
  org (`PROJECT_IN_FLIGHT_CAPS.meta = null`). MOTIR-1990 must not copy that exemption, or the
  rejection loses its support.

Neither changes a decision. Both change what the decision is allowed to claim.

## §1 — The nine decisions, in one table

| #   | Decision                                                                                                                       | Where                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| 1   | Indexing runs in a **container on the `ContainerOrchestrator` port**, not a Vercel function                                    | [§2](#2--decision-1)                 |
| 2   | Containers run in the **shared `motir-fleet` org** — not production, not a per-workload org                                    | [§3](#3--decision-2)                 |
| 3   | Isolation comes from **credential scope**, not org count                                                                       | [§4](#4--decision-3)                 |
| 4   | The **container builds** the graph; motir-ai is **control plane only**                                                         | [§5](#5--decision-4)                 |
| 5   | **One container per REPO**, forced by the shipped ledger contract                                                              | [§6](#6--decision-5)                 |
| 6   | The concurrency cap lives in the **orchestrator's admission control**                                                          | [§7](#7--decision-6)                 |
| 7   | The **META org runs indexing on the fleet**, exactly like a customer                                                           | [§8](#8--decision-7)                 |
| 8   | `isMeta` bypasses the **CHARGE** — not the placement and **not the meter**                                                     | [§9](#9--decision-8)                 |
| 9   | The container holds **no GitHub credential**                                                                                   | [§10](#10--decision-9)               |
| 10  | A graph is derived customer data with a **defined retention window** — offboarding removes all three artifacts, snapshot first | [§14](#14--decision-10--offboarding) |

§11 records what this deliberately does **not** change. §12 binds it to MOTIR-1981's cards.
**Decision 10 (§14) was added 2026-08-05** by MOTIR-2162 and is not part of the original nine —
see §0.

## §2 — Decision 1

**Indexing runs in a container on the `ContainerOrchestrator` port, not in a Vercel function.**

The old path is `system.code-graph-index`: fetch a whole repo tarball into the function's heap
(`fetchRepoTarball` → `res.arrayBuffer()`, `lib/git/providers/github.ts:147`), POST those bytes
to motir-ai, and have motir-ai parse them inside that one synchronous request.

**Every failure of that path descends from one shape** — a whole-repo fetch and a synchronous
build inside a memory- and time-bounded function. Measured, not characterised:

| symptom                                | evidence                                                                                                                                                                                                                       | why a container removes it                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| **OOM on a large repo**                | `instance was killed because it ran out of available memory` — `motir-core`, **5/5 attempts**, 2026-08-02 (logged as MOTIR-1976, archived when this story superseded the patch)                                                | the fetch happens in a container sized for it               |
| **180 s motir-ai deadline**            | the upload call's own client deadline, `180_000` ms in `lib/ai/motirAiClient.ts` (deleted with the call in MOTIR-2138); **3 repos dead-lettered** on `MotirAiUnavailableError … within 180000ms`                               | the expensive parse leaves the synchronous call             |
| **`maxDuration = 300`**                | `app/api/inngest/route.ts:38`; MOTIR-1974's checkpointing exists only to fit under it                                                                                                                                          | the work is not on Vercel                                   |
| **200 MB ingress ceiling**             | `CODE_GRAPH_MAX_BODY_BYTES`, `motir-ai/src/app.ts` — recorded in `docs/decisions/code-access-for-planning.md:51`. Never reached, but structurally next                                                                         | the upload becomes an ~8–80 MB graph, not a ~350 MB tarball |
| **tarball re-fetched PER PROJECT**     | bytes cannot cross an Inngest step boundary — the MOTIR-1974 note, in `lib/jobs/codeGraphSteps.ts` until MOTIR-2057 deleted it                                                                                                 | one container fetches once and builds once                  |
| **motir-ai is the throughput ceiling** | `indexParseGate = new Semaphore(1)` (`motir-ai/src/codegraph/indexConcurrency.ts:102`); ~**924 MB** peak RSS per index (MOTIR-1515); `fly.toml` scales on `soft_limit = 20` **requests**, which long index requests never trip | the build leaves motir-ai; capacity becomes container count |

The port already exists and already has a consumer: `ContainerOrchestrator`
(`lib/orchestrator/types.ts:155`) with `provision` / `teardown` / `describe`, the Fly adapter,
and a `fake` adapter for tests. Indexing is its **second** consumer; Epic 9's hosted agents are
the third.

**Why this is not a fourth patch to the old path.** MOTIR-1974, MOTIR-1976 and MOTIR-1977 are
three consecutive cards on one code path, and MOTIR-1983 logs the planning bug that no gate
asked whether the **shape** was wrong. This is that question answered: the shape was wrong.

## §3 — Decision 2

**Containers run in the SHARED fleet org, `motir-fleet`** — alongside CI runners and Epic 9's
hosted agents. **Not** the production org (`motir-ai` / `motir-gateway`), and **not** a
per-workload org. The org was stood up and wired by MOTIR-1979; its slug is immutable, which
is why the rename happened before anything else consumed it.

### §3.1 — REJECTED: a dedicated `motir-index-fleet` org

**Proposed, pinned, and then reversed on 2026-08-02.** The argument was structural and not
obviously wrong: Fly's 6PN private network is **organization-scoped and on by default**
(`lib/orchestrator/adapters/fly/flyMachines.ts:21-25`), so an index container holding a repo
credential would share a network with CI containers that execute customer-authored code.

**It was rejected as inconsistent with the shipped model**, on two counts:

1. `motir-ci-fleet` (as it then was) **already** places tenant A's runner beside tenant B's on
   one 6PN. A third org would harden index-vs-CI adjacency while leaving tenant-vs-tenant
   adjacency — the larger surface — exactly as it was.
2. `ci-runner-fleet.md` §7.5 argues only against sharing a 6PN with **production**: _"customer
   code, inside Motir's own production network, by default."_ It does not argue for one org per
   workload, and reading it that way over-extends it.

**Recorded because the intuition will recur.** "An index container next to a CI container feels
unsafe" is a reasonable first reaction, and it costs a Fly org, a payment method, a token, a set
of env vars and a provisioning card (MOTIR-1984, archived) every time someone has it. §4 is the
answer to it.

## §4 — Decision 3

**Isolation comes from CREDENTIAL SCOPE, not org count.**

`ci-runner-fleet.md` §7.4 chose JIT configuration over a registration token for one reason,
stated there in CI's vocabulary: a registration token _"can register **any** runner in the
org"_, while a JIT config is _"one runner, one config, no registration capability inside the
container."_ **What makes the fleet safe is that the container holds nothing worth stealing.**

**This record generalizes that from a runner rule to a fleet rule:** _every container the fleet
boots carries only narrowly-scoped, short-lived credentials, whatever its workload._ For
indexing that means a **pre-signed single-repo tarball URL** (§10) and a **motir-ai token scoped
to this run** — never a shared service token, never a DB credential, never an object-storage
credential, never a Fly token, never a GitHub App key.

**Why this is stronger than org separation, not weaker.** Org separation is a property of the
network; credential scope is a property of the container. A third org would have defended
index-vs-CI and nothing else. Credential scope also defends **tenant-vs-tenant** — the case org
separation never addressed, because both tenants are in the same org either way — and it keeps
holding if a fourth workload lands tomorrow without its own org.

**Production stays separate, and for a different reason.** Not "because it is a different
workload" but because production is **long-lived and holds the real secrets and the real DB
reach**. A fleet container is ephemeral and holds one job's credential. That asymmetry, not the
org count, is the boundary — which is why §7.5's separation survives this generalization intact
rather than being generalized away.

## §5 — Decision 4

**The container BUILDS the graph; motir-ai is control plane only.** motir-ai mints a scoped
upload URL and records the snapshot pointer. The **graph bytes go container → object storage
directly** and never pass through motir-ai.

**Why the delta is small.** motir-ai already separates the two halves: `graphIndexPublisher`
builds, `graphSnapshotStore` content-hashes into object storage, and
`codeRepoService.recordSnapshot` writes the pointer. Moving only the BUILD leaves the persist
path where it is.

**What it buys, in the units the failure modes were measured in** (§2):

- The upload shrinks from a ~350 MB **tarball** to an ~8–80 MB **graph**.
- motir-ai's **1-permit parse gate leaves the index critical path**. That gate is not a
  conservative guess: `motir-ai/docs/decisions/codegraph-production-topology.md` §2 records the
  measurement — the max-safe concurrent index at 512 MB was **N = 0**, a single whole-tree index
  peaks at **924 MB RSS** with **861 MB of it off the V8 heap**, and two would stack. **One index
  per machine is a measured ceiling, not a policy**, which is precisely why capacity has to
  become container count rather than a bigger number in `fly.toml`.
- No DB credential and no object-storage credential ever enter a container (§4).

### §5.1 — REJECTED: the container calls motir-ai's tarball ingest route, and motir-ai builds

**Pinned, then reversed.** The container would fetch the repo and POST the bytes to
`POST /v1/code-graph/index`, leaving the parse in motir-ai. Rejected on three counts:

1. **It makes the container a download proxy.** The container's whole justification is that the
   heavy work needs a box sized for it; a container that only moves bytes has no reason to exist
   and re-introduces the 200 MB ingress bound it was meant to escape.
2. **It leaves `indexParseGate`'s 1-permit ceiling in the critical path** — the throughput
   ceiling §2's last row identifies. Capacity would still be "one index at a time per motir-ai
   machine," and the container would have bought nothing.
3. **It falsifies §4's own rationale.** A container that parses nothing holds nothing and needs
   no isolation argument — so the credential-scope reasoning that justifies the whole shape
   would have had no subject.

It also rested on a **false claim**: that an embedded indexer needs motir-ai's DB credential.
motir-ai's build/persist split (above) means the container can hand over an artifact while
holding only a run-scoped token.

## §6 — Decision 5

**One container per REPO.** This is not a preference; it is **forced by the shipped ledger
contract**, in two places that already read it:

- `jobRunRepository.listSucceededCodeGraphIndexRepoRefs` (`lib/repositories/jobRunRepository.ts:101`)
  reads `output.repoRef` off each **succeeded** `system.code-graph-index` row and builds a set.
  A run carrying no `repoRef` deliberately does not count as an index.
- `MigrateIndexRepoDto` (`lib/dto/migrateOnboarding.ts:65`) is **one row per repo**, and
  `MigrateIndexStatusDto.allIndexed` gates the onboarding wizard's Next button off exactly that
  set.

**So a run means "this one repoRef is indexed."** Batching N repos into one container would emit
one `repoRef` for N repos, and the other **N−1 would read as never-indexed forever** — the sweep
gate would never close and the wizard's rows would never all turn green.

Note the same DTO already records a related limitation in its own comment: _"the ledger cannot
tie a running row to a specific repo, so the in-flight state is aggregate, not per-repo."_
One-container-per-repo is what keeps the **succeeded** state per-repo, which is the state both
consumers actually gate on. **Re-modelling the ledger to allow batching is out of scope.**

## §7 — Decision 6

**The concurrency cap lives in the ORCHESTRATOR's admission control** — a global bound from
config, with a per-workspace bound of `ceil(global / 2)` so one tenant cannot starve another.
MOTIR-1990 owns it.

**Not in Inngest.** Per-tenant concurrency there would need a **keyed** limit, and `defineJob`
discards Inngest's concurrency `key`/`scope` entirely (MOTIR-1982) — so the substrate cannot
express it today. This is why MOTIR-1981 is **not** `blocked_by` that bug: the cap is being put
somewhere that can hold it, not waiting for the place that cannot.

The shipped `concurrency: 2` on the job (`lib/jobs/definitions/codeGraphIndex.ts:35`) was never
a tenancy control — its own comment records what it was for: five simultaneous runs against a
scale-to-zero motir-ai whose **cold start alone took 23.3 s** on 2026-08-02, each paying it and
none benefiting.

### §7.2 — CORRECTION: there is no provider spend cap underneath any of this

MOTIR-1981 justified the shared-org exposure as: _"one org means one provider spend cap, so a
runaway in any workload could stop all three — accepted only because each workload carries its
own in-Motir admission cap, making the provider cap a backstop rather than the operative
control."_

**The premise is false, and the conclusion is stronger without it.** `ci-runner-fleet.md` §9
established, quoting Fly's own cost-management documentation, that **Fly offers neither a
spending cap nor a billing alert**: _"We don't support billing alerts (yet), so budget
accordingly"_ and _"Free allowances don't cap your bill. … there's no soft ceiling. If you go
over, we'll bill you."_ MOTIR-1935 — the card titled _"set the fleet's provider-side spending
cap + alerts"_ — closed with that finding: there was no cap and no alert to set.

**Nothing sits underneath the product-side number.** So the layering, stated accurately:

| layer                                                              | what it bounds                                  | owner                    |
| ------------------------------------------------------------------ | ----------------------------------------------- | ------------------------ |
| `MOTIR_FLEET_MAX_IN_FLIGHT` — the **cross-workload** fleet ceiling | **the invoice** — every container, any workload | MOTIR-1997 (**shipped**) |
| Per-workspace index cap, `ceil(global / 2)`                        | **index fairness** — tenant vs tenant           | MOTIR-1990 (this story)  |
| Per-project CI cap (`PROJECT_IN_FLIGHT_CAPS`)                      | CI fairness                                     | MOTIR-1922 (shipped)     |
| Epic 9's agent cap                                                 | seats                                           | Epic 9                   |
| ~~Provider spend cap~~                                             | **does not exist**                              | —                        |

**MOTIR-1997 was caused by these decisions and has already landed.** Its registry comment
(`lib/ciFleet/workloads.ts`) names them directly: _"MOTIR-1981 decisions 2–3 put CODE-GRAPH
INDEX containers in the same Fly org and Epic 9 adds HOSTED AGENT containers; neither writes a
runner intent. Two independent per-workload caps do not compose into a bound."_ The ceiling now
counts every container under one `fleet` admission lock, summed by `fleetCeilingService.census`
over a **totality-guarded** `Record<FleetWorkloadKind, …>` — `code_graph_index` is already a
declared member, so this workload is counted **before** it ships rather than after.

**Two consequences MOTIR-1990 must honour:**

- Its per-workspace cap is **fairness underneath the ceiling**, not the spend bound. The spend
  bound is `MOTIR_FLEET_MAX_IN_FLIGHT` (default `DEFAULT_FLEET_IN_FLIGHT_CEILING = 24`,
  `lib/ciFleet/limits.ts:55`), and it is not this story's to re-derive.
- The index dispatcher must **take a `fleet_in_flight_slot`**, because that is how a workload
  with no intent table of its own becomes visible to the census. A cap that only counts index
  containers repeats exactly the defect MOTIR-1997 fixed.

This is `notes.html` #185 applied rather than restated: _express enforcement in terms the
product controls, not in the provider's billing controls._ The shared org's real accepted cost
is not "one provider cap for three workloads" — it is **one invoice with nothing but Motir's own
counter in front of it.**

### §7.3 — CORRECTION: the caps only bind the FIRST run for a (repo × project) — MOTIR-2160

MOTIR-1990 shipped the slot key as `<projectId>:<repoRef>`, _"deterministic, and deliberately not
run-scoped"_, so that a redelivery, an Inngest replay and a job retry find the slot they already
hold instead of taking a second one. That reasoning is sound and the key has not changed. **What
it silently also assumed is that a held slot could only ever be the asking run's own** — and
nothing in the system was holding that assumption up.

`system.code-graph-refresh` debounces pushes on `installationId/owner/name` with a **2-minute**
window (`lib/jobs/definitions/codeGraphRefresh.ts`). That coalesces merges INSIDE one window and
does nothing once a run has started: a push arriving mid-index opens a new window and fires a
second run. An index takes **minutes** — §11 records `motir-core`'s own tree failing to parse in
180 s — so a second run for a repo the first is still indexing is ordinary merge cadence, not an
exotic race. And the job deliberately carries **no `concurrency`** (MOTIR-2057, correctly: it
would cap supervisors, not containers), so nothing else serialized it either.

Two consequences, both of which contradict §7 / §7.2 as written:

- **`admit` returned `already_held` BEFORE evaluating any cap** — that early return is what makes
  a replay idempotent — so the second run's container booted having been judged against **none**
  of `workspaceIndexInFlightCap`, `indexInFlightCap` or `fleetInFlightCeiling`, the last of which
  §7.2 establishes has nothing whatsoever behind it.
- **Whichever run settled first released the shared slot**, so the census under-counted a
  container that was still running and still billing — the one direction §7 says the ceiling must
  never err in — and a third dispatch could then take the freed row only to have it deleted in
  turn by the second run's settle.

**The correction keeps the key and adds the OWNER.** `fleet_in_flight_slot.owner_ref` records the
dispatching run (`ctx.runId`, stable across a run's replays and retries, different for every new
run). Admission compares it: the same run keeps its capacity (`already_held`, still ahead of the
caps, still not a refusal), a different run is `deferred` with the new reason
`repo_index_in_flight` and waits on the existing budget — 60 attempts, 5 s → 60 s, `step.sleep`,
so waiting costs no invocation. Release is ownership-checked (`releaseOwned`), which is the half
that stops the cascade and is worth having on its own.

Putting the run in the **key** would have re-created exactly what MOTIR-1990 rejected — every
retry taking its own slot and walking past the cap. Putting it in an **owner column** does not:
the key still names one unit of index work, and the row now also says who is doing it.

**And it closes a second defect by construction, in the other repo.** motir-ai's `recordSnapshot`
writes the pointer unconditionally (no compare against the row's `commitSha`/`indexedAt`), so two
overlapping runs finishing out of start order could land the OLDER graph while stamping
`indexedAt = now()` — a stale code graph that claims to be current, with no detection point until
the next push. Serializing the runs removes the only way two writers for one (repo × project) can
exist, so no motir-ai card is owed. If a later decision ever tolerates overlap again, that guard
comes back with it.

## §8 — Decision 7

**The META org runs indexing ON the fleet, by the same path a customer takes.**

### §8.1 — The test is CIRCULARITY, not meta-vs-customer

MOTIR-1915 keeps `moooon-B-V`'s **CI** on GitHub-hosted runners, and its reason is specific:
_"don't put your own release path on infrastructure you are still building."_ A broken CI fleet
would block shipping the fix to the CI fleet.

**That reasoning does not extend to indexing.** A broken index fleet makes Motir's planner
code-blind; it does **not** block shipping. There is no circular dependency, so the exclusion
does not carry over. Read the exclusion as _"is our own recovery path on this?"_ — not as
_"is this ours?"_

_(For Epic 9 the test bites again: if Motir's own story runs move to hosted agents on the fleet,
a broken fleet means no agent to fix it. That is acceptable **only while a non-fleet escape
hatch exists** — today the BYOK/local CLI path. Recorded here because it is the same test, not
because this story decides it.)_

### §8.2 — REJECTED: run meta's containers in the production org

**Defensible on its face**, which is why it needs recording: meta indexing parses _Motir's own_
source, which is trusted, so the untrusted-input rationale for fleet isolation genuinely does
not apply to it.

**Rejected for EXERCISE, not for security.** `moooon` is currently the only real tenant, so
meta-in-production means **nothing runs in the fleet at all**. The index path would ship, pass
its `fake`-adapter tests, and sit as **dead code** until the first customer connects a repo —
surfacing every wiring bug at once, in front of that customer.

**That is a shape this project has already paid for.** MOTIR-1980 records it: _"the fleet
shipped code-complete and UNBOOTABLE"_ — five green cards, an unbuilt runner image, an unwired
org, and nothing able to start. Placing meta in production would reproduce it deliberately.

It would also require an **`isMeta` branch in the boot path** — a code path only meta takes,
which means the tested path is the one nobody runs, and the untested path is the one every
customer gets.

**The budget concern that motivates it is real and is solved elsewhere:** meta metered as its
own queryable line (§9), plus the admission cap that bounds `moooon` like any tenant (§8.3).
**Org placement is the wrong lever for an accounting problem.**

### §8.3 — CORRECTION: "bounded like any tenant" is not what the shipped cap does

§8.2's rejection leans on meta being bounded by the per-tenant cap. The **shipped CI** cap does
the opposite: `PROJECT_IN_FLIGHT_CAPS.meta = null` (`lib/ciFleet/limits.ts:85`) — meta is
**exempt** from the per-project allowance, by MOTIR-1922's acceptance criterion.

The exemption is bounded and honest about itself: its comment reads _"exempt per the card, and
ONLY from this cap"_, and `fleetCeilingService`'s NO-BYPASS block is explicit that `isMeta` does
not lift the fleet ceiling — _"a meta-org runaway costs Motir exactly as much as any other."_
So meta is bounded by **the invoice ceiling**, not by a per-tenant one.

**Binding on MOTIR-1990: the per-workspace index cap applies to the meta workspace.** Do not
copy `PROJECT_IN_FLIGHT_CAPS`'s meta row into the index cap. The reasons differ — CI's exemption
is about a tier allowance for work Motir is not billing itself for, while the index cap's job is
**tenant-vs-tenant fairness**, and `moooon` indexing its own repos can starve a customer exactly
as any tenant can. If MOTIR-1990 concludes otherwise, §8.2's rejection needs re-deciding, not
quietly weakening.

## §9 — Decision 8

**`isMeta` bypasses the CHARGE — not the PLACEMENT, and not the METER.**

Meta compute runs **on the same fleet, by the same path**, and is **metered as COGS attributed
to Motir**, queryable as its own line. It simply never debits a ledger. Unmetered dogfooding is
unbounded and invisible spend, and "we don't bill ourselves" is not a reason not to know the
number.

### §9.1 — The generalization, and why it is recorded as a warning

**`isMeta` is a BILLING flag that has been used as a proxy for "this workload is not real."**
That proxy was safe while meta ran nothing on shared infrastructure. **It stops being safe the
moment meta shares infrastructure with customers** — which is what decision 7 does.

**Every `isMeta` branch should be read as _"should this be un-charged?"_ — never as _"should
this be un-measured?"_ or _"should this run somewhere else?"_**

**This is not hypothetical; it is live in shipped code.** `ciFleetCostMeterService`
(`lib/services/ciFleetCostMeterService.ts:117-121`) resolves `isMeta` and returns
`{ outcome: 'bypassed_meta' }` **before** writing the usage row — so a meta container's
**container-seconds and cost are not recorded at all**, not merely not charged. The stated
rationale is about billing (_"attributing this cost would bill the house to itself"_), but the
implementation drops the measurement. The same shape sits in `ciMinutesMeterService`
(`bypassed_meta`) and in `allowance.ts`'s `bypassed` state.

For CI the branch is currently **unreachable** — MOTIR-1915 keeps `moooon-B-V` off fleet
runners, so no meta CI container exists to meter — and that unreachability is exactly why it
survived unexamined. **Decision 7 makes the equivalent branch reachable for indexing.**

**Binding on MOTIR-1995 (the index COGS meter):** meta index containers are **metered**, with
their seconds and cost attributed to the org and distinguishable from CI and agent spend within
the shared org. `isMeta` may suppress a charge; it may not skip the write. Whether
`ciFleetCostMeterService`'s CI bypass should change is **not decided here** — it is a live
question about a different workload, and this record only fixes that the index meter must not
inherit the pattern.

The separability itself is already prepared: the CI meter stamps `workload: 'ci'` on its rows,
with a comment naming index and agent containers as recording their own.

## §10 — Decision 9

**The container holds NO GitHub credential.**

motir-core resolves GitHub's **pre-signed `codeload` URL** and passes that URL — not a token —
in the container spec. GitHub 302-redirects `/repos/{owner}/{repo}/tarball/{ref}` to a
`codeload.github.com` URL **authorized by its own signed query string**.

**The evidence is already in the code**, in the comment on today's fetch
(`lib/git/providers/github.ts:124-129`): _"GitHub 302-redirects `/tarball` to a PRE-SIGNED
codeload.github.com URL. `fetch` follows the redirect and (per the fetch spec) STRIPS the
[`Authorization` header] … the codeload URL is already authorized by its signed query string."_

So the property this decision relies on is **not a new assumption** — it is the mechanism the
current path already depends on, observed rather than hoped for: the installation token does
not reach `codeload` today either. **Handing the resolved URL to a container therefore leaks
nothing, and is strictly less privilege than handing over an installation token**, which would
grant repo-wide API access for its lifetime.

**What MOTIR-1989 must change:** today's call lets `fetch` follow the redirect internally and
buffers the body (`res.arrayBuffer()`, the OOM in §2). Dispatch instead issues the request with
`redirect: 'manual'` and reads the `Location` header, so the **URL** — not the bytes — is what
crosses into the container spec. The URL is short-lived and single-repo, which is §4's rule
satisfied for the fetch half; the motir-ai run-scoped token (MOTIR-1986) is §4 satisfied for the
upload half.

## §11 — What this does NOT change

**The `motir-projects`-only CI boundary is untouched** (MOTIR-1915 / MOTIR-1916). This story
uses the **orchestrator PORT**, not the runner layer: **no runner registers, no `runs-on`
resolves, no `workflow_job` fires, and nothing bills as CI minutes.** Sharing an org does not
change that — **a container is not a runner.** No `moooon-B-V` repo gains a Motir `runs-on`
label and no GitHub runner is provisioned for one.

**Indexing cannot be a GitHub Actions workflow, and this is a hard constraint, not a
preference.** It must work for **BYOK repos Motir does not own** (MOTIR-1754): injecting a
workflow file mutates a customer's code, requires Actions to be enabled, and is impossible on a
read-only connection. It would also gate a user's code graph behind their **CI credit balance** —
`ci_credits_exhausted` would silently mean "your planner is code-blind." Two unrelated products
would share one refusal.

**Still building in-process, unchanged:** ~~`system.code-graph-refresh`~~ and motir-ai's
**hydrate-on-read** path both keep running behind `indexParseGate`. **Retiring motir-ai's
tarball ingest route is a later decision**, not this one — the route stays.

> **AMENDED 2026-08-04 (MOTIR-2057): the refresh half of that sentence was wrong, and
> production paid for it.** Leaving one caller on an abandoned path is not a neutral
> "unchanged" — `system.code-graph-refresh` does architecturally the same work (fetch a
> repo's bytes, parse a whole tree) and kept doing it inside a Vercel function under the
> 180 s upload client deadline. `motir-core`'s own graph does not
> parse in 180 s, so its refresh failed deterministically, and its five idempotent retries
> then queued against motir-ai's single 1-permit `indexParseGate` and starved every other
> repo's refresh: a measured **~68% failure rate over three days** (Aug 2 7/18, Aug 3 7/16,
> Aug 4 8/17), presenting as intermittent motir-ai unavailability. `system.code-graph-refresh`
> now drives the SAME `runIndexFleetSteps` shape as the first index, keeping only its
> per-repo debounce, and the in-process module (`lib/jobs/codeGraphSteps.ts`) plus
> `codeGraphIndexService.indexRepoIntoProject` are DELETED so no third caller can adopt
> them. motir-ai's hydrate-on-read path and its ingest route are untouched, as above.
>
> Two facts worth carrying, both established while diagnosing it:
>
> - **A refresh was never incremental.** motir-ai's incremental entry is
>   `GraphIndexPublisher.refresh`; the ingest route runs `receiveAndIndex` →
>   `indexAndPublish` → `store.indexRepo`, a whole-tree build, and nothing has ever called
>   the incremental one. Moving refresh onto the fleet therefore loses no incremental
>   semantics — the same whole-tree parse moves off a 180 s budget onto a container's
>   30-minute one — but it does move the cost onto a metered container per (repo × project)
>   per debounced push, admitted by `codeGraphIndexAdmissionService` (§7).
> - **The lesson generalizes past this file** (`motir-meta/notes.html` #215): a migration's
>   unit is the SET OF CALLERS of the path being abandoned, not the one caller that
>   motivated it.

> **AMENDED AGAIN 2026-08-05 (MOTIR-2138): "the route stays" is no longer the whole
> picture, because the CLIENT does not.** With both jobs on the fleet, `motir-core`'s
> byte-upload method sat exported and tested with no call site for weeks — the same
> "leaving an abandoned path reachable is not neutral" shape the amendment above paid for,
> one layer down. It is now DELETED, and with it the second deadline this boundary
> carried; every remaining method on `lib/ai/motirAiClient.ts` is a JSON request under the
> single 30 s `MOTIR_AI_REQUEST_TIMEOUT_MS`. **motir-core can no longer POST bytes to
> motir-ai at all** — anything that wants a graph built dispatches a container, which
> fetches the repo from a pre-signed URL itself.
>
> Retiring motir-ai's ingest ROUTE — the "later decision" §11 deferred without filing a
> card, which is the planning bug MOTIR-2140 records — is now MOTIR-2139, in the other
> repo. Until it lands the route exists with no caller anywhere; that is the intended
> ordering, since removing an unused client can break nothing while removing the server
> first would leave a client whose only possible outcome is a 404.

**Not decided here:** MOTIR-1974's checkpointing is not re-opened; how the product _asks_ for a
repo or surfaces index _freshness_ stays with MOTIR-1754; motir-ai's graph **engine** and its
1-permit semaphore are unchanged and not weakened; Epic 9's container lifetime, cap and metering
remain Epic 9's.

> **AMENDED 2026-08-05 (MOTIR-2162): this section never asked what happens when a repo goes
> AWAY, and the answer turned out to be "nothing, anywhere."** Every sentence above is about
> what still BUILDS a graph. Nothing here — or in the nine decisions — says what removes one,
> and §5 moved the persist path's justification ("the delta is small; leave persist where it
> is") without anyone noticing that the persist path had no inverse. **That is now Decision 10,
> §14.** It is recorded as an omission rather than a change of mind: no decision above is
> reversed by it, and the gap was found by MOTIR-2161 standing in front of the code, not by any
> gate.

### §11.1 — The workload asymmetry, for whoever reads this from Epic 9

Index containers and agent containers are shaped differently, and the numbers here do not
transfer:

| axis             | index container          | agent container (Epic 9) |
| ---------------- | ------------------------ | ------------------------ |
| lifetime         | **minutes** — job-shaped | **hours** — story-shaped |
| credential       | per-**job**              | per-**session**          |
| what a cap means | **throughput**           | **seats**                |

Two consequences. A cap number that reads as "throughput" for indexing reads as "seats" for
agents, so **Epic 9 must size its own** rather than copy §7's. And **teardown-time costing
under-reports a long-running container for its whole life** — the index meter records at
teardown because minutes-long containers make that accurate; hours-long ones do not.

`DEFAULT_FLEET_SLOT_TTL_SECONDS` is 6 hours (`lib/ciFleet/limits.ts:70`) and is a **safety net,
not a timeout** — deliberately longer than any container Motir boots. An agent workload should
check that assumption against its own lifetime rather than inherit it.

## §12 — Binding on MOTIR-1981's cards

Per `notes.html` #50, this record ships nothing. Each line below is what a sibling card owns,
and each may cite **this file by path** instead of restating the argument:

| Card           | Owns                                                                                                                                  | Sections       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| **MOTIR-1986** | motir-ai reduced to control plane: run-scoped credential, single-key upload URL, pointer recorded                                     | §4, §5         |
| **MOTIR-1988** | the indexer image — fetch a tarball URL, build the graph, hand over the pointer; digest-pinned, mirrored per `fleet-image-pull.md` §1 | §5, §10        |
| **MOTIR-1989** | dispatch a container instead of fetching in-function; `redirect: 'manual'`; the ledger contract preserved                             | §2, §6, §10    |
| **MOTIR-1990** | the admission cap — global + per-workspace `ceil(global / 2)`; takes a `fleet_in_flight_slot`; **no meta exemption**                  | §7, §7.2, §8.3 |
| **MOTIR-1995** | the COGS meter — per-container seconds + cost, `workload` stamped, **meta metered and not charged**                                   | §9, §9.1       |
| **MOTIR-1994** | live verification that a container really boots in `motir-fleet` and its credentials are provably narrow                              | §3, §4         |
| **MOTIR-2160** | the slot's OWNER — one run at a time per (repo × project), ownership-checked release                                                  | §7.3           |

**Already shipped, and load-bearing for this story:** MOTIR-1979 (the `motir-fleet` org),
MOTIR-1997 (the cross-workload ceiling that counts `code_graph_index` before it exists),
MOTIR-2005 / MOTIR-2006 (how a fleet machine obtains image bytes — the indexer image is built
from motir-ai's **closed** source, so `fleet-image-pull.md` §1 puts it in the **mirror** column).

**Decision 10 (§14) binds its own cards, in §14.6** — they belong to MOTIR-2162, not to MOTIR-1981,
so they are listed there rather than added to the table above.

## §13 — Sources

**Read or measured 2026-08-02 – 2026-08-03.** Code references are pinned at `motir-core`
`7df65d66` and `motir-ai` `a4bc960`.

- `docs/decisions/ci-runner-fleet.md` — **§7.4** (JIT config over registration token, the
  argument §4 generalizes), **§7.5** (org-scoped 6PN; production separation), **§9** (Fly offers
  neither a spending cap nor an alert), **§9.1a** (the cross-workload amendment).
- `docs/decisions/fleet-image-pull.md` §1 — public-vs-mirror by source visibility.
- `docs/decisions/code-access-for-planning.md:51` — the 200 MB ingress bound.
- `motir-ai/docs/decisions/codegraph-production-topology.md` §1–§2 — the measured
  one-index-per-machine ceiling (924 MB peak, 861 MB off-heap; N = 0 safe at 512 MB), grounded in
  MOTIR-1515's `results-local.md`.
- `lib/orchestrator/types.ts:155` · `lib/orchestrator/adapters/fly/flyMachines.ts:21` — the port,
  and the 6PN comment §3.1 rests on.
- `lib/git/providers/github.ts:109-147` — `fetchRepoTarball`, the `res.arrayBuffer()` that OOMs,
  and the pre-signed `codeload` redirect §10 rests on.
- `lib/repositories/jobRunRepository.ts:101` · `lib/dto/migrateOnboarding.ts:65` — the per-repo
  `output.repoRef` contract §6 rests on.
- `lib/ciFleet/workloads.ts` · `lib/services/fleetCeilingService.ts` · `lib/ciFleet/limits.ts:55,70,85` —
  the shipped cross-workload ceiling, its census, and the per-tier caps.
- `lib/services/ciFleetCostMeterService.ts:117-121` · `lib/services/ciMinutesMeterService.ts` ·
  `lib/ciMetering/allowance.ts:60` — the live `bypassed_meta` instances §9.1 warns about.
- `lib/ai/motirAiClient.ts:94` · `app/api/inngest/route.ts:38` ·
  `lib/jobs/definitions/codeGraphIndex.ts:24-35` — the deadlines and the old cap.
- `motir-ai/src/codegraph/indexConcurrency.ts:102` · `motir-ai/fly.toml` — the 1-permit gate and
  the request-based scaling that long indexes never trip.
- `notes.html` **#50** (a decision card is not an implementation), **#185** (express enforcement
  in terms the product controls).

## §14 — Decision 10 — Offboarding

**Status:** accepted · **Date:** 2026-08-05 · **Card:** MOTIR-2162 · **Implemented by:** MOTIR-2165,
MOTIR-2166, MOTIR-2168, MOTIR-2169, MOTIR-2171 (and MOTIR-2163, the pointer back into motir-ai) ·
**Evidence pinned at:** `motir-core` `origin/main` @ `c27c6776` · `motir-ai` `origin/main` @ `cc36f74`

**A repo's code graph is DERIVED CUSTOMER DATA held under a DEFINED RETENTION WINDOW — not a permanent
cache. Offboarding removes all three artifacts, snapshot first.**

This is a later decision, not one of the nine (§0). It exists because §11 recorded what this story does
not change and never asked what happens when a repo goes **away** — and the answer, found by MOTIR-2161
while deleting two caller-less functions, was **nothing, anywhere.**

### §14.1 — The gap, measured

Under §4–§5 a repo's graph lives in three places. On `origin/main` at the date above, **no code path
removes any of them on purpose:**

| #   | artifact                                               | what removes it today                                                                                                                                    |
| --- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | the Postgres `CodeRepo` coordination row               | only the `AiProject` FK cascade — and nothing in motir-ai `src/` deletes an `AiProject`, so in practice it never fires                                   |
| 2   | the per-machine local root under the adapter's FS root | nothing. `graphCacheManager`'s LRU evicts **handles** and deliberately leaves the file on disk (`graphCacheManager.ts:28`)                               |
| 3   | the durable object-storage snapshot                    | nothing. `graphSnapshotStore.prune` is a SIZE bound that returns early for `keep <= 0` (`:376-377`), so no argument to it removes a repo's last snapshot |

**And the one deletion the system CAN do makes it worse.** The FK cascade removes the coordination rows,
which are the only inventory of which snapshot keys exist. The objects stay under
`codegraph/<aiProjectId>/<repoRef>/<commitSha>.db.gz` (`snapshotPrefix`, `:479`), reachable only by a
bucket-wide `ListObjectsV2` diffed against live projects — a sweep that does not exist. **Retained data
becomes UNREFERENCED retained data.**

`prisma/schema.prisma` already carries an informal position on this — the `AiProject.codeRepos` comment
says the snapshots and caches are then _"rebuildable-only."_ **That sentence is the accident this section
replaces with a decision.** It is not wrong about the engineering; it simply never asked whether
rebuildable and disposable are the same thing, and nobody had to answer because no code depended on it.

### §14.2 — Why "it is a rebuildable cache, keep it" was rejected

It is the cheaper answer and it is defensible on the engineering: every artifact really can be rebuilt
from the source tree, and keeping it costs storage and nothing else. It was rejected on two counts.

1. **A graph is not a cache of public data — it is a derivative of a customer's PRIVATE source.** It
   holds their file paths, symbol names and call structure. "We keep a rebuildable artifact" describes
   the cost model, not the obligation; the obligation follows the input, not the reconstructability.
2. **The mirror does not do it either, and the terms this product ships under do not allow the silence.**
   GitHub's Marketplace terms make the provider responsible for deleting the user's data _"within its
   defined window"_ — the obligation is to **have** a defined window and be able to state it. Silence is
   the one answer that is not available.

**Rejected with it: "delete immediately on disconnect."** Sourcegraph — the closest mirror for
code-graph data specifically — makes retention a first-class, configurable policy rather than an instant
purge, and keeps a removed repository's data on disk _"so that in the event the repository is added
again it doesn't need to be recloned."_ That is the accidental-disconnect case, and it matters more here
than there: a re-index is a **metered container per (repo × project)** (§7), so an instant purge bills the
user for their own misclick.

**So the decision is the shape both rejections point at: a stated, bounded window.**

### §14.3 — Per trigger

Every trigger below is a control that already ships. **`repoRef` scope is per-repo where the trigger is
per-repo, and whole-project otherwise.**

| trigger                   | shipped site (motir-core)                                                                                   | scope               | when             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------- | ---------------- |
| disconnect ONE repo       | `gitlabConnectionService.disconnectProject`; the GitHub `deleteExcept` prune in `githubInstallationService` | that `repoRef`      | after the window |
| disconnect the CONNECTION | `gitlabConnectionService.disconnect`                                                                        | every repo on it    | after the window |
| ARCHIVE a project         | `projectsService.archiveProject`                                                                            | whole project       | after the window |
| DELETE a workspace        | `workspacesService.deleteWorkspace`                                                                         | every project in it | **immediately**  |

**There is no project hard-delete to decide for.** `archiveProject` is this product's terminal project
lifecycle action — its own comment says so, and `git grep` finds no `project.delete` anywhere in `lib/`
or `app/`. MOTIR-2162 was authored asking what "deleting a project" should remove; the honest answer is
that the operation does not exist, and archive is the edge that stands in for it. That is the same
reading MOTIR-1972 already took when it hung the runner-group cleanup off archive.

**Why the workspace arm has no window.** The other three leave the project row standing, so the scope
remains readable and a re-connect can cancel the pending removal. `deleteWorkspace` is a hard delete
that cascades: there is no surface left to undo into, so a window would protect nothing and only extend
retention. **A grace period the user cannot reach is not a grace period.**

**The window is 30 days**, one named constant in motir-core (MOTIR-2166), interpolated into the copy that
states it (MOTIR-2171) rather than retyped — so the promise and the behaviour cannot drift.

**Re-onboarding CANCELS a pending offboard.** A repo reconnected, or re-indexed, before its due date
clears the queue row. This is what makes the window a grace period rather than a delay, and it is why
the window is worth having at all.

### §14.4 — The ORDER, and why it is the load-bearing part

**Snapshot → local root → coordination row. Always, and asserted by a test rather than a comment.**

The row is the only record of which object keys belong to a repo. Removing it first does not merely
waste a step — it strands the snapshot as garbage nobody can name, which is **precisely what the FK
cascade does today** (§14.1). A removal path that ships in the wrong order closes green and makes the
defect strictly worse.

**Every step is idempotent by construction** — `DeleteObjects` over a prefix, `rm -f`, `deleteMany` — so a
partial run followed by a re-run converges. Offboarding is therefore a **re-runnable sweep keyed by
(aiProjectId, repoRef)**, never a one-shot fired at the trigger.

### §14.5 — The SEAM, pinned

**Trigger → `CodeGraphOffboarding` queue row (motir-core) → `system.code-graph-offboard-sweep` cron
(motir-core) → `POST /v1/code-graph/offboard` (motir-ai) → the three deletions.**

Three properties, each checked against shipped reality rather than assumed:

- **The queue row is deliberately NOT foreign-keyed to the workspace or project.** It must outlive the
  cascade that makes it necessary. An FK here would reproduce the exact defect this section exists to
  fix, one repo over — and it would look correct in review, because every other table in that schema
  should have one.
- **The clock lives in motir-core.** `git grep` over motir-ai's `src/` finds no cron, no interval and no
  scheduled entrypoint — it receives `POST /v1/jobs` and serves `/v1/*`. motir-core already owns every
  recurring sweep (`system.attachment-gc`, `system.automation-retention-sweep`, `system.ci-runner-reap`),
  and keeping the clock there preserves §5's control-plane-only shape for motir-ai.
- **The queue IS the retry.** The row is deleted only on a successful response, so a motir-ai outage
  leaves it due and the next tick picks it up. No bespoke attempt counter, no dead-letter table.

**Why a queue rather than the `deleteQuietly` precedent.** `archiveProject` already fires a post-commit,
best-effort external cleanup at a runner group (MOTIR-1972, `ci-runner-fleet.md` §7.3), and that is the
right **shape** — outside the transaction, never failing the user's action. It is the wrong
**mechanism** twice over: a window cannot be implemented by a call that happens now, and `deleteQuietly`'s
failure mode is a stale access list somebody tidies later, while a dropped call here means customer-derived
data retained forever underneath a promise that it was not. `notes.html` #185 — express enforcement in
terms the product controls.

**Enqueue is still post-commit and non-fatal**, which is correct and has a consequence: some enqueues will
be lost. That is what the reconciliation backstop (MOTIR-2169) is for, and it is also the only thing that
can ever find the graphs the FK cascade has **already** orphaned — the bucket-wide sweep MOTIR-2162 named
as not existing.

### §14.6 — What this does NOT decide, and the card for each

Per `notes.html` #223 — the lesson written about **this document's §11** — every deferral below is a filed
card, cited by key, filed before this section merged. There is no sentence here that names no card.

| deferred                                                                                                  | card                        |
| --------------------------------------------------------------------------------------------------------- | --------------------------- |
| the removal endpoint + the three deletions, in order, idempotent                                          | **MOTIR-2165** (motir-ai)   |
| the queue table, the four triggers, cancel-on-reconnect, the window constant                              | **MOTIR-2166** (motir-core) |
| the cron that drains the queue through the seam                                                           | **MOTIR-2168** (motir-core) |
| the reconciliation backstop + the pre-existing cascade orphans                                            | **MOTIR-2169** (motir-ai)   |
| stating the window on the disconnect / archive / delete surfaces                                          | **MOTIR-2171** (motir-core) |
| carrying this decision back into motir-ai's `codeRepoService` pointer and the `codeRepoOffboarding` guard | **MOTIR-2163** (motir-ai)   |

Per `notes.html` #50, **this section ships nothing** and is not a precondition any of those cards may
assume is present.

**Account closure is out of scope and is not a deferral** — Motir has no account-closure operation to
hang a trigger on. When one is built, it inherits the workspace arm (immediate, no window) for every
workspace it removes; that is a line in that feature's own design, not an unfiled card here.

**No design amendment is owed.** The rule that a decision introducing a new affordance must spawn one
(`notes.html` #143) was evaluated, not skipped: every trigger above is an existing control, and MOTIR-2171
adds body copy to dialogs that already ship. That card carries its own instruction to STOP and file a
design card if the copy turns out to need an element the dialogs cannot express.

### §14.7 — Sources

**Read 2026-08-05.** §13's list is pinned to 2026-08-02–03 and is deliberately left alone.

- `motir-core`: `lib/services/projectsService.ts` (`archiveProject`, its terminal-lifecycle comment, and
  the `projectRunnerGroupService.deleteQuietly` post-commit precedent) · `lib/services/workspacesService.ts`
  (`deleteWorkspace`) · `lib/services/gitlabConnectionService.ts` (`disconnectProject`, `disconnect`) ·
  `lib/services/githubInstallationService.ts` (`deleteExcept`) · `lib/jobs/definitions/` (`system.attachment-gc`,
  `system.automation-retention-sweep`, `system.ci-runner-reap` — the shipped sweep shapes).
- `motir-ai`: `src/codegraph/graphSnapshotStore.ts` (`prune` `:376-377`, `snapshotPrefix` `:479`,
  `DeleteObjectsCommand` `:62`) · `src/codegraph/graphCacheManager.ts` (`:28`, the file left on disk) ·
  `src/services/codeRepoService.ts` (MOTIR-2161's header block) · `src/app.ts` (the `/v1` table; no
  scheduler anywhere in `src/`) · `prisma/schema.prisma` (`AiProject` `:75`, `CodeRepo` `:156`, the
  "rebuildable-only" comment).
- **Sourcegraph docs** — configurable code-graph data retention policies, and a removed repository's data
  kept on disk against re-add: <https://sourcegraph.com/docs/code-search/code-navigation/explanations/uploads>
  and <https://docs.sourcegraph.com/admin/how-to/remove-repo>.
- **GitHub Marketplace terms** — the provider deletes the user's data _"within its defined window"_:
  <https://docs.github.com/en/site-policy/github-terms/github-marketplace-terms-of-service>.
- `notes.html` **#50** (a decision ships nothing), **#143** (a new affordance owes a design amendment),
  **#185** (enforcement in terms the product controls), **#206** (a method with no caller is not a path),
  **#223** (a deferral is a card filed in the same action — written about §11 of this file).
