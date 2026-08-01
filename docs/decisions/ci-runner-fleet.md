# What runs the runners — the CI runner fleet's orchestrator and its swappable interface

**Status:** accepted · **Date:** 2026-08-01 · **Card:** MOTIR-1918 (Story MOTIR-1916 — run
project CI on Motir's own ephemeral runner fleet) · **Evidence pinned at:** `motir-core`
`origin/main` @ `27f2f207`, `motir-ai` `origin/main` (`fly.toml`), `motir-gateway`
`origin/main` (`fly.toml`) · **Vendor pricing + docs read 2026-08-01** (sources in §12)

`docs/decisions/ci-minutes-allowance.md` §M fixes what a fleet runner must be _equivalent
to_ and closes with _"MOTIR-1918 decides what actually runs it."_ This is that decision. It
fixes **the orchestrator**, **the interface behind it**, **the per-runner cost record**,
**the boot-latency budget**, **the isolation posture for agent-authored customer code**, and
**the cost basis** the ×1.00 customer rate earns its margin against.

This is a `decision` card: it fixes shapes and ships no behaviour. Everything here is BUILT
by the other MOTIR-1916 cards, enumerated in §10. Per `notes.html` #50 — _a decision card is
not an implementation_ — nothing in this document is a precondition any sibling may assume
is present.

## §0 — Where this document lives, and why that was a real choice

The card offered two homes and refused to pre-commit: `motir-ai/docs/hosted-execution.md`
(if the answer is _reuse_) or a new `motir-core/docs/decisions/ci-runner-fleet.md` (if the
answer is a separate system). **It lands here, in `motir-core`, in one line:** the fleet's
webhook, admission gate, provisioner and cost meter all ship in `motir-core` (MOTIR-1920 /
1921 / 1922 / 1924), and `motir-ai/docs/hosted-execution.md` **does not exist** — it is
MOTIR-685's unwritten deliverable, and writing this decision into a document another unrun
card owns would make it unreadable until that card ships.

That second half is not a filing convenience. It is the first finding of this decision, and
§1 turns on it.

## §1 — The decision

**Motir operates the fleet itself on Fly Machines, in a SEPARATE Fly organization, behind a
`ContainerOrchestrator` port that `motir-core` owns (§4).** Candidate **A**, with one
correction to how the card framed it.

**The correction — the arrow points the other way.** The card describes A as _"reuse Epic
9's orchestrator."_ There is nothing to reuse. MOTIR-685 is `todo`, its parent Story
MOTIR-683 is `todo`, Epic 9 (MOTIR-673) is `todo`, and `motir-ai/docs/hosted-execution.md`
does not exist — verified by `git ls-tree origin/main -- docs/` on `motir-ai`, 2026-08-01.
Epic 9 is scheduled AFTER Story MOTIR-1916. So A-as-written is not available: reusing
MOTIR-685's orchestrator would make the fleet `blocked_by` an epic that has not started.

**The relationship to MOTIR-685, stated explicitly as the card requires: PARALLEL, AGAINST
THE SAME INTERFACE — with the fleet as the FIRST implementation.** This decision does not
wait on 685 and is not blocked by it. It fixes the container-provisioning primitive
(provision / teardown / usage) and 685 inherits it rather than choosing one. The split is
clean and neither card straddles it:

| Owned here (MOTIR-1918)                                         | Owned by MOTIR-685                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| The `ContainerOrchestrator` port + the Fly adapter (§4)         | The agent **run lifecycle** on top of it (`dispatched → … → teardown`)    |
| The per-container **usage record** and its fields (§5)          | The **`AgentRun`** record and the status/log events the 9.1.8 UI streams  |
| The **isolation posture** for agent-authored customer code (§7) | **Run-scoped auth** (short-lived, run-+-user-scoped) and the gateway wire |
| The **CI entrypoint** (`generate-jitconfig` → `run.sh`)         | The **agent entrypoint** and the `*_BASE_URL` injection matrix            |

**Binding on MOTIR-685: it adopts this port; it does not re-decide the orchestrator.** Its
own three questions (run lifecycle, run-scoped auth, gateway metering) are untouched and
remain its deliverable. If 685 later concludes a different provider suits agent runs, that is
a second _adapter_ behind the same port — which is precisely what §4 exists to make cheap,
and precisely why this decision is reversible.

**Why the choice is defensible even though it is also the convenient one.** Fly is already
Motir's container substrate (`motir-ai` and `motir-gateway` both ship a `fly.toml`, both in
`iad`), so A adds an adapter rather than a cloud. But convenience is not the argument — §2
and §3 are, and B and C each lose on an axis that has nothing to do with what Motir already
runs.

## §2 — A / B / C, compared on the six axes the card names

Every figure is from the vendor's own page, read 2026-08-01, and sourced in §12. Where a
number is third-party rather than vendor-direct it is **marked as such** — `notes.html` #88:
an aggregator is a discovery source, never the billing basis.

