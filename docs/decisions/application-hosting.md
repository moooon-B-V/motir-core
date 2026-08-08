# Where motir-core runs — Fly.io, one process, and what the move costs

- **Status:** Accepted (2026-08-07, drafted for Story MOTIR-2384 per the
  decision-subtask ladder). This is the rung-1 record every other card in that
  Story reads. **No application behaviour ships in this subtask** — it writes
  this file and amends `attachment-access-control.md`, and changes no code, no
  workflow and no config.
- **Story / Subtask:** MOTIR-2384 (Move motir-core's hosting from Vercel to Fly)
  · Subtask MOTIR-2385.
- **Consumed by:** MOTIR-2386 (provisioning), MOTIR-2387 (the runtime),
  MOTIR-2388 (the app-URL contract), MOTIR-2389 (the blob store), MOTIR-2390
  (CI), MOTIR-2391 (the database account), MOTIR-2392 (cutover), MOTIR-2393
  (deleting the abandoned path), MOTIR-2394 / MOTIR-2395 (the Story's tests),
  MOTIR-2396 (retirement).
- **Builds on:** the incident MOTIR-2371 (production deploys failing in Vercel's
  "Deploying outputs" phase) and the spike MOTIR-2383 (`spike/fly-standalone`,
  PR #1922), which measured the alternative rather than arguing it.
- **Amends:** `attachment-access-control.md` — see its **Amendment 2
  (2026-08-07)**, which this record forces and Q2 below decides.
- **Supersedes / superseded by:** nothing. Twenty-four decision records exist in
  this directory and none of them says where the application runs; this is the
  first.

> Convention (set by `work-item-type-taxonomy.md`, followed by
> `billing-tiering.md` / `attachment-access-control.md`): a decision record is a
> markdown file under `docs/decisions/`, structured **Status → Context →
> Decision → Consequences**, with load-bearing facts pinned in explicit tables.
> The numbered-**Q** section shape and the per-Q rejected-alternatives table are
> `public-api-conventions.md`'s (Amendments 9–11).

---

## The problem

**Production deploys fail, and no configuration fixes them.** MOTIR-2371's builds
succeed and then die in Vercel's "Deploying outputs" phase. The cause is
structural rather than a misconfiguration: **Vercel packages one serverless
function per route**, each carrying its own traced copy of everything it
imports, so Prisma's 4.9 MB WASM query compiler is staged **490 times** into a
`/tmp` partition that Vercel support confirmed is a fixed infrastructure default
— not a function of the machine tier, and not a knob.

Eight levers were tried against it. Each was **measured**, and the numbers are in
Q1 below because their whole value is that nobody re-runs them. Six returned
exactly zero. The two that returned something asked for a change we were not
willing to make in exchange.

So the question this record answers is not "which flag" but **where the
application runs**, and the second-order questions that answer forces: what
happens to the blob store, to the three platform-injected URL variables, to
per-pull-request preview environments, and to the order of the pipeline.

---

## §1 — The decisions, in one table

| #      | Question                                 | Decision                                                                                                 |
| ------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Q1** | Where does motir-core run?               | **Fly.io**, as ONE long-running process (`output: 'standalone'`), org `moooon`, region `iad`             |
| **Q2** | What replaces Vercel Blob?               | **Tigris**, S3-compatible, **two buckets** (public assets / private content); S3 presigned URLs          |
| **Q3** | What replaces the three `VERCEL_*` URLs? | **`MOTIR_BASE_URL`**, one variable, one accessor (`lib/baseUrl.ts`), two-rung precedence                 |
| **Q4** | Do per-PR preview environments survive?  | **No. They are DROPPED** — a decision, with what is lost and what reverses it recorded                   |
| **Q5** | What is the pipeline order?              | Existing gates FIRST, deploy after, Inngest sync as a failing step, verification read from the PLATFORM  |
| **Q6** | How many machines, and who creates them? | **2**, created by `fly scale count 2` — an operator action, owned by MOTIR-2386, never by `fly.toml`     |
| **Q7** | Is static-asset egress fronted by a CDN? | **No**, for now — the app serves its own static output at $0.02/GB, accepted explicitly with a trigger   |
| **Q8** | What does the move NOT change?           | The database engine, migrations, Inngest, the E2E suite, the 4-layer convention, motir-ai, motir-gateway |

---

## §2 — Q1: where motir-core runs

### The decision

**motir-core runs on Fly.io as a single long-running Node process**, built by a
multi-stage `Dockerfile` from Next's `output: 'standalone'` artifact, in the Fly
org that already holds `motir-ai` — **`moooon`** — primary region **`iad`**
(Ashburn) — the same region as motir-ai and as the Neon database.

`output: 'standalone'` is the load-bearing half. Next traces the app **once** and
emits one server in which every route shares one process and one `node_modules`,
so a heavy dependency is resident once instead of copied per route. That is not
a smaller version of the failure; **the failure has no analogue.**

### What was measured

| Measurement                                   | Vercel                                 | Standalone on Fly        |
| --------------------------------------------- | -------------------------------------- | ------------------------ |
| Deployable artifact                           | **4,240 MB** traced across 490 bundles | **374 MB** + 7 MB static |
| Copies of Prisma's 4.9 MB WASM query compiler | **490**                                | **1**                    |
| Ratio                                         | —                                      | **11× smaller**          |

The server was **booted**, not merely built — a build proves compilation, only a
boot proves the process model. It served `/sign-in`, `/docs/api`, `/docs/sandbox`
and `/explore` at HTTP 200 (MOTIR-2383).

Two findings from the spike are carried into MOTIR-2387 because they are the kind
that cost a day if rediscovered:

- **`HOSTNAME=0.0.0.0` is mandatory and fails silently.** Next's standalone
  server binds the _container hostname_ by default. The process logs `✓ Ready`,
  looks healthy, and nothing outside can reach it. On a first deploy it presents
  as a networking problem.
- **222 MB of the 374 MB is the `design/` tree**, pulled in by a single trace
  (`instrumentation.js.nft.json` references 324 design files).
  `outputFileTracingExcludes` does **not** remove it — verified with a clean
  rebuild. Harmless, but the real runtime payload is nearer **150 MB**.

  **Corrected 2026-08-07 (MOTIR-2403) — the cause, and it is not harmless.** The
  observation above is right and its explanation was missing, which let the
  config keep a key that read as a solution. `outputFileTracingExcludes` and
  `outputFileTracingIncludes` are consulted in exactly one module,
  `next/dist/build/collect-build-traces.js`, and `next/dist/build/index.js`
  invokes it behind `if (bundler !== Bundler.Turbopack && …)`. Next 16 builds
  with **Turbopack**, so the module never runs and **neither key has any effect
  in this repo** — for the standalone artifact here and, by the same guard, for
  the per-function traces on Vercel (which is why the table below measured a
  zero for it). Re-measured at `origin/main`: `.next/standalone` = **381 MB**,
  every excluded directory still present.

  It stopped being harmless when the artifact became an image every Fly machine
  pulls. The pruning therefore moved to a step that demonstrably prunes — a
  guarded `rm -rf` in the **builder** stage of the `Dockerfile`, before the
  runner copies the output (a prune after the `COPY` deletes nothing from the
  image; the bytes are already in that layer). Measured: **381 MB → 135 MB**,
  with `/sign-in`, `/docs/api`, `/docs/sandbox`, `/explore` and the `/explore`
  OG card all still served at 200 from the pruned output. `next.config.ts` no
  longer carries the exclusion; the comment in its place says why re-adding it
  would change nothing.

### Rejected alternatives — every one MEASURED

Six of the eight levers below returned **zero**: the artifact did not shrink and
the deploy failed identically. They are recorded with their figures so that the
next person to meet a large build does not spend the same day rediscovering the
same zeroes. **Writing down what did not work is the more valuable half of this
document.**

| Alternative                                                   | Measured result                   | Why rejected                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outputFileTracingExcludes`                                   | **0**                             | ~~None of the excluded packages were in the trace to begin with — the exclusion had nothing to remove.~~ **Corrected 2026-08-07 (MOTIR-2403):** the zero is right, the reason was not. The key is read only by `collect-build-traces.js`, which `build/index.js` skips entirely under Turbopack — so it removes nothing regardless of what is in the trace. See §2 above. |
| `binaryTargets` / `engineType`                                | **0**                             | There is no native engine to retarget. Prisma 7 uses the **WASM** query compiler, which is exactly the 4.9 MB being copied 490 times.                                                                                                                                                                                                                                     |
| The `prisma-client` generator (replacing `prisma-client-js`)  | **0**                             | The compiler **relocates** but is still traced — ×337 instead of ×490. Fewer copies of the same structural problem is not a fix.                                                                                                                                                                                                                                          |
| `serverExternalPackages`                                      | **0**                             | Externalizing a package moves it out of the bundle, not out of the per-function trace.                                                                                                                                                                                                                                                                                    |
| `VERCEL_FORCE_NO_BUILD_CACHE`                                 | **0**                             | The restored build cache was never the input to the packaging step that fails.                                                                                                                                                                                                                                                                                            |
| Three machine tiers (Standard, Elastic, Enhanced)             | **0**                             | `/tmp` is a **fixed infrastructure default, independent of tier** — confirmed by Vercel support. Paying more buys no packaging disk.                                                                                                                                                                                                                                      |
| **Prisma Accelerate**                                         | **~39%** reduction                | It works, and it is rejected on architecture: it puts a **paid proxy in the data path** to route around a packaging model. The price of the fix is a permanent dependency in every query.                                                                                                                                                                                 |
| **Catch-all route handlers**                                  | **~61%** reduction                | It works, and it is rejected on architecture: collapsing routes into catch-alls **reshapes the application to fit a bundler**, against the 4-layer route convention (`CLAUDE.md`) with no product reason.                                                                                                                                                                 |
| Stay on Vercel, change nothing                                | —                                 | Production deploys fail today. This is the status quo the record exists to end.                                                                                                                                                                                                                                                                                           |
| Another container host (Render / Railway / Cloud Run / a VPS) | not measured, and deliberately so | Each would solve the same structural problem the same way (one process, one image), so there is no measurement that would distinguish them — and each would add a **second** platform relationship to operate. `motir-ai` has run this exact shape on Fly for months: same org, same `iad` region, same `release_command`. The working precedent is the whole argument.   |

---

## §3 — Q2: the blob store

### The decision

**Attachments move to Tigris** — Fly's S3-compatible object store — **as two
buckets**, preserving the public/private split `attachment-access-control.md`
decided:

| Bucket      | Contents                                                          | Access                                |
| ----------- | ----------------------------------------------------------------- | ------------------------------------- |
| **public**  | avatars (the object `User.image` keys) and other public assets    | public-read; a directly fetchable URL |
| **private** | comment/description embeds, panel files, acceptance video + trace | no public read; presigned GET only    |

**The signing flow becomes S3 presigned URLs.** `@vercel/blob`'s
`issueSignedToken` → `presignUrl` delegation has no counterpart outside Vercel;
the S3 equivalent of a short-lived authenticated GET is a **presigned GET**, and
of `generateClientTokenFromReadWriteToken` a **presigned PUT**. Everything else
in `attachment-access-control.md` is untouched — the private store, the
authenticated `GET /api/attachments/[id]/content` route, the §3 authorization
matrix, the DTO exposing only `contentUrl`, and the **300 s** TTL, which carries
over unchanged as the presigned GET's expiry.

**One clause is a genuine behavioural difference and is pinned here rather than
discovered at run time: a presigned PUT carries only the metadata the SIGNER
set.** Content type must be bound at signing time, not sent by the browser, or
every client-uploaded object lands as `application/octet-stream`.

The swap is bounded to one file. `lib/blob/uploader.ts` is the **only** module
importing `@vercel/blob`, and it exports eight functions (and the three
interfaces they return) that everything else calls through — which is why this is
a code change and not an architecture change. _Corrected by Amendment 3._

### Rejected alternatives

| Alternative                                     | Why rejected                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep `@vercel/blob`, hosted from Fly            | It would work — the SDK is not tied to Vercel compute. But it keeps the Vercel account, the billing relationship and a store nobody can retire, which is precisely what this Story exists to end. A migration's deliverable is the deletion of the abandoned path, not merely its emptying.        |
| S3 on AWS                                       | A third provider account and cross-cloud egress, for an object store Fly already offers in-region.                                                                                                                                                                                                 |
| Make the store public and drop the signing flow | Already decided against, on security grounds, in `attachment-access-control.md`'s Context — a "public" blob is world-readable to any holder of the URL. **This is a recorded decision, not an open question**, and changing hosts does not re-open it.                                             |
| A single bucket with per-object ACLs            | Collapses a split that exists for a reason: an avatar renders with **no per-item auth context** and wants CDN-cacheable URLs, while content must never be readable without authorization. Two buckets make the difference structural instead of a per-object attribute someone can get wrong once. |

---

## §4 — Q3: the app-URL contract

### The decision

**`MOTIR_BASE_URL` is the one variable that carries the application's own
absolute origin, and `lib/baseUrl.ts` is the one place its precedence lives.**

Three Vercel-injected variables carry it today — `VERCEL_URL`,
`VERCEL_BRANCH_URL`, `VERCEL_PROJECT_PRODUCTION_URL` — read in
`lib/baseUrl.ts` and `lib/auth/index.ts`. None exists on Fly.

**Precedence, in full — two rungs, and deliberately only two:**

| #   | Source                  | When                                                                                |
| --- | ----------------------- | ----------------------------------------------------------------------------------- |
| 1   | **`MOTIR_BASE_URL`**    | every deployed environment; set as a Fly secret. Production: `https://app.motir.co` |
| 2   | `http://localhost:3000` | local development and tests, when the variable is unset                             |

The platform-injected middle rungs are not replaced by Fly equivalents; they are
**deleted**, because the thing they existed for — a per-deployment URL nobody
configured — is exactly what Q4 drops. A trailing slash is trimmed by the
existing `resolveBaseUrlTrimmed`.

**Why this name and not a new one.** `MOTIR_BASE_URL` is already this
repository's name for this concept: `scripts/upload-acceptance-video.mjs` reads
it, defaulting to `https://app.motir.co`, and `.github/workflows/acceptance-video.yml`
sets it. Adopting the shipped name means one vocabulary rather than two, and the
runtime and the acceptance workflow agree by construction. `BETTER_AUTH_URL` was
the incumbent first rung, but it is a library-specific name now governing email
links, public-project URLs, Inngest registration and signed assets — the name
would keep lying about its scope. Better-Auth's `baseURL` is supplied **in code**
from the accessor, so nothing about Better-Auth depends on the variable's name.

**`trustedOrigins` collapses with it.** Better-Auth's allowlist exists in its
current shape only because a Vercel preview could arrive on a branch alias, a
deployment-unique URL or the custom domain. With one origin it becomes
`[MOTIR_BASE_URL, 'http://localhost:3000']`.

**`NEXT_PUBLIC_BETTER_AUTH_URL` stays unset and is NOT folded into this
contract.** `lib/auth/client.ts` defaults it to `''`, which Better-Auth resolves
to the current origin at request time — correct for a single-origin deployment,
which is what Fly serves. Adopting it would be actively wrong here: a
`NEXT_PUBLIC_*` value is **inlined at `next build`**, and in a Dockerfile that
build happens in the builder stage with no secrets present. Baking the browser's
auth origin into the image would make one image per environment, destroying the
build-once-deploy-anywhere property that is half the reason for the move. This
clause exists so that no card "fixes" it with a Docker build argument.

### Rejected alternatives

| Alternative                                                               | Why rejected                                                                                                                                                   |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep `BETTER_AUTH_URL` as the single variable                             | Zero migration cost, and a name that misdescribes its scope forever. The rename is one secret on a platform being provisioned fresh.                           |
| Introduce a new `MOTIR_APP_URL`                                           | A third name for a concept that already has two. `MOTIR_BASE_URL` is shipped and already means this.                                                           |
| Derive the origin from the request at runtime, with no variable           | Works for a browser request and fails for everything that has no request: emailed links, Inngest registration, a job building an absolute URL.                 |
| Keep a multi-rung precedence with Fly-injected variables (`FLY_APP_NAME`) | Reconstructs `<app>.fly.dev` — an origin the product is never served on once DNS moves, and a second answer to a question this Q exists to give one answer to. |

---

## §5 — Q4: preview environments are DROPPED

### The decision

**Per-pull-request preview environments do not survive the move. This is a
decision, not an omission** (Yue, 2026-08-07 — pre-launch, and CI already runs
the full suite on every pull request).

**What is lost, precisely:**

- The per-PR deployed URL Vercel creates and links on the pull request.
- The per-PR database branch that URL pointed at.
- `cleanup-preview-deployments.yml`, which reaps them (deleted by MOTIR-2393).
- A reviewer's ability to click a link and use the change without a checkout.

**What is kept, and is why the loss is affordable right now:** every pull request
still runs the full vitest suite and the **119 Playwright specs** against their
own ephemeral Postgres, unchanged (Q5). A change is verified by CI and by running
the app locally — which is already what happens.

**What would reverse it, concretely.** A Fly app per pull request plus a **Neon
branch per pull request** through Neon's API, created on open and destroyed on
close. That is real work and it belongs to a **future Story**, not to a deferral
hidden inside this one. The trigger to schedule it: **the first reviewer who is
not a committer** — a designer, a QA reviewer, or anyone accepting a Story who
should not need a local checkout to see the change.

### Rejected alternatives

| Alternative                                     | Why rejected                                                                                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Keep the Vercel project alive for previews only | Keeps the account, the billing relationship, `vercel.json`, and **two build paths that can disagree** — a preview that passes on a packaging model production no longer uses is worse than no preview. |
| One shared staging app                          | A queue for a single environment, and a second production to keep migrated, monitored and secret-managed. It answers a different question (pre-release soak) than previews do (per-change review).     |
| Build previews now, inside this Story           | It is the largest single piece of work in the migration and it gates nothing else. Doing it here would hold the fix for a failing production deploy behind a convenience feature.                      |

---

## §6 — Q5: the pipeline order, and where verification reads from

### The decision

**The existing gates run FIRST; the deploy follows them.** In order:

1. **vitest** and the **119 Playwright specs**, exactly as they are today — their
   own ephemeral `postgres:16-alpine` per leg, their own web servers,
   `resetDatabase()` in `beforeEach`, nine parallel legs. **This Story changes
   none of it** (Yue, 2026-08-07). They are the gate.
2. **Build the image and deploy**, on the default branch only, `needs:` those
   jobs and skipped if either fails.
3. **`prisma migrate deploy` as Fly's `release_command`** — Fly runs it once per
   deploy, before new machines take traffic, so a migration cannot race a
   half-rolled-out release. This is the shape `motir-ai/fly.toml` has used for
   months.
4. **The Inngest sync as an explicit step after the release is live, which FAILS
   the job when it does not succeed.** `inngest-sync.yml` triggers on
   `deployment_status` today — an event **Vercel** raises and Fly does not. The
   trigger moves into the deploy job. This matters more than it looks: Inngest
   only invokes functions it has been told about, and a stale app registry drops
   events **silently** — five production jobs were dead for a month for exactly
   this reason (MOTIR-1970). A red check is the signal.
5. **Post-deploy verification reads the PLATFORM.**
   `GET https://api.machines.dev/v1/apps/<app>` → `machine_count`, or
   `fly status` — **never a line in `fly.toml`.** See Q6.

### Rejected alternatives

| Alternative                                            | Why rejected                                                                                                                                                                                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy in parallel with the gates                      | Faster, and it ships a build the suite is about to fail. The gates are the gate.                                                                                                                                              |
| Keep the Inngest sync on a `deployment_status` trigger | Fly raises no such event, so the sync would simply stop running — reproducing the exact silent failure MOTIR-1970 fixed.                                                                                                      |
| Let the sync fail soft                                 | Its entire history is of a failure that produced no signal at all.                                                                                                                                                            |
| Verify the deploy by reading `fly.toml`                | A config file is a **claim** about the deployment, not a reading of it. This is MOTIR-2102's failure verbatim: `motir-ai`'s `fly.toml` promised load spilling onto fresh machines while production ran one machine for weeks. |
| Re-point the E2E suite at the deployed environment     | The specs truncate the database they connect to in `beforeEach`, and the only deployed database is production. Out of scope by decision.                                                                                      |

---

## §7 — Q6: the machine pool, and who creates it

### The decision

**Production runs TWO machines** — org `moooon`, region `iad`,
`shared-cpu-2x` / 2 GB, `min_machines_running = 1`, `auto_stop_machines = "stop"`,
`auto_start_machines = true`.

**The count is created by `fly scale count 2`, an OPERATOR action, and it is
owned by MOTIR-2386.** This is the single most important sentence in this
section, because the mechanism is counter-intuitive and has already cost this
project three days once:

> **Fly's proxy never CREATES a machine.** `auto_start_machines` starts an
> existing **stopped** machine and nothing more. The ceiling on running machines
> is the number that already exist — created at `fly launch`, by
> `fly scale count <n>`, or by `fly machine clone`. **`flyctl deploy` updates the
> machines that exist; it does not add one.** So every knob in
> `[http_service]` is a policy over a fixed pool, never a request for capacity.

`motir-ai` ran `machine_count: 1` for weeks while its own `fly.toml` promised
otherwise, because no card ran the scale command (planning bug MOTIR-2106,
operator card MOTIR-2103). motir-core does not repeat it: the count is a step
with a spend consequence, on a named card, and MOTIR-2392 reads the result back
**from the platform**.

**Why 2 and not 1.** With one machine `auto_start_machines` has nothing to start
and `soft_limit` can never fire, so both settings are decoration — and every
rolling deploy and every Fly host drain is a **full outage**. Unlike motir-ai,
whose callers are service-to-service, this app serves interactive page loads, so
that outage is user-visible.

**Cost**, from Fly's published pricing (2026-08-07): `shared-cpu-2x` 2 GB =
**$11.83/machine/month** → **~$24/month** for the pair, plus $0.02/GB outbound.
The standby machine is stopped in steady state and Fly does not bill compute for
a stopped machine, so the always-on cost is the one warm machine.

**⚠️ The VM size is INHERITED from motir-ai, not measured for this app.** The
spike could size the artifact (374 MB) but not the resident set. See §10.

### Rejected alternatives

| Alternative                                          | Why rejected                                                                                                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| One machine                                          | Makes the autostart policy inert and every deploy an outage, on a user-facing app. Saves the cost of a machine that is stopped most of the time.   |
| Scale to zero (`min_machines_running = 0`)           | A cold start on an interactive page load. Correct for a service-to-service backend, wrong for the surface a user is looking at.                    |
| Three or more                                        | No measured demand. The heavy workloads in this product live elsewhere (the container fleet, MOTIR-1981), and each machine bills whenever it runs. |
| Declare the count in `fly.toml` and consider it done | `fly.toml` cannot create a machine. This is the belief that produced MOTIR-2102.                                                                   |

---

## §8 — Q7: static-asset egress

### The decision

**No CDN in front of the app, for now.** The standalone server serves its own
`.next/static` and `public`, and Fly bills outbound transfer at **$0.02/GB**.
Vercel's CDN was bundled into the plan; on Fly it is a line item.

This is **accepted explicitly rather than left as a gap**, and it has a trigger:
revisit — by fronting the app with Cloudflare's free tier, which is the normal
answer — when the monthly egress bill is a **material fraction of the ~$24
compute cost**, or when a static-asset latency complaint arrives from outside
`iad`'s region. Until then it is one more moving part for a product with no
measured traffic problem.

### Rejected alternatives

| Alternative                                       | Why rejected                                                                                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Front it with Cloudflare now                      | Another DNS-level component to configure, cache-bust and debug during a cutover whose failure modes should be few. It buys nothing measurable at current traffic. |
| Serve static assets from the Tigris public bucket | Splits the deployment across two origins and adds an asset-versioning problem Next already solves with immutable hashed filenames.                                |

---

## §9 — Q8: what the move does NOT change

Enumerated so nothing is assumed into scope:

| Element                                     | Disposition                                                                                                                                                                                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The database engine**                     | Neon stays Neon. The app connects with a plain `DATABASE_URL` through `PrismaPg` either way — **moving compute does not move data.** Only the _account_ moves, from a Vercel-managed Marketplace resource to the direct Neon account motir-ai uses (MOTIR-2391). |
| **Migrations**                              | `pnpm prisma migrate deploy`, as Fly's `release_command` — the shape motir-ai has used for months.                                                                                                                                                               |
| **Inngest**                                 | A plain HTTP endpoint. Two secrets and a re-sync step; the Vercel Inngest integration is not installed.                                                                                                                                                          |
| **The E2E suite**                           | Unchanged by decision (Yue, 2026-08-07). 119 specs, own ephemeral Postgres per leg, nine legs.                                                                                                                                                                   |
| **Route shapes and the 4-layer convention** | Untouched. Q1 rejects the catch-all refactor precisely because it would change them.                                                                                                                                                                             |
| **`motir-ai`, `motir-gateway`**             | Out of scope. motir-ai already runs on Fly.                                                                                                                                                                                                                      |
| **`motir.co` nameservers**                  | Already third-party, already outside Vercel. The cutover is a DNS **record** change, not a Vercel domain operation.                                                                                                                                              |

---

## §10 — What this record deliberately does NOT decide

Each of these is named with its trigger, so a reader in six months finds a
boundary rather than a hole:

- **The VM size.** `shared-cpu-2x` / 2 GB is inherited from motir-ai, not
  measured for this app. **Trigger:** the first sustained memory or CPU reading
  from Fly's metrics after the cutover — MOTIR-2392 takes the first platform
  reading. Re-sizing is a one-line change plus a deploy; guessing now would be a
  measurement with no data behind it.
- **Per-PR preview environments.** Dropped by Q4 with a named reversal path;
  building them is a future Story.
- **A CDN.** Q7, with its trigger.
- **The blob objects' retention on the old store.** MOTIR-2396 deletes them after
  the new store has served the same stability window; how long that window is,
  is that card's to state.
- **Anything in `public-api-conventions.md` or any other ADR.** The `/api/v1`
  contract is unaffected: nothing here changes a route's shape, its payload or
  its version.

---

## Consequences — what this decision binds on MOTIR-2384's cards

Every card below is now required to do something specific by this record. Where a
card's own acceptance criteria did not already carry it, the card was amended as
part of this subtask (a work-item edit; no file outside `docs/decisions/` changes
here).

- **MOTIR-2386 (provisioning, human)** — creates the Fly app in org `moooon`,
  region `iad`; creates **two** Tigris buckets per Q2, the public one with
  public-read; sets the secrets including **`MOTIR_BASE_URL`** (Q3) and the
  Tigris credentials; creates `FLY_API_TOKEN`. **And runs `fly scale count 2`
  (Q6)** — the operator action nothing else can perform, recording the observed
  count from the platform. _Amended by this subtask to carry the scale step, the
  two-bucket split and the variable name._
- **MOTIR-2387 (the runtime)** — ships `output: 'standalone'`, the multi-stage
  `Dockerfile` with `HOSTNAME=0.0.0.0` and its reason, and `fly.toml` with the
  region, the `release_command`, and a comment recording the **intended** machine
  count and that `fly scale count` — not this file — is what creates it (Q6).
  _Amended by this subtask: its criterion previously asked `fly.toml` to "declare
  an explicit machine count", which is the belief MOTIR-2102 disproved._
- **MOTIR-2388 (the app-URL contract)** — implements **`MOTIR_BASE_URL`** with
  the two-rung precedence of Q3 behind one accessor, collapses `trustedOrigins`,
  and leaves `NEXT_PUBLIC_BETTER_AUTH_URL` unset and un-inlined. Its own criterion
  already says the ADR's name wins; this is that name.
- **MOTIR-2389 (the blob store)** — reimplements all eight
  `lib/blob/uploader.ts` functions (and the three interfaces they return) against
  the S3 client per Q2: presigned GET at **300 s**, presigned PUT **with content
  type bound at signing time**, and the two-bucket public/private split
  preserved. The expiry and the split are what `attachment-access-control.md`'s
  Amendment 2 records. _Count corrected by Amendment 3._
- **MOTIR-2390 (CI)** — implements the Q5 order: gates first, deploy after on the
  default branch, the Inngest sync as a step that fails the job, and a post-deploy
  check that reads `machine_count` from Fly's API.
- **MOTIR-2391 (the database account)** — unaffected by Q1's choice of host, and
  bound by Q8: the engine does not move, only the account. Its ordering hazard
  (never uninstall the integration first) is its own and is untouched here.
- **MOTIR-2392 (cutover)** — verifies on the Fly URL before DNS, and reads
  `machine_count` **from the platform** (Q5, Q6). It also takes the first memory
  reading that §10's VM-size trigger depends on.
- **MOTIR-2393 (deleting the abandoned path)** — deletes `@vercel/blob`, the
  `VERCEL_*` and `BLOB_*` reads, `vercel.json` and
  `cleanup-preview-deployments.yml`. Q4 is why the preview-cleanup workflow goes:
  it reaps something that no longer exists.
- **MOTIR-2394 / MOTIR-2395 (the Story's tests)** — the no-Vercel-import guard is
  an exact set because Q1 leaves no legitimate Vercel import; the blob seam is
  exercised through its real consumers because Q2 changes semantics behind an
  unchanged signature.
- **MOTIR-2396 (retirement)** — ends the rollback. Q4 is the reason there is no
  preview workload left on Vercel to strand.

---

## Sources

| Fact                                                                 | Source                                                                                                                 |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| The failure, and the eight measured levers                           | MOTIR-2371 (incident) — Vercel support's confirmation that `/tmp` is a fixed default                                   |
| 374 MB vs 4,240 MB, 490 → 1 WASM copies, the boot at 200             | MOTIR-2383, branch `spike/fly-standalone`, PR #1922                                                                    |
| `HOSTNAME=0.0.0.0`; 222 MB of `design/**` in the trace               | MOTIR-2383's `Dockerfile` comments and PR body                                                                         |
| The release-command shape, region `iad`, the VM size                 | `motir-ai/fly.toml` — the working precedent                                                                            |
| Fly's proxy never creates a machine; the count is an operator action | `motir-ai/fly.toml`'s `[http_service]` comment; planning bug MOTIR-2106, operator card MOTIR-2103, incident MOTIR-2102 |
| $11.83/machine/month, $0.02/GB egress                                | fly.io/docs/about/pricing, read 2026-08-07                                                                             |
| The signing flow being amended, the two-store model, the 300 s TTL   | `docs/decisions/attachment-access-control.md` §1–§5 and its 2026-07-07 amendment                                       |
| The three `VERCEL_*` reads and their two call sites                  | `lib/baseUrl.ts`, `lib/auth/index.ts` on `origin/main`                                                                 |
| `MOTIR_BASE_URL` already meaning this                                | `scripts/upload-acceptance-video.mjs`, `.github/workflows/acceptance-video.yml`                                        |
| A stale Inngest app registry drops events silently                   | `.github/workflows/inngest-sync.yml`'s header (MOTIR-1970)                                                             |
| Uninstalling the Vercel integration deletes the Neon organization    | Neon's documentation, cited on MOTIR-2391 and MOTIR-2396                                                               |

---

## Amendment 1 (2026-08-07) — the core→ai seam moves onto Fly private networking; `MOTIR_BASE_URL` stays PUBLIC

> **Written by Story MOTIR-2384 · Subtask MOTIR-2420.** **Decided by Yue,
> 2026-08-07:** once motir-core runs on Fly, it reaches motir-ai over the org's
> private network. This amendment RECORDS that decision and the boundary around
> it. It changes no secret, no code and no configuration — **MOTIR-2426 applies
> the value and proves it from inside a deployed machine**, which cannot happen
> until the cutover (MOTIR-2392) has produced one.
>
> **Numbered 1** — the first amendment to this record. (MOTIR-2410, which
> corrects the org name in §1 / §2 / §7, is a separate PR against this same file
> and takes the next number.)

**Amends:** it ADDS a decision — **Q9**, the transport between motir-core and
motir-ai — which §1's decision table did not carry. §1 is deliberately not
rewritten in place; this section is Q9's entry, in the convention this directory
uses (`attachment-access-control.md` Amendment 2, `public-api-conventions.md`
Amendments 1–11).

**It re-opens nothing.** Q1 (Fly, `iad`), Q3 (`MOTIR_BASE_URL` and its two-rung
precedence) and Q7 (no CDN, egress accepted at $0.02/GB) all stand exactly as
written. Q7 is cited below as the REASON this is worth doing, not as a decision
being revisited.

### Q9 — how motir-core reaches motir-ai

#### The decision

**`MOTIR_AI_URL` becomes `http://motir-ai.internal:8080`** — the private 6PN
address of the `motir-ai` app inside the org, in place of the public
`https://motir-ai.fly.dev`.

|                   | public `https://motir-ai.fly.dev`                               | private `http://motir-ai.internal:8080`                           |
| ----------------- | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| path              | out to the public internet and back in through Fly's edge proxy | direct machine-to-machine over the encrypted WireGuard (6PN) mesh |
| **outbound bill** | **$0.02/GB** — the line item Q7 accepted                        | **free** — same-region app-to-app transfer is not billed          |
| latency           | edge proxy hop + a TLS handshake per connection                 | one hop, no TLS termination                                       |
| reachable by      | anyone on the internet who can resolve the hostname             | only from inside the org's private network                        |
| auth              | `MOTIR_AI_SERVICE_TOKEN` on every call                          | **`MOTIR_AI_SERVICE_TOKEN` on every call — unchanged**            |

The last row is not filler. **Going private does not replace authentication.**
The service token still gates every request; the private address removes public
reachability, it does not confer trust. Nothing here licenses dropping the token
because "it is internal now."

#### The facts this rests on — each READ, not assumed

| Fact                                 | Value                        | How it was read (2026-08-07)                                                   |
| ------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------ |
| Both apps are in the SAME Fly org    | `moooon`                     | `fly apps list` — `motir-ai`, `motir-core`, `motir-gateway` all owner `moooon` |
| …and that org exists under that slug | `moooon` (display `MOOOON`)  | `fly orgs list` — `personal`, `motir-fleet`, `moooon`                          |
| Both apps are in the SAME region     | `iad`                        | `motir-ai/fly.toml` `primary_region`; this record's Q1 for motir-core          |
| motir-ai's port behind the proxy     | `8080`                       | `motir-ai/fly.toml` `[http_service] internal_port`                             |
| Public egress rate                   | $0.02/GB (NA/EU)             | fly.io/docs/about/pricing                                                      |
| Same-region app-to-app transfer      | free; cross-region $0.006/GB | fly.io/docs/about/pricing — "the following types of traffic are free"          |

**⚠️ §1, §2 and §7 of this record name the org as `zhu-yue`. That org does not
exist** — it is the personal org's DISPLAY name slugified by hand, and the
personal org (slug `personal`) holds neither service. The correction to those
three sections is **MOTIR-2410**'s, deliberately not made here so that two cards
do not edit the same lines. This amendment states the observed value because the
decision above depends on it: private networking works **because both apps are in
one org**, and a reader checking that premise against a non-existent org name
would conclude the premise is false.

> _Discharged by **Amendment 2** (below, 2026-08-07): §1, §2, §7 and the
> `Consequences` bullet now read `moooon`. The paragraph above is left as
> written — it records what was true when Amendment 1 landed, and the pointer is
> the only thing added to it._

**The "free" claim is region-conditional, and that is why it is written this way
rather than as "not billed".** Both apps are in `iad` today, so the transfer is
free. If either app is ever given a second region, the same traffic becomes
$0.006/GB — still 3× cheaper than the public path, but no longer zero. The
cheapness of this change is a property of the current topology, not of private
networking.

### ⚠️ The boundary — `MOTIR_BASE_URL` is NOT the internal seam and must never be repointed

**This is the load-bearing half of the amendment.** The two services call each
other in both directions, and the obvious symmetry is wrong.

- **core → ai** is `MOTIR_AI_URL`, a **motir-core** secret. It is a
  service-to-service address and nothing else. **It goes private.**
- **motir-core's own origin** is **`MOTIR_BASE_URL`** (Q3) — and it is **NOT a
  service address at all.** It is the absolute origin the application prints
  about ITSELF, resolved through the single accessor `lib/baseUrl.ts`, and it
  lands in **password-reset links, workspace-invite links, OAuth callback URLs
  (Google, GitHub, GitLab, Jira, Linear, Plane), public-project canonical and
  OpenGraph URLs, the sitemap, and the automation e-mail CTA**. Every one of
  those is opened by a human in a browser, off the Fly network. **It stays
  `https://app.motir.co`. Pointing it at a `.internal` address would not error —
  it would silently mint links nobody outside a Fly machine can open.**

By Q3's design motir-core has **exactly one** variable for its own origin and
**exactly one** accessor, so there is no "internal variant" of it to set. A
reader who has seen half the traffic move inside and reaches for `MOTIR_BASE_URL`
to finish the job is not completing this decision — they are breaking every
emailed link in the product. **The job is finished. This paragraph is the record
of that.**

**What this amendment does NOT decide:** motir-ai's own `MOTIR_CORE_URL` — the
address it calls back on, carrying `CORE_CALLBACK_SECRET` — is a **motir-ai**
secret, in another repository, under another record. It is unchanged and out of
scope here. It is named only so it is not confused with `MOTIR_BASE_URL`; the two
are different variables in different applications.

### Where `.internal` does NOT resolve — and what is deliberately unchanged

`motir-ai.internal` resolves **only from inside the org's private network** — a
Fly machine in `moooon`, or a device joined to the org's WireGuard peer network.
An ordinary developer laptop, a GitHub Actions runner and a Playwright web server
are none of those.

So **this is ONE deployed Fly secret, and nothing else changes**:

| Surface                                          | Value                                       | Why                                                                   |
| ------------------------------------------------ | ------------------------------------------- | --------------------------------------------------------------------- |
| the `motir-core` Fly app's `MOTIR_AI_URL` secret | `http://motir-ai.internal:8080`             | the only place the private address belongs                            |
| `.env.example`'s documented default              | `http://localhost:8001` — **unchanged**     | it is what a developer runs against; `.internal` breaks every machine |
| `playwright*.config.ts`                          | their existing stub origins — **unchanged** | the E2E lanes intercept this origin; they never reach Fly             |
| `.github/**` workflows                           | **unchanged**                               | a runner is outside the 6PN mesh                                      |

The enforcing check is a grep, not a count:
`grep -rn 'motir-ai.internal' .env.example playwright*.config.ts .github/` must
return nothing.

### Why the value was not simply set during provisioning

MOTIR-2386 set `MOTIR_AI_URL` to the **public** `https://motir-ai.fly.dev`, on
purpose, and recorded why: a provisioning card **transcribes** configuration, it
does not redesign a seam. Improving a value quietly in the middle of a migration
destroys the one property that makes a cutover debuggable — the ability to tell a
**migration** fault from an **optimisation** fault. The private address was
therefore carded (this record, and MOTIR-2426) rather than slipped in.

### The rollback

**One command:** `fly secrets set MOTIR_AI_URL=https://motir-ai.fly.dev -a motir-core`.

That it is this cheap is the whole argument **against** building anything in
code — no fallback chain, no dual-address probing, no health-gated switch. A
seam whose reversal is one secret does not need a mechanism.

### Who applies it, and what they must VERIFY rather than assume

**MOTIR-2426** owns the change and the proof. It cannot run before the cutover:
the address can only be exercised from a machine inside the mesh, and no
motir-core machine exists until MOTIR-2392's first deploy. Two things it must
verify from inside that machine, because this record does not assert either:

- **That `force_https = true` in `motir-ai/fly.toml` does not break a plain-HTTP
  6PN request.** That setting is a Fly **edge-proxy** policy, and 6PN traffic
  goes straight to the machine's internal port; the expectation is that it is
  simply not in the path. **Expectation is not evidence** — MOTIR-2426 issues the
  request and reads the response.
- **That `machine_count` and the app's health are read from the platform**, not
  from `fly.toml` (Q5, Q6).

A decision with no owner for its execution is the gap this section exists to
close.

### Rejected alternatives

| Alternative                                                           | Why rejected                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep the public URL                                                   | It works, and it pays $0.02/GB to send traffic out of a datacentre and back into the same one, while leaving an internal service boundary addressable from the internet. Q7 accepted that cost for **static assets served to users**, not for this. |
| Move `MOTIR_BASE_URL` to `.internal` as well, for symmetry            | It is not a service address. It is the origin printed into emailed links and OAuth callbacks — see the boundary above. This is the specific mistake the amendment exists to prevent.                                                                |
| Set `.internal` as `.env.example`'s default                           | `.internal` resolves nowhere outside the 6PN mesh, so this breaks every developer machine and every CI runner on the first `pnpm dev`, with a DNS error that reads like a network fault.                                                            |
| Add an in-code fallback: try `.internal`, fall back to the public URL | It doubles the failure modes (which path served this request?) and hides a misconfiguration behind a silent, billed detour. The rollback is one `fly secrets set`; a mechanism cannot beat that.                                                    |
| Put a Fly Machines private-network proxy or an internal LB in between | An extra hop and an extra thing to operate, for two apps in one org and one region that Fly already gives a flat private address space.                                                                                                             |
| Do it inside MOTIR-2386 (provisioning)                                | A provisioning card transcribes configuration; changing a seam mid-migration makes a migration fault indistinguishable from an optimisation fault. See above.                                                                                       |

### Sources — additions

| Fact                                                            | Source                                                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Org `moooon` holds all three apps; `zhu-yue` does not exist     | `fly apps list` / `fly orgs list`, 2026-08-07 (also MOTIR-2386's execution comment) |
| motir-ai's `internal_port = 8080`, and `force_https = true`     | `motir-ai/fly.toml` on its `origin/main`                                            |
| Same-region app-to-app transfer is free; cross-region $0.006/GB | fly.io/docs/about/pricing, read 2026-08-07                                          |
| `.internal` is org-scoped 6PN service discovery                 | fly.io/docs/networking/private-networking/, read 2026-08-07                         |
| Everything `MOTIR_BASE_URL` ends up inside                      | `lib/baseUrl.ts`'s header and its call sites on `origin/main` (MOTIR-2388)          |
| Why provisioning set the public value                           | MOTIR-2386's closing comment                                                        |
| The org name correction in §1 / §2 / §7                         | MOTIR-2410                                                                          |

---

## Amendment 2 (2026-08-07) — the Fly org is `moooon`; `zhu-yue` never existed

> **Written by Story MOTIR-2384 · Subtask MOTIR-2410.** This amendment corrects a
> NAME. **It re-opens no decision** — Q1 still chooses Fly.io and region `iad`,
> Q6 still chooses two machines created by `fly scale count 2`, and every other
> section stands exactly as written. What changes is that the three places which
> stated _which org_ the application runs in now state an org that exists.
>
> **Numbered 2.** Amendment 1 (the core→ai private-networking seam, MOTIR-2420)
> was written against this same file in parallel and merged first; it reserved
> this number for this correction and deliberately left these lines alone. The
> two amendments touch no common text.

**Amends:** the org NAME in **§1**'s Q1 decision-table row, **§7**'s Q6 decision
paragraph, and the **MOTIR-2386 bullet** under _Consequences_; **§2**'s Q1
paragraph, which named the org only by description ("the Fly org that already
holds `motir-ai`"), now also carries the slug. It also **discharges Amendment
1's ⚠️ paragraph**, which stated that those sections name a non-existent org and
left the correction to this card — that paragraph now carries a pointer here and
is otherwise unchanged. Nothing else in this record changes, and no clause is
withdrawn.

### What was wrong

Three sections of this record stated the Fly organisation as **`zhu-yue`**. **No
organisation of that name has ever existed.** It is the personal org's DISPLAY
name (`Zhu Yue`) slugified by hand rather than read back from the platform — and
the personal org's actual slug is `personal`, which holds neither service.

The error was self-concealing in a specific way: §2's Q1 paragraph described the
org correctly and by reference ("the Fly org that already holds `motir-ai`"),
which is true and unambiguous, while the three sections that named it gave a
slug that resolves to nothing. A reader who followed the description would have
reached the right place; a reader who copied the slug would have found nothing
there, and the most likely reaction to that is to conclude the app must live
somewhere else and create a second one.

### What the platform reports — read, not assumed

Observed 2026-08-07, first on MOTIR-2386 (which created the app) and again while
writing this amendment:

```
$ fly orgs list
Name                 Slug                 Type
----                 ----                 ----
Zhu Yue              personal             PERSONAL
motir-fleet          motir-fleet          SHARED
MOOOON               moooon               SHARED

$ fly apps list
 NAME                │ OWNER       │ STATUS    │ LATEST DEPLOY
 motir-ai            │ moooon      │ deployed  │ 7h47m ago
 motir-core          │ moooon      │ pending   │
 motir-gateway       │ moooon      │ deployed  │ Aug 5 2026 01:52
 motir-ci-runners    │ motir-fleet │ suspended │
 motir-index-runners │ motir-fleet │ pending   │
```

| Fact                         | Value                                              |
| ---------------------------- | -------------------------------------------------- |
| The org this record means    | **`moooon`** (display name `MOOOON`)               |
| What `zhu-yue` resolves to   | **nothing** — no org carries that slug             |
| The personal org's real slug | `personal` — holds neither motir-ai nor motir-core |
| Apps owned by `moooon`       | `motir-ai`, `motir-gateway`, **`motir-core`**      |

So `moooon` is not a new choice being made here — it is what Q1's own reasoning
already meant ("the Fly org that already holds `motir-ai`"), and it is where
MOTIR-2386 actually created the app.

### Why an amendment rather than a silent replacement

A find-and-replace would leave this record looking as though it had always been
right. It has not: it carried a non-existent org name for the whole window in
which the cards downstream of it were being executed, and anyone who acted on the
old value needs to be able to discover that it changed and why. The convention in
this directory — `attachment-access-control.md`'s Amendment 2,
`public-api-conventions.md`'s Amendments 9–11 — is that a correction is recorded,
not overwritten.

### The general lesson this record now carries

**An org, project or account has a display name and a separate short identifier,
and only the identifier is real to the tooling.** Writing the display name in the
shape identifiers usually take produces a value that reads perfectly and resolves
to nothing. Every such value in this directory should be pasted from the
platform's own output — `fly orgs list`, `fly apps list`, `vercel env ls` — never
transcribed from a console header. That is the same rule MOTIR-2102 arrived at
from the other direction: read the platform, not our own file.

### What this amendment does NOT touch

- **`fly.toml`.** Its line 12 comment (`claimed by MOTIR-2386 in org 'zhu-yue'`)
  carries the same wrong name and is corrected by **MOTIR-2428**, its own card —
  the file is runtime configuration, not this record, and it pins no org (an
  app's org is fixed at creation and cannot be set from `fly.toml`).
- **Any decision.** Q1's choice of Fly, Q6's count of 2, and every other Q stand.
- **Anything on the platform.** Nothing is created, moved or renamed; MOTIR-2386
  already created `motir-core` under `moooon`.

---

## Amendment 3 (2026-08-07) — `lib/blob/uploader.ts` exports eight functions, not nine

> **Written by Story MOTIR-2384 · Subtask MOTIR-2431.** This amendment corrects a
> COUNT. **It re-opens no decision** — Q2 still chooses S3-on-Tigris, the
> two-bucket split still stands, the 300 s presigned GET and the content type
> bound at signing time are all untouched, and every other section stands exactly
> as written. What changes is that the two places which stated _how many_ exports
> the seam has now state a number the file agrees with.
>
> **Numbered 3.** Amendment 1 (the core→ai private-networking seam, MOTIR-2420)
> and Amendment 2 (the Fly org, MOTIR-2410) are both in this file already; the
> highest heading was re-read at edit time rather than taken from the card.

**Amends:** the export COUNT in **§3**'s "the swap is bounded to one file"
paragraph and in the **MOTIR-2389 bullet** under _Consequences_. Nothing else in
this record changes, and no clause is withdrawn. The companion correction to the
same count in `attachment-access-control.md` is that record's Amendment 3, landed
by this same card.

### What was wrong

Both sites stated that `lib/blob/uploader.ts` **"exports nine functions"**. It
exports **eight**, alongside three interfaces — so nine is neither the function
count nor the export count, and matches no reading of the file.

The paragraph it sits in is the one a reader leans on hardest: its whole argument
is that the provider swap is _bounded_, and the number is offered as the measure
of that boundedness. The boundedness was real — the swap was bounded by the LIST
of exports, which MOTIR-2389 worked from and which is correct — but the number
quantifying it was never read back from the file.

### What the file actually exports — read, not assumed

Observed on `origin/main`, 2026-08-07:

```
$ git grep -c '^export' origin/main -- lib/blob/uploader.ts
11
$ git grep -c '^export async function' origin/main -- lib/blob/uploader.ts
8
$ git grep -c '^export interface' origin/main -- lib/blob/uploader.ts
3
```

| Reading           | Value                                               |
| ----------------- | --------------------------------------------------- |
| `async function`s | **8**                                               |
| `interface`s      | **3** (`PutResult`, `PrivatePutResult`, `BlobHead`) |
| Total `export`s   | **11**                                              |
| What was written  | 9 — neither                                         |

**The number was never right, not even for the pre-migration file this record was
describing.** The same greps at `16bef033` — the last commit before MOTIR-2389
was authored — return the identical eight function names and three interfaces.
This is not a count that drifted as the file grew; it was wrong when written.

The authoritative list of the eight, name by name, lives on **MOTIR-2402** and
**MOTIR-2389**, which work from a table of them. This record deliberately does not
restate that table: an ADR needs the correct count and a pointer, not a duplicated
API listing that acquires its own drift.

### Why an amendment rather than a silent replacement

A find-and-replace would leave this record looking as though it had always been
right. The convention in this directory — Amendment 2 above,
`attachment-access-control.md`'s Amendment 2, `public-api-conventions.md`'s
Amendments 9–11 — is that a correction is recorded, not overwritten, and that
holds even when the corrected fact turned out to be harmless.

That harmlessness is the point rather than a reason to shrug. An unverified fact
that happens to be harmless is indistinguishable, at the moment it is written,
from one that is not; this one travelled from a card into two accepted decision
records without anyone opening the file it described. Left in place, it teaches
the next reader that the numbers in these documents are decorative.

### The general lesson this record now carries

**A count is a reading, not a recollection.** The same rule Amendment 2 arrived at
for identifiers — paste the value from the tool that owns it — applies to
quantities about our own code: a number describing a file belongs in a document
only with the command that produced it. `git grep -c '^export' <file>` costs one
command, and it is the difference between a fact and an impression.

### What this amendment does NOT touch

- **`lib/blob/uploader.ts` or any code.** Nothing is renamed, added or removed;
  the file is only counted.
- **Any decision.** Q2's choice of S3-on-Tigris, the two-bucket split, the 300 s
  expiry and the signing-time content type all stand.
- **The eight names themselves.** They live on MOTIR-2389 / MOTIR-2402; this
  record points at them rather than copying them.

---

## Amendment 4 (2026-08-08) — the public bucket's contents are the objects `User.image` KEYS, not a URL it stores

> **Written by Story MOTIR-2384 · Subtask MOTIR-2444.** This amendment
> disambiguates ONE table cell. **It re-opens no decision and changes no fact** —
> Q2 still chooses S3-on-Tigris, the two-bucket split stands, the public bucket is
> still public-read, the 300 s presigned GET and the signing-time content type are
> untouched. Avatars are **not** becoming private.
>
> **Numbered 4.** Amendment 3 was the highest heading in this file, re-read at
> edit time rather than taken from the card, and no unmerged branch carries a
> higher one. The primary correction — the false sentence this cell merely sat
> near — is `attachment-access-control.md`'s Amendment 4, landed by this same
> card, and carries the full reasoning.

**Amends:** the **public** row of §3's bucket table. Nothing else in this record
changes, and no clause is withdrawn.

### What was ambiguous

The row read:

> | **public** | avatars (`User.image`) and other public assets | public-read; a directly fetchable URL |

Each half is true of what it describes — the parenthetical names which assets go
in the bucket, the access clause describes what the bucket grants — but they sit
on one row, and after **MOTIR-2404** (motir-core#1937) the juxtaposition reads as
a claim the column does not support. `User.image` now persists the object **key**;
the public URL is composed at the read boundary by `storedAssetUrl`
(`lib/blob/referencedUrls.ts`). The bucket is still directly fetchable. The column
no longer stores what you fetch.

The row now reads "avatars (the object `User.image` keys)". The access clause is
unchanged, because it was never wrong.

### Why the cell was worth touching at all

An ambiguity a reader resolves correctly nine times out of ten is not free in a
record like this one. `User.image` was the last place a **hosting origin** was
persisted as data, and removing it is what lets this Story move hosts without a
data migration. A table that can be read as "the column holds the URL" is an
invitation to put one back, and the invitation is hardest to refuse in exactly the
situation that produces it — a future migration, written by someone reading this
record precisely because they were not there.

### What this amendment does NOT touch

- **Any decision.** Q1's choice of Fly, Q2's S3-on-Tigris and the two-bucket
  split, and every other Q stand.
- **The access model.** The public bucket is public-read; the private bucket is
  presigned-GET only.
- **Any code or anything on the platform.** MOTIR-2404 shipped the change this
  cell now reflects; no bucket, object or ACL is touched here.