| Axis                                       | **A · Fly Machines (Motir-operated)**                                                                    | **B1 · RunsOn (your own AWS)**                                                            | **B2 · Managed fleet (Blacksmith / Depot / Namespace)**                                                    | **C · ARC on Kubernetes**                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Operational surface**                    | One new **adapter** on a substrate Motir already operates (two `fly.toml` apps, `iad`). No new cloud.    | A **new AWS account**: VPC, CloudFormation stack, AMI upkeep, spot-interruption handling. | Near zero — change `runs-on`, the vendor operates everything.                                              | A **Kubernetes cluster Motir does not have**, plus the operator, plus its upkeep.  |
| **Cost basis** (Linux-2-core-equivalent)   | **~$0.00195 / min** — `performance-2x` + 4 GB extra RAM, computed in §8 from Fly's published table.      | **~$0.0017 / min** at spot for their 4-CPU example, **plus €300–€3,600 / yr** licence.    | **$0.004 / min** (Blacksmith x64, vendor page); Depot **$0.004 / min**; Namespace ~$0.003 _(third-party)_. | Node compute + a managed control plane; no published per-minute rate.              |
| **Boot latency**                           | Create-and-boot **"maybe low double digit seconds"**; start a stopped Machine **"well under a second."** | EC2 spot launch, tens of seconds; RunsOn publishes no boot SLO.                           | Vendor-operated warm capacity; typically fastest, no published SLO.                                        | Pod schedule + image pull; fast with a warm node pool, slow on scale-out.          |
| **Tenant isolation**                       | **Firecracker microVM — hardware virtualization (KVM)**, per-Machine. Strongest of the four.             | EC2 instance per job — hardware isolation, also strong.                                   | Vendor's posture; not Motir's to assert.                                                                   | **Pod = shared kernel** by default. Needs gVisor/Kata added to reach A's posture.  |
| **Customer code on THIRD-PARTY infra?**    | **No.** Motir's own cloud account.                                                                       | **No.** The customer's — i.e. Motir's — own AWS account.                                  | **YES.** Users' code executes on a vendor's machines. A trust/ToS/DPA question, not procurement.           | **No.** Motir's own cluster.                                                       |
| **Spend ceiling — does it STOP or ALERT?** | **NEITHER.** Fly: _"We don't support billing alerts (yet)"_ and _"there's no soft ceiling."_ See §9.     | AWS Budgets **alerts**, Budget **Actions** can stop; service quotas are a real ceiling.   | Prepaid credit balances are a real hard stop for most vendors.                                             | Node-pool / autoscaler **max is a real hard ceiling** on capacity, hence on spend. |

## §3 — Why B and C lose, and where A genuinely loses

**B2 (managed fleets) is disqualified on the axis, not on the price.** These repositories
hold **users' code**, and MOTIR-1916's threat model is stronger still: the code is
**written by an AI agent** and the repo's own workflow file decides what executes. Sending
that to a third party is a data-processing commitment Motir would be making on its users'
behalf, in a product whose repository-ownership model (`project-repository-set.md`) users
already accept reluctantly. At **$0.004 / min** Blacksmith is also **~2× A's basis**, so
the trust question is not even bought with a saving. B2 is dominated on both axes at once.

**B1 (RunsOn on Motir's own AWS) is the strongest loser, and the honest runner-up.** It
keeps customer code on infrastructure Motir controls, it is marginally cheaper per unit of
CPU at spot, and — uniquely — it comes with a spend ceiling that actually binds (§9). It
loses on **operational surface**: it requires standing up an AWS account Motir does not
have, alongside Fly, Vercel and Neon, for one workload. Motir today operates **one**
container substrate; B1 makes it two, permanently, and puts spot-interruption handling on
the critical path of customer CI. **If A's cost basis or capacity ever binds, B1 is the
documented migration target** — and §4's port is what makes that a new adapter rather than a
re-plan.

**C (ARC) loses twice.** It presumes a Kubernetes cluster Motir does not run — the largest
operational surface of the four, for the smallest incremental benefit — and its default
isolation boundary is a **pod**, i.e. a shared kernel. Reaching A's posture for
agent-authored customer code means adding gVisor or Kata on top, which is _more_
infrastructure to buy back an isolation property A has for free. GitHub's own description —
_"a Kubernetes operator that orchestrates and scales self-hosted runners"_ — is accurate,
and it is exactly the part Motir does not want to own.

**Where A genuinely loses, stated rather than argued away.** Fly offers **no spending cap
and no billing alerts** (§9) — the single worst property of the chosen option, and the one
place where B1 and C are both better. This decision accepts it because the remedy is
required regardless (`notes.html` #185), not because the gap is small. §9 names the remedy
and gives it an owner.

## §4 — The interface: `ContainerOrchestrator`

The card calls this _"the single most load-bearing output: it is what makes this decision
reversible."_ It is specified here as a real signature, in `motir-core`, and **every sibling
card codes against the port — never against Fly.** Not one `fly` import outside the adapter.

```ts
// lib/orchestrator/types.ts — the PORT. No provider types cross this boundary.

export type OrchestratorProvider = 'fly' | 'runs_on' | 'arc' | 'fake';

/** What to run. Provider-neutral: no Fly Machine config, no EC2 instance type. */
export interface ContainerSpec {
  /** Attribution, resolved BEFORE provisioning (the gate needs it too). */
  readonly orgId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly repoFullName: string;
  /** The GitHub job this container exists to serve. One job, one container. */
  readonly workflowJobId: number;
  /** OCI image ref for the runner image (digest-pinned, never a tag). */
  readonly image: string;
  /** Linux-2-core-EQUIVALENT is fixed by ci-minutes-allowance.md §M. */
  readonly size: ContainerSize; // { cpuKind: 'performance'; cpus: 2; memoryMb: 8192 }
  /** Injected at boot; never baked into the image. */
  readonly env: Readonly<Record<string, string>>;
  /** Hard kill after this many seconds, whatever the container is doing. */
  readonly timeoutSeconds: number;
  readonly region: string;
}

/** An opaque, provider-agnostic reference. Persisted; survives a process restart. */
export interface ContainerHandle {
  readonly provider: OrchestratorProvider;
  readonly id: string; // Fly Machine id; EC2 instance id; pod name
  readonly region: string;
  readonly createdAt: Date;
}

export interface ContainerOrchestrator {
  readonly provider: OrchestratorProvider;

  /** Boot exactly one container. Throws a typed error; NEVER leaves an untracked container. */
  provision(spec: ContainerSpec): Promise<ContainerHandle>;

  /** Destroy it and RETURN what it cost. Idempotent: a second call on a destroyed
   *  container returns the same usage, never throws. */
  teardown(handle: ContainerHandle, reason: TeardownReason): Promise<ContainerUsage>;

  /** Provider-truth status, for the reaper and for diagnostics. */
  describe(handle: ContainerHandle): Promise<ContainerStatus>;

  /** The crash-safe sweeper: destroy every container this orchestrator owns that is older
   *  than `olderThan`, returning one usage record each. Called on a schedule. */
  reap(olderThan: Date): Promise<ContainerUsage[]>;
}

export type TeardownReason =
  | 'job_completed'
  | 'job_timed_out'
  | 'provision_failed'
  | 'gate_revoked'
  | 'reaped'; // the orchestrator crashed; the sweeper found it
```

**The one design decision inside this port that is not obvious, and is the point of it:
`teardown` and `reap` RETURN the usage record.** Metering is not a separate call a caller
can forget — **you cannot destroy a container without producing its cost row.** That is
`notes.html` #185 applied at the type level: the meter is built on a _physical_ quantity
emitted by the same operation that guarantees teardown, so the two cannot drift, and
MOTIR-1924's meter cannot be silently skipped by a path that tears down and returns early.

**Rules the port imposes on every sibling card:**

1. **No `fly` types, imports or ids above `lib/orchestrator/fly/`.** The webhook handler
   (MOTIR-1920), the gate (MOTIR-1922), the provisioner (MOTIR-1921) and the meter
   (MOTIR-1924) see `ContainerHandle` and `ContainerUsage` only.
2. **A `fake` adapter ships alongside the Fly one**, in the same PR as MOTIR-1921. It is
   what MOTIR-1927's Vitest gate drives — the boot / teardown / no-reuse / label-scoping
   guards are assertions about the PORT's contract, not about Fly.
3. **The per-second rate is NOT a constant in the adapter.** It comes from an
   effective-dated `(provider, size, region, effectiveFrom) → usdPerSecond` table mirroring
   `lib/ciMetering/runnerRates.ts` — so a Fly price change is a **new row**, never a code
   edit (§3.3's shape, and `notes.html` #185's "keep the commercial mapping in a dated
   policy table").

## §5 — The container-seconds record

This is what the cost meter consumes and what the fleet's own reconciliation audits (§Q of
`ci-minutes-allowance.md`). **Per runner, never aggregated at write time.**

```ts
export interface ContainerUsage {
  readonly handleId: string;
  readonly provider: OrchestratorProvider;
  readonly region: string;

  // Attribution — copied from the spec, so a row is readable without a join.
  readonly orgId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly repoFullName: string;
  readonly workflowJobId: number;

  // The machine class actually provisioned (may differ from requested on a fallback).
  readonly cpuKind: 'shared' | 'performance';
  readonly cpus: number;
  readonly memoryMb: number;

  // The physical quantity. Provider timestamps where available, ours otherwise.
  readonly createdAt: Date;
  readonly startedAt: Date | null; // null iff it never started (provision_failed)
  readonly stoppedAt: Date;
  readonly billableSeconds: number; // ceil(stoppedAt - startedAt); 0 when never started

  // The commercial mapping, resolved from the dated rate table at teardown.
  readonly usdPerSecond: string; // decimal string — never a float
  readonly costUsd: string; // billableSeconds × usdPerSecond
  readonly rateEffectiveFrom: Date; // WHICH row was applied

  readonly terminalState: string; // provider-reported
  readonly teardownReason: TeardownReason;
}
```

**Confirmed available on the chosen provider — the card requires this check BEFORE the
choice, not after.** Fly's Machines API returns `created_at`, `updated_at`, `state`, and an
`events` array that _"provide[s] log of what's happened with this Machine,"_ each event
timestamped — so `createdAt` / `startedAt` / `stoppedAt` are all provider-attested, not only
orchestrator-observed. Fly bills **per second on the named CPU/RAM preset**, so
`billableSeconds × usdPerSecond` is not an approximation of Fly's own basis — **it is Fly's
own basis**, which is what makes the fleet's monthly reconciliation (§Q) a real audit rather
than a comparison of two estimates.

**Where it persists:** a new workspace-scoped `motir-core` table — `workspace_id` + RLS per
the shipped contract, the same shape as MOTIR-1896's meter table. **The schema is
MOTIR-1924's deliverable; the FIELDS are fixed here** so the meter, the reconciliation and
the margin readout cannot each invent their own.

**Written at teardown, in the same unit of work.** `teardown()` returns the usage; the caller
persists it. A `reaped` row is written by the sweeper. **A container with no usage row is a
bug with a name** — MOTIR-1927 asserts the invariant directly: for every provisioned handle,
exactly one usage row.

## §6 — Boot-latency budget and burst behaviour

**The target: p50 ≤ 30 s, p95 ≤ 60 s**, measured from receipt of the `workflow_job.queued`
webhook to the job's GitHub-reported `started_at`.

Composed from the published numbers rather than asserted:

| Stage                                                  | Budget                      | Basis                                                                          |
| ------------------------------------------------------ | --------------------------- | ------------------------------------------------------------------------------ |
| Webhook receipt → gate decision (MOTIR-1920 / 1922)    | ≤ 2 s                       | One locked read; no external call.                                             |
| `POST /orgs/{org}/actions/runners/generate-jitconfig`  | ≤ 1 s                       | One GitHub API call.                                                           |
| Fly Machine create + boot (image fetch, rootfs, start) | 10 – 25 s                   | Fly: _"maybe low double digit seconds"_ from `created` to `started`.           |
| Runner registration + GitHub job assignment            | 5 – 15 s                    | Runner start-up plus GitHub's assignment loop.                                 |
| **Total**                                              | **≤ 30 s p50 / ≤ 60 s p95** | The bar is **parity with GitHub-hosted**, whose own assignment is not instant. |

**What the SLO does and does not cover — state this or it is unmeasurable.** The budget
applies to a job the admission gate **ADMITTED**. A job the gate **DEFERRED** (project at
its in-flight cap, or `ci_credits_exhausted`) is out of scope by construction: deferral is
the fairness mechanism working, and folding it into the latency number would make the fleet
look slow precisely when it is behaving correctly.

**Burst.** GitHub's ceilings are not the binding constraint: **1,500 runner registrations
per 5 minutes** per org (≈ 5/s) and **10,000 runners per runner group** sit roughly two
orders of magnitude above the fleet's need. **The binding constraint is Motir's own
admission gate, deliberately.** When demand exceeds it, jobs **stay queued at GitHub** —
where a job may sit for **24 hours before it is automatically cancelled**, which is the
outer bound the gate must never approach. MOTIR-1922 owns the cap; this document fixes that
the cap, not the provider, is what limits the ramp.

**If the measured p95 misses the target, the documented escape hatch is a COLD-SPARE POOL —
and it is not a warm pool.** Fly starts a **stopped** Machine in _"well under a second."_ A
small pool of Machines held in `created`/`stopped` — **built from the runner image, never
started, never registered with GitHub, never given a job, never touched by customer code** —
converts the 10–25 s create leg into a sub-second start. The distinction that makes it
permissible is exact and §7.2 restates it as a rule: **a spare that has never executed a job
is byte-identical to a fresh one; a machine that HAS executed one is destroyed and never
reused for anything.** Cost of holding spares is rootfs only — **$0.15 per GB per 30 days**.
**This is an escape hatch, not the initial build:** MOTIR-1928 measures the real p95 first,
and the pool is justified by a number or not built.

## §7 — Tenant isolation, restated for agent-authored customer code

MOTIR-685's threat model is _Motir controls the prompt_. **This one is stronger: the repo's
own workflow file decides what executes, and an AI agent wrote it.** The card asks for the
posture to be stated as what is **FORBIDDEN**, not only what is required. Seven rules; each
is testable, and MOTIR-1927 owns the tests coverage cannot see.

**§7.1 — No runner that has executed a job is ever reused. For anything.** Not for a re-run,
not for a retry, not for another job in the same repository. Mechanism, three independent
guarantees so no single failure leaks a container:

- `config.sh --ephemeral` (or a JIT config, §7.4) — the runner takes exactly one job,
  de-registers, exits.
- Fly `auto_destroy: true` — _"the Machine destroys itself once it's complete"_ — with
  `restart: { policy: 'no' }`, so an exiting process is a destroyed Machine, not a restarted
  one.
- `reap(olderThan)` (§4) on a schedule — the backstop for the case the other two cannot
  cover: **the orchestrator itself crashed** between provision and teardown.

**§7.2 — No warm pool.** A pre-created Machine may sit in `created`/`stopped` (§6) —
**never started, never registered, no job, no customer code**. The instant it starts a job
it is single-use and §7.1 applies. There is no state in between and no "reuse if the job was
clean" branch.

**§7.3 — No org-wide runner group. One runner group PER MOTIR PROJECT, access-listed to
exactly that project's repositories.** GitHub supports it directly: _"You can configure a
runner group to be accessible to a specific list of repositories, or to all repositories in
the organization."_

**This is load-bearing for correctness, not only for isolation, and the reason is worth
stating plainly.** `runs-on` resolves to a static label (§N's `vars.MOTIR_RUNNER`), so every
fleet runner in an org-wide group matches every queued fleet job in the org. A runner
Motir booted **for project X** would be picked up by **project Y's** queued job — including
a job the admission gate **DECLINED**. That makes MOTIR-1922's gate **advisory**: a tenant
at its cap, or at `ci_credits_exhausted`, would still get CI, paid for by another tenant's
provisioning decision, and metered to the wrong org. Per-project groups close it at the
platform level rather than by hoping the race does not happen.

> **Honest unknown, named rather than assumed** (following §M's precedent). GitHub documents
> **10,000 runners per group** but publishes **no limit on the number of runner GROUPS per
> organization** — and one group per project means thousands. **MOTIR-1919 must establish
> the real limit** (docs or support) before the fleet scales, and record it. **The fallback,
> if a group ceiling binds, needs no new machinery:** `MOTIR_RUNNER`'s value becomes
> **per-project**, set at the **repository** level, which overrides the org-level value —
> GitHub's documented variable precedence, already relied on by §N. Label-per-project then
> gives the same guarantee without groups.

**§7.4 — No long-lived registration token inside the container. Use JIT configuration.**
`POST /orgs/{org}/actions/runners/registration-token` returns a token that _"expires after
one hour"_ and can register **any** runner in the org — handing it into a container that
will execute customer code is handing over an org-wide registration capability for an hour.
**`POST /orgs/{org}/actions/runners/generate-jitconfig` is strictly better**: the
orchestrator mints it, it names the **`runner_group_id`** (so §7.3's scoping is applied at
mint time) and the **labels**, and it is _"passed to the runner application at startup"_ —
one runner, one config, no registration capability inside the container. **Binding on
MOTIR-1919 and MOTIR-1921:** the org permission is still `Self-hosted runners: write`, but
the credential that reaches the container is a JIT config, never a registration token.

**§7.5 — The fleet runs in a SEPARATE Fly ORGANIZATION from `motir-ai` and
`motir-gateway`.** This is the finding that most changes the shape of candidate A, and it is
not optional. Fly's private networking is **organization-scoped and on by default**:
_"Private networking over your 6PN is always available to apps by default; you don't have to
do anything special to get it"_, and _"applications from other organizations can't [talk to
each other] … The Fly.io platform won't forward packets between different 6PNs."_

Provisioning the fleet inside Motir's existing Fly org would place **every customer's CI
container on the same private network as `motir-ai` and `motir-gateway`**, reachable over
`.internal` with no authentication step in between — customer code, inside Motir's own
production network, by default. A separate organization is the platform's own isolation
boundary, and it buys two more things for free: a **separate invoice**, which is the cost
boundary §9 budgets against, and blast-radius containment for anything the fleet does wrong.
(Fly's per-tenant _custom private networks_ are the finer-grained mechanism —
_"useful when you need to isolate tenants or users for security purposes"_ — and remain
available inside the fleet org if per-project network isolation is ever wanted.)

**§7.6 — No host filesystem, no Docker socket, filesystem confined to the run workspace.**
Inherited verbatim from MOTIR-685's posture and from the 7.9.7 local sandbox. A Firecracker
microVM gives this by construction — **hardware virtualization via KVM**, not a shared
kernel — which is the isolation property C would have to buy back with gVisor or Kata.

**§7.7 — The egress policy is a DENY-LIST, and the honest reason is that an allow-list
cannot work here.** MOTIR-685's agent runs can be egress-**locked** to the 9.0 gateway
because Motir controls what they do. **CI cannot be**: a real build reaches npm, PyPI, apt,
Docker Hub, Playwright's browser CDN, the preview database, the deploy target — an
allow-list would break customer CI on its first uncommon dependency, and a policy that gets
disabled is worse than one that was never claimed. What IS required, and what §7.5 delivers
structurally rather than by configuration:

- **Deny** the Fly 6PN / `.internal` namespace of Motir's production organization — the
  separate org means there is nothing to configure; the packets are not forwarded.
- **Deny** the production Neon endpoints and `motir-ai` / `motir-gateway` public endpoints
  at the network level from the fleet org.
- **Allow** the public internet otherwise, and treat the container as hostile throughout —
  which is what §7.1–§7.6 already assume.

## §8 — Capacity and cost model, with the numbers computed

**The runner spec is fixed by `ci-minutes-allowance.md` §M: Linux-2-core-EQUIVALENT**, because
the ×1.00 multiplier is a **parity promise**, not a measurement of whatever hardware is
convenient. GitHub's `ubuntu-latest` on a **private** repository is **2 vCPU, 8 GB RAM, 14 GB
SSD** — that is the thing to be equivalent to, and the private-repo row is the right one
because every Motir-created repository is private.

**The mapping onto Fly, and its price** (published table, Amsterdam shown; a per-region ratio
applies and **MOTIR-1924 must read the `iad` row from the same table**):

| Component                                 | Fly price                          | Per minute           |
| ----------------------------------------- | ---------------------------------- | -------------------- |
| `performance-2x` (2 dedicated vCPU, 4 GB) | $0.00002484 / s                    | $0.00149040          |
| + 4 GB RAM to reach 8 GB                  | ~$5 / GB / 30 days → $20 / 30 days | $0.00046296          |
| **Fleet runner, all-in**                  |                                    | **≈ $0.00195 / min** |

**`performance`, not `shared`, and the reason is a product reason.** `shared-cpu-4x` + 8 GB
would cost roughly half. But the customer is metered on **wall clock** (§3, §5.8), so a
runner that suffers CPU steal costs the customer **more billed minutes** _and_ costs Motir
**more container-seconds** — the same slowdown paid for twice, once by the tenant's
allowance and once by Motir's invoice. On a wall-clock-metered product a slow runner is
strictly worse than a proportionally dearer fast one. Dedicated vCPU is also what "2-core
equivalent" honestly means.

**The margin, now a computed number rather than an estimate** (which is the whole point of
AC 6):

| Quantity                                      | Value                                         |
| --------------------------------------------- | --------------------------------------------- |
| Retail — 1 credit = 1 Linux-equivalent minute | ~**$0.01** / min (§2, §L, shipped)            |
| Cost — GitHub-hosted Linux 2-core             | **$0.006** / min → ~40% gross margin (§2.2)   |
| Cost — the fleet on Fly                       | **~$0.00195** / min → **~80.5% gross margin** |
| Improvement over GitHub-hosted                | **~3.1×**                                     |

> **⚠️ This CORRECTS §L's margin note, and the correction is material.** §L records the
> fleet's basis as _"roughly $0.0005–0.001/min on spot compute — a 6–12× lower cost basis."_
> **Fly is not spot compute and does not price like it.** The real basis on the chosen
> provider is **~$0.00195/min — 2–4× §L's estimate**, and the improvement is **~3.1×, not
> 6–12×**. §L's **decision** is untouched: the customer-facing numbers still do not re-open,
> and re-opening §1 still needs its own card and should still wait on MOTIR-1924 making the
> margin a measurement. What changes is that the margin note now cites a provider price
> instead of a category. `notes.html` #88 in its general form: a category estimate ("spot
> compute is cheap") is a discovery source, never the basis.

**What the allowance costs Motir in COGS**, which nothing has computed before:

- Included allowance, per seat: 300 min × $0.00195 = **$0.59 / seat / month** (was **$1.80**
  on GitHub-hosted).
- Per-org floor: 1,000 min × $0.00195 = **$1.95 / org / month** at full consumption.
- One mature-project run (`motir-core`'s 141.6 job-minutes, §J) = **$0.28** of fleet compute
  — versus **$0.85** GitHub-hosted. `motir-core` itself stays GitHub-hosted (§J); the figure
  is the shape of the heaviest plausible customer workload.

## §9 — The spend ceiling: Fly offers NEITHER a cap NOR an alert

MOTIR-1916 added this as a **selection criterion**: _"can this option's spend be hard-capped,
and does the cap STOP work or merely ALERT?"_ Asked of the chosen provider, the answer is the
worst of the four, and it is quoted rather than characterised:

> _"We don't support billing alerts (yet), so budget accordingly."_ — Fly cost-management docs
>
> _"Free allowances don't cap your bill. … But there's no soft ceiling. If you go over, we'll
> bill you."_ — same page

**So MOTIR-1935 cannot do what its title says.** It is titled _"Set the FLEET's provider-side
SPENDING CAP + alerts"_ and is `blocked_by` this card precisely because no provider account
existed to budget until this decision landed. The account now exists (a separate Fly org,
§7.5) and **it has no cap and no alert to set.** That is this decision's answer to that card,
and it is recorded here rather than discovered by whoever runs it.

**The remedy, and why it is the right one regardless.** `notes.html` #185 is the lesson this
exact situation produced: _"Express enforcement in terms the product controls, not in the
provider's billing controls … if we changed provider tomorrow, what would still stop the
spend?"_ A vendor cap would have been the cheapest thing to reach for and the most expensive
to have chosen. A provider-side kill would also be indiscriminate — it stops every tenant's
in-flight CI at once, which is not a behaviour Motir would want even if Fly offered it.

**The binding ceiling is therefore PRODUCT-SIDE, and it goes where the decision already
is:**

1. **A FLEET-WIDE in-flight ceiling, in MOTIR-1922's gate.** That card already owns a
   **locked** admission decision made **before a runner boots** (per-project cap +
   `ci_credits_exhausted`). A global counter is **one more check in the same lock, the same
   transaction, the same tests** — so it belongs there, not in a new card. Splitting it out
   would put two cards on one write, which is `notes.html` #187's exact shape. MOTIR-1922 is
   amended in place accordingly (§10).
2. **A spend TRIPWIRE off the container-seconds meter (§5), not off Fly.** MOTIR-1924's rows
   already carry `costUsd` per runner; a rolling month-to-date sum over the fleet org is a
   read Motir owns, on a physical quantity, that survives a provider change. It **alerts** —
   §1's ceiling is what **stops**.
3. **MOTIR-1935 needs no re-scope — it already anticipated this branch**, and it deserves the
   credit: its last acceptance criterion reads _"If the chosen provider offers **no**
   enforceable spend ceiling, that is recorded plainly along with the compensating control
   actually put in place … never left as 'we'll watch the dashboard'."_ What this decision
   supplies is its step 1 — the answer. **Fly is the account; there is no cap and no alert;
   the compensating control is §9.1's fleet-wide ceiling.** What remains for a human is real
   and short: create the separate Fly organization (§7.5), put it on its own payment method,
   record the month-to-date figure to watch and its named owner, and record — as MOTIR-1908
   did for the $0 GitHub budget — **what Fly actually does when spend runs away, from
   observation rather than from the docs' silence.**

## §10 — Binding on MOTIR-1916's cards

The test of this document is that none of these needs a further question. Where a card's
stated scope is changed rather than merely detailed, it says **AMENDED**.

- **MOTIR-1919 (manual — the org permission + runner group). AMENDED.** The permission stays
  `Self-hosted runners: write` at the **organization** level (§O, §R of the parent ADR). Two
  changes: **(a)** the credential the container receives is a **JIT config**, not a
  registration token (§7.4) — the permission is the same, the usage is not; **(b)** there is
  **no single org-wide runner group**. Groups are **per project**, access-listed to that
  project's repositories, and created **programmatically at repository provisioning**, not by
  hand (§7.3). What stays manual and human: granting the org permission, approving it on the
  installation, and **establishing GitHub's limit on the number of runner groups per
  organization** — §7.3's named unknown, with the per-repo-`MOTIR_RUNNER` fallback if it
  binds.
- **MOTIR-1920 (the `workflow_job` queued handler).** Unchanged in scope; label-scoped per
  §O. It emits a provisioning **intent** carrying the full attribution `ContainerSpec` needs
  (§4) — org, workspace, project, repo, `workflowJobId` — because the gate and the usage row
  both need it and neither can join for it later. It still owns recording whether the jobs
  API's `labels` reports requested or runner-side labels (§M's honest unknown).
- **MOTIR-1921 (provision + tear down one ephemeral runner).** Builds `lib/orchestrator/`:
  the **port** (§4), the **Fly adapter**, and the **`fake` adapter in the same PR**. Boots
  with `auto_destroy: true` + `restart: no` + a JIT config + `--no-default-labels` and the
  single §M-compliant label. Owns `reap()` and its schedule. **No `fly` type escapes the
  adapter directory.** The per-second rate comes from the dated table, never a constant.
- **MOTIR-1922 (the provisioning gate). AMENDED — it gains the FLEET-WIDE ceiling.** The same
  locked, pre-boot decision now answers three questions, not two: the per-project in-flight
  cap, `ci_credits_exhausted`, **and a global in-flight ceiling across the whole fleet**
  (§9.1). This is the only thing that bounds Motir's total CI spend, because the provider
  bounds nothing. Per-project caps multiply by an unbounded project count; the global one
  does not.
- **MOTIR-1923 (price the fleet family).** Unchanged, and now supplied with the number it was
  missing: the row's `usdPerMinute` — **Motir's own cost, deliberately not a ratio of its own
  ×1.00 multiplier** — is **~$0.00195**, from §8, sourced to Fly's published table with the
  region caveat.
- **MOTIR-1924 (meter what the fleet costs + re-scope the reconciliation).** Persists
  `ContainerUsage` (§5) — **fields fixed here, schema its own** — workspace-scoped with RLS.
  Owns the effective-dated `(provider, size, region)` rate table and **must read the `iad`
  row** rather than inherit §8's Amsterdam figures. Adds the month-to-date spend tripwire
  (§9.2). Re-scopes §5.8's audit to GitHub-billed rows and audits fleet rows against Fly's
  own invoice for the fleet org — which §7.5 makes a **clean, single-purpose invoice** rather
  than a line item to disentangle.
- **MOTIR-1927 (the Vitest gate).** Drives the **`fake` adapter**, so the guards are
  assertions about the port: **(a)** exactly one usage row per provisioned handle, always,
  including `provision_failed` and `reaped`; **(b)** no reuse — a handle that reached
  `job_completed` is never provisioned again; **(c)** label scoping — a GitHub-hosted
  `workflow_job` provisions nothing; **(d)** the gate is consulted **before** provision on
  all three limbs, including the new fleet-wide ceiling, under **real concurrency** (the
  global counter is a contended read-derived write — lock it, and mutation-check the lock);
  **(e)** teardown is idempotent.
- **MOTIR-1928 (live E2E verification). EXTENDED.** Two measurements this document needs and
  cannot make: the **real p50/p95 boot latency** against §6's budget (which decides whether
  the cold-spare pool is ever built), and **which labels the jobs API reports**. It should
  also confirm a job for project X is **not** picked up by a runner booted for project Y —
  §7.3's failure mode, which is silent when it happens.
- **MOTIR-1935 (manual — the spend bound). ANSWERED, not re-scoped — see §9.3.** Its step 1 is
  _"read MOTIR-1918's outcome and enumerate every account the fleet actually bills to"_, and
  its last criterion already covers a provider with no enforceable ceiling. The answer:
  **one account (the fleet's own Fly organization), no cap, no alert**; the compensating
  control is §9.1's fleet-wide ceiling. What remains: create that organization (§7.5), its own
  payment method, the named owner, the figure to watch, and an **observation** of Fly's
  behaviour under runaway spend.
- **MOTIR-685 (Epic 9's hosted-execution decision). CONSTRAINED, not re-scoped.** It adopts
  `ContainerOrchestrator` (§4) rather than choosing an orchestrator; its own three questions —
  run lifecycle, run-scoped auth, gateway metering — are untouched and remain its deliverable
  (§1).

## §11 — What is deliberately NOT decided here

So nobody reads silence as an answer:

- **The runner IMAGE's contents.** This document fixes that the image is digest-pinned and
  that the entrypoint is `generate-jitconfig` → `run.sh`. What toolchain it carries is the
  starter's business and MOTIR-1921's, and it should be derived from what the two starters'
  workflows actually install.
- **Whether the cold-spare pool is built.** §6 specifies it, MOTIR-1928 measures whether it
  is needed. Building it before the measurement would be optimising against a number nobody
  has.
- **Multi-region.** The fleet runs in **`iad`**, co-located with Neon and `motir-core`, for
  the same reason `motir-ai`'s region was corrected to `iad` (MOTIR-1007). A second region is
  a capacity or latency decision nothing has yet forced.
- **Whether §1's allowance is re-derived from the corrected basis.** §L says not now; §8
  changes the number in that note but not the decision, and re-opening §1 still needs its own
  card.
- **Migrating to B1 (RunsOn on Motir's own AWS).** §3 records it as the documented runner-up
  and the migration target if A's cost or capacity binds. §4's port is what makes that an
  adapter. Nothing here schedules it.
- **What happens to a job whose runner is reaped mid-execution.** `reap()` destroys the
  container; GitHub sees the runner vanish and fails the job. Whether Motir re-queues,
  surfaces it, or leaves it to the user's re-run is a product question for the fleet's
  operational story, not for this document.

## §12 — Sources (read 2026-08-01)

**GitHub:**

- Actions runner pricing — Linux 2-core `$0.006`/min; _"GitHub Actions usage is free for
  self-hosted runners"_:
  <https://docs.github.com/en/billing/concepts/product-billing/github-actions>
- GitHub-hosted runner specs — `ubuntu-latest` **private** repos: **2 vCPU / 8 GB / 14 GB
  SSD**; public: 4 / 16 / 14:
  <https://docs.github.com/en/actions/reference/runners/github-hosted-runners>
- Actions limits — _"1500 runners / 5 minutes / repository/org/enterprise"_, **10,000 runners**
  per group, _"A job can be in the queue for 24 hours before it is automatically cancelled"_,
  5-day max job execution: <https://docs.github.com/en/actions/reference/limits>
- Managing access with runner groups — _"You can configure a runner group to be accessible to
  a specific list of repositories, or to all repositories in the organization"_:
  <https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/manage-access>
- Self-hosted runners REST — `POST /orgs/{org}/actions/runners/registration-token`
  (_"The token expires after one hour"_) and
  `POST /orgs/{org}/actions/runners/generate-jitconfig` (_"Generates a configuration that can
  be passed to the runner application at startup"_; takes `runner_group_id`, `labels`):
  <https://docs.github.com/en/rest/actions/self-hosted-runners>
- Actions Runner Controller — _"a Kubernetes operator that orchestrates and scales self-hosted
  runners for GitHub Actions"_:
  <https://docs.github.com/en/actions/concepts/runners/actions-runner-controller>
- **2026 Actions pricing changes** — GitHub-hosted prices reduced _"by up to 39%"_ effective
  2026-01-01, and the announced **$0.002/min self-hosted "Actions cloud platform" charge is
  POSTPONED**: _"We're postponing the announced billing change for self-hosted GitHub Actions
  to take time to re-evaluate our approach"_ (2025-12-15):
  <https://github.com/resources/insights/2026-pricing-changes-for-github-actions>
  > **⚠️ A named risk on every self-hosted option, A / B / C alike.** A reinstated
  > $0.002/min would add **~100%** to A's $0.00195 basis and land on **managed providers
  > too**. It changes no ranking in §2 — it is a common-mode cost, and the fleet would still
  > beat GitHub-hosted — but MOTIR-1924's rate table is where it would be absorbed, as a new
  > effective-dated row. Re-check before any re-pricing of §1.

**Fly.io:**

- Resource pricing — `performance-2x` (2 dedicated CPU, 4 GB) at **$0.00002484/s**;
  `shared-cpu-*` presets; _"about $5 per 30 days per GB of additional RAM"_; stopped-Machine
  rootfs at **$0.15 per GB per 30 days**: <https://fly.io/docs/about/pricing/>
- Cost management — _"We don't support billing alerts (yet), so budget accordingly"_ and
  _"there's no soft ceiling. If you go over, we'll bill you"_:
  <https://fly.io/docs/about/cost-management/>
- Machines overview — create-to-`started` _"maybe low double digit seconds"_; starting a
  stopped Machine _"[u]sually … well under a second"_; Machines _"[s]top automatically when a
  program exits"_: <https://fly.io/docs/machines/overview/>
- Machines API — `auto_destroy` (_"If true, the Machine destroys itself once it's complete"_),
  `restart` policy `no`/`on-failure`/`always`, `guest.cpu_kind`/`cpus`/`memory_mb`,
  `metadata`, and the `events` array (_"provide log of what's happened with this Machine"_)
  with `created_at` / `updated_at` / `state`:
  <https://fly.io/docs/machines/api/machines-resource/>
- Machine states — `created` / `started` / `stopped` / `suspended` / `destroyed` and the
  transient states: <https://fly.io/docs/machines/machine-states/>
- Private networking — _"Private networking over your 6PN is always available to apps by
  default"_; _"applications from other organizations can't [reach each other] … The Fly.io
  platform won't forward packets between different 6PNs"_; custom private networks are
  _"useful when you need to isolate tenants or users for security purposes"_:
  <https://fly.io/docs/networking/private-networking/>
- Firecracker — hardware-virtualized microVMs on KVM, marketed for _"multi-tenant platform[s]
  that run untrusted or user-generated code"_: <https://fly.io/learn/firecracker-vm/>

**Managed / self-hosted runner providers:**

- **RunsOn** — flat annual licence _"from €300 / year"_ (Starter) to _"€3,600 / year"_
  (Enterprise), free for non-commercial; _"You pay AWS directly for compute at spot prices —
  no per-minute markup"_; their own comparison quotes a 4-CPU runner at **$0.0017/min** vs
  GitHub's $0.0120/min: <https://runs-on.com/pricing/>
- **Blacksmith** — **$0.004/min** Ubuntu x64, **$0.0025/min** Ubuntu ARM, 3,000 free min/mo:
  <https://www.blacksmith.sh/pricing>
- **Depot** — GitHub Actions runners, **$0.004/min** overage, usage tracked by the second:
  <https://depot.dev/docs/github-actions/overview>
- **Namespace** — credit-based (1 credit = $0.015; compute units of 1 vCPU + 2 GB · minute).
  _The ~$0.003/min figure in §2 is a **third-party** comparison, not re-derived from
  Namespace's own credit model_ — flagged per `notes.html` #88. It changes nothing: B2 is
  disqualified in §3 on the third-party-infrastructure axis, not on price:
  <https://namespace.so/pricing>

**Shipped Motir, read at the pinned SHAs:**

- `docs/decisions/ci-minutes-allowance.md` — §2 (the rate), §2.2 (~40% margin), §3.3/§3.4
  (the effective-dated rate table and the unpriced fallback), §J (scope + the 141.6-job-minute
  measurement), §L (the margin note **corrected by §8**), §M (Linux-2-core-equivalence, the
  label constraints, the honest unknown), §N (`vars.MOTIR_RUNNER` and variable precedence),
  §O (label scoping and the `isMeta`/`moooon-B-V` axis trap), §P (the two meters), §Q (the
  re-scoped reconciliation).
- `motir-ai/fly.toml`, `motir-gateway/fly.toml` — Fly is Motir's existing container substrate,
  both in `iad`; the reason §7.5's separate organization is a change and not the status quo.
- `motir-ai` `origin/main` `docs/` — **`hosted-execution.md` does not exist**; §0 and §1 turn
  on this.
- `notes.html` #50 (a decision card is not an implementation), #88 (vendor-direct price over a
  category or an aggregator), #181 (a decision's un-owned answer is invisible — §9.3 and §10
  give every answer a card), #185 (express enforcement in what the product controls; prefer
  the physical quantity with a dated commercial mapping — §4, §5, §9), #187 (two cards must
  not own one write — §9.1 amends MOTIR-1922 rather than adding a card).
