# How the fleet authenticates its image pull

**Status:** accepted · **Date:** 2026-08-02 · **Card:** MOTIR-2005 (Story MOTIR-1916 — run
project CI on Motir's own ephemeral runner fleet) · **Implemented by:** MOTIR-2006 ·
**Evidence pinned at:** `motir-core` `origin/main` @ `e6255217` · **Fly + GitHub behaviour
measured live 2026-08-02** (§2; every probe reproducible from §2.5)

`docs/decisions/ci-runner-fleet.md` §1 fixed that the fleet runs on Fly Machines and §7.2
that it consumes a **digest**. Neither says how a Machine **obtains** the bytes that digest
names. MOTIR-1978 published `ghcr.io/moooon-b-v/motir-ci-runner` **private**, the adapter
sends no registry credential, and so `isFlyFleetConfigured()` returns true while the fleet
cannot boot a single container. This is that decision.

This is a `decision` card: it fixes shapes and ships no behaviour. **MOTIR-2006 wires it**,
and §7 names exactly what it wires. Per `notes.html` #50 — a decision card is not an
implementation — nothing here is a precondition any sibling may assume is present.

## §0 — The card's option space was wrong, and the correction is the whole decision

The card offered three options: **A** publish public, **B** configure a registry pull
credential, **C** a different registry. It framed B as _"the ordinary answer every container
platform expects"_ and asked, as its sharpest question, whether that credential would be
readable from inside a booted machine.

**Option B does not exist on Fly.** Measured, not cited (§2.2): the Machines API create
payload has **no field** for registry authentication, and Fly rejects a private third-party
image at create time with `HTTP 400 · failed to get manifest …: unauthorized`. Fly's own
position, unchanged since 2024: _"private third party registries are not supported by fly"_
(Kurt, Fly staff, 2024-03-04), and the Machines API _"only supports public images or the fly
registry."_

So the real option space is two, not three, and neither is "hand Fly a GHCR token":

| Option                                                                               | Available on Fly?                       |
| ------------------------------------------------------------------------------------ | --------------------------------------- |
| **A** — the image is **PUBLIC** and pulled anonymously                               | **Yes**                                 |
| **B** — hand Fly a GHCR pull credential                                              | **No — no such field**                  |
| **B′** — **MIRROR** the image into `registry.fly.io`, which Fly authenticates itself | **Yes**                                 |
| **C** — a different third-party registry, credentialed                               | **No — same wall**                      |
| **C′** — a different third-party registry, **public**                                | Yes, but it is A with more moving parts |

**This reframes the card's "suspicion on principle."** The card warned, correctly, that
_"we need auth, so remove the need for auth"_ deserves suspicion. That suspicion is answered
empirically rather than rhetorically: authentication to a third-party registry was **never on
the menu**. Both surviving options are credential-free at the machine. They differ in **what
is disclosed** and **what operational object is created** — and that, not auth, is what §3
decides.

**And the card's sharpest question dissolves into a measured answer.** "Is the credential
reachable from inside a running machine?" — there is no credential to be reachable, and §2.4
establishes by observation that a booted Machine's environment contains **no registry
credential and no Fly credential of any kind**. The pull happens in Fly's infrastructure
before the guest's userspace exists. §7.4 of `ci-runner-fleet.md` is not in tension with
either option.

## §1 — The decision

**Visibility follows the SOURCE's visibility. An image whose recipe is already public is
published PUBLIC; an image built from closed source is MIRRORED into `registry.fly.io`.**
Concretely, for the three images the card binds:

| Image                              | Built from                    | Source repo is     | Decision                                                                              |
| ---------------------------------- | ----------------------------- | ------------------ | ------------------------------------------------------------------------------------- |
| **CI runner** `motir-ci-runner`    | `motir-core/infra/ci-runner/` | **public**         | **PUBLIC on GHCR** (Option A)                                                         |
| **Indexer** (MOTIR-1988)           | `motir-ai`                    | **private**        | **MIRROR to `registry.fly.io`** (B′)                                                  |
| **Epic 9 agent image** (MOTIR-673) | not yet built                 | private (expected) | **MIRROR to `registry.fly.io`** (B′) — revisit if it is ever built from public source |

**The rule, stated so a fourth image does not need a fourth decision:** _publishing a
container image discloses the contents of its layers. Where that disclosure has already
happened — the Dockerfile and every build input are in a public repository — privacy on the
built layer buys nothing and costs a boot path. Where it has not, the image is mirrored, and
the mirror is the standing mechanism for every closed image the fleet boots._

They legitimately differ, and this is not a split for its own sake — it is the same rule
producing two answers because the inputs differ. §4 records what the public half costs; §5
records what the mirror half costs; both are real and both are accepted.

## §2 — What was measured, and how

Every claim below was produced against live infrastructure on 2026-08-02, in a throwaway Fly
app (`motir-2005-pullprobe`, `personal` org) created and destroyed for the purpose. The
`motir-fleet` org's token is not reachable from a coding-agent sandbox; the substitution is
recorded honestly here because it is load-bearing: **these are Fly-platform behaviours, not
org-scoped ones**, so a different org observes the same thing. MOTIR-2006 re-runs §2.1 and
§2.2 against `motir-fleet` itself, which is the point of the preflight §7 asks for.

### §2.1 — The published runner image is not anonymously pullable

```
GET https://ghcr.io/token?scope=repository:moooon-b-v/motir-ci-runner:pull&service=ghcr.io
→ {"errors":[{"code":"UNAUTHORIZED","message":"authentication required"}]}
```

**Control, so the probe is known to be able to say "public":** the same request for
`homebrew/core/git` returns `{"token":"…"}`, and a manifest fetch with it succeeds. The probe
distinguishes the two states; `motir-ci-runner` is in the closed one.

### §2.2 — Fly rejects the private digest SYNCHRONOUSLY, at create

`POST /v1/apps/{app}/machines` with the real published digest:

```
{"error":"failed to get manifest ghcr.io/moooon-b-v/motir-ci-runner@sha256:446c692d…: unauthorized"}
HTTP 400
```

**No machine is created.** This is the single most useful finding for §6: the failure is
**not** "the machine boots and dies," which is what the card feared. Fly resolves the
manifest before it allocates anything, and the adapter already turns that into
`OrchestratorApiError('fly', 400, …)` from `flyMachinesClient.createMachine`. What is wrong
is not the loudness — it is the **timing** (§6).

The same call with a **public** GHCR image (`ghcr.io/astral-sh/uv:latest`) returns **HTTP
200**, the machine boots, and `image_ref.registry` resolves to `ghcr.io`. **Option A is
proven end-to-end on Fly, not assumed.** (Docker Hub images resolve instead to
`docker-hub-mirror.fly.io` — Fly transparently mirrors Hub, and only Hub.)

### §2.3 — The Machines API has no registry-credential field

The documented `config` object is: `image`, `auto_destroy`, `checks`, `dns`, `env`, `files`,
`guest`, `init`, `metadata`, `metrics`, `mounts`, `processes`, `restart`, `schedule`,
`services`, `size`, `standbys`, `statics`, `stop_config`. There is no `registry_auth`, no
`docker_auth`, no `image_pull_secret`, and no credential parameter of any name. §2.2's 400 is
that absence, observed.

### §2.4 — A booted machine's environment contains NO credential — established by observation

The card required this be measured, not assumed, and explicitly refused to inherit the
assertion made and then retracted during MOTIR-1979. Fly's log API is not reachable with the
available token, so the finding was carried out of the container on the **exit code**, which
leaks nothing: a probe machine inspects itself and exits with a bitmask.

Probe 1 — `exit_code = 48`, i.e. bits `32|16` set and `8|4|2|1` clear:

| Bit | Tested                                                                         | Result |
| --- | ------------------------------------------------------------------------------ | ------ |
| 1   | `/root/.docker/config.json` exists                                             | **no** |
| 2   | any env var named `*DOCKER*`/`*REGISTRY*`/`*GHCR*`/`*REGCRED*`/`*PULL*`        | **no** |
| 4   | any env var named `*TOKEN*`/`*SECRET*`/`*PASSWORD*`/`*API_KEY*`/`*CREDENTIAL*` | **no** |
| 8   | any env **value** containing `ghcr.io`                                         | **no** |
| 16  | `/.fly` exists                                                                 | yes    |
| 32  | any `FLY_*` env var                                                            | yes    |

Probe 2 — `exit_code = 8`, decoding to bitmask `0`, `FLY_*` count `8`: **no** env value
containing `FlyV1` (a Fly macaroon), **no** env value ≥ 120 chars (any long bearer token),
**no** token/cred/auth/secret-named file in `/.fly`, **no** `FLY_API_TOKEN`. The eight
`FLY_*` variables are Fly's documented non-secret runtime metadata.

**Controls validate the channel**: `sh -c 'exit 99'` reports `exit_code=99` and
`sh -c 'exit 0'` reports `exit_code=0`, so the number carries the guest's own exit status.
(Read `exit_code` in the machine's `exit` event, **not** `guest_exit_code`, which read `0` in
every probe including the `exit 99` control — a trap worth recording for MOTIR-2006.)

**Conclusion, recorded either way as the card demanded: no registry credential and no Fly
credential is reachable from inside a booted fleet Machine, under either surviving option.**
`ci-runner-fleet.md` §7.4 holds; MOTIR-1979's criterion holds; neither is at risk from this
decision.

### §2.5 — Reproducing any of it

```sh
# §2.1 — is a GHCR package anonymously pullable?
curl -s "https://ghcr.io/token?scope=repository:<org>/<pkg>:pull&service=ghcr.io"
#   {"token":…} → public · {"errors":[{"code":"UNAUTHORIZED"…}]} → private (or absent)

# §2.2 — will Fly pull this reference? (no machine is created on failure)
curl -s -X POST https://api.machines.dev/v1/apps/$APP/machines \
  -H "Authorization: Bearer $FLY_FLEET_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"config":{"image":"'"$MOTIR_RUNNER_IMAGE"'","guest":{"cpu_kind":"shared","cpus":1,"memory_mb":256}}}'
```

## §3 — Why the runner image is PUBLIC rather than mirrored

Both options boot. The runner is published rather than mirrored for three reasons, in
descending weight:

1. **The disclosure has already happened.** `moooon-B-V/motir-core` is a **public** repository
   (verified 2026-08-02) and `infra/ci-runner/Dockerfile` is in it, together with
   `smoke/assert-image.sh`, which enumerates the toolchain the image is asserted to contain.
   Keeping the built layer private protects a recipe anyone can already read. §4 is honest
   that "already disclosed" is not "identical" — but the delta is small and the price of
   closing it is a permanent mechanism.
2. **It removes a moving part from the boot path forever.** A mirror is a release-lane step
   that can be skipped, a Fly deploy credential that can lapse, and — §5 — a registry with a
   garbage collector. The fleet's boot budget (`ci-runner-fleet.md` §6) and its
   false-green history (MOTIR-1980) both argue for the path with the fewest things that can
   silently stop being true.
3. **The precedent is Motir's own, and it is recent.** `docs/decisions/design-system-package.md`
   §130 rejected a private registry for a sibling artifact — _"a private registry adds
   scaffold-time auth friction … for zero benefit"_ — on exactly this reasoning. Publishing an
   open-source-derived artifact publicly is the established posture, not a new one.

**What did NOT justify it:** "it is easier." §0 records that the credentialed option was never
available, so ease is not what is being bought.

## §4 — What making it public COSTS, accepted explicitly

The card required these be recorded as accepted with reasons, and never omitted for being
inconvenient. Both are real.

**§4.1 — It is IRREVERSIBLE, and GitHub says so in the dialog.** _"Once you make a package
public, you cannot make it private again."_ Verified in GitHub's own package-visibility
documentation, 2026-08-02. Even without that, the practical fact would hold: a published layer
can be mirrored by anyone within minutes of publication. **Accepted because** the thing being
made irreversible is the built form of a recipe that is already irreversibly public — the
decision that could not be walked back was merging `infra/ci-runner/Dockerfile` into a public
repository, and that shipped in MOTIR-1978. **The bound on the acceptance:** it applies to
`motir-ci-runner` only. §1's rule is what keeps a future closed image from inheriting it by
habit.

**§4.2 — It exposes a precise, machine-readable version inventory.** A public image can be
`docker sloth`-ed, SBOM-ed, and diffed against CVE feeds automatically; reading a Dockerfile
cannot yield transitive apt/npm versions, and a manifest can. **Accepted because** the
container is already treated as hostile by construction: `ci-runner-fleet.md` §7.1 destroys it
after one job, §7.5 puts it in a separate Fly organization with no route to Motir's
production 6PN, and §7.6 confines it to a Firecracker microVM. An attacker who knows the
runner's exact Node version gains reconnaissance against a machine that holds one JIT config,
runs one job, and is destroyed. **The residual risk is that this reasoning stops being true
if the runner image's isolation posture ever weakens** — which is why this cost is recorded
against §7.1/§7.5/§7.6 by name rather than waved off.

**§4.3 — What is NOT a cost, checked rather than assumed.** The image contains nothing from
`motir-core`'s tree: `runner-image.yml` sets the build context to `infra/ci-runner`, **not**
the repo root, with the comment _"a root context would ship the whole checkout into a
container that runs customer code."_ There is no credential, no `.env`, and no application
source in the layers to leak.

## §5 — The MIRROR, for the indexer and the agent image

`registry.fly.io` is Fly's own registry. Machines pull from it with **no credential in the
machine config** — Fly authenticates the pull itself, at the same layer where §2.4 shows no
credential reaches the guest. It is **organization-scoped**: an image pushed under one app's
path is usable by other apps in the same organization, which is what makes one mirror serve
the whole `motir-fleet` org.

**Why the indexer image legitimately differs from the runner.** It is built from `motir-ai`,
a **private** repository (verified 2026-08-02), and MOTIR-1988's card states the intent
directly: _"It is Motir's own closed image … nothing is opened by packaging it."_ §1's rule
does not reach it: nothing has been disclosed, so publishing would be a new disclosure of
closed-source build steps, not a formality. **Epic 9's agent image is the same case and is
closer to the product still.**

**The mechanism, named concretely enough to build:** the image is pushed to GHCR by its own
release lane exactly as today, then **copied** into `registry.fly.io/<fleet-app>` with a
**digest-preserving registry-to-registry copy** (`skopeo copy` / `crane copy`). The
credential is a **Fly deploy token for the fleet org, held only by the release workflow** —
it never enters a machine config and never enters a container (§2.4). Rotation owner: whoever
owns the fleet org (MOTIR-1979's owner).

**Three constraints the implementing card must honour, or the mirror is a false green:**

1. **The copy must PRESERVE the digest.** `docker pull && docker tag && docker push`
   re-uploads and can rewrite the manifest, producing a different digest from the one
   `ci-runner-fleet.md` §7.2 pinned. A registry-to-registry copy preserves it. Assert the
   digest is byte-identical on both sides.
2. **`registry.fly.io` garbage-collects UNREFERENCED images.** Fly's stated behaviour is
   _"we clean old ones up after a few days"_; the community reading is that an image cited by
   a live Machine is immune, which is **precisely the wrong shape for a fleet whose machines
   are ephemeral by design** — between jobs, nothing references the image. **This is an
   unresolved risk, named rather than hidden**: the implementing card must either establish
   the real retention rule with Fly, or re-push on a schedule, and either way §6's preflight
   is what turns a GC'd image into a loud failure instead of an outage. Fly publishes no
   retention SLA and no size limit.
3. **It is a second pull path.** The fleet then has two, and each needs §6's preflight
   independently.

**Why not mirror the runner too, for one uniform mechanism?** It was seriously considered and
rejected on §3.2: uniformity would buy the runner a garbage collector, a rotating credential
and a release-lane step it does not need, in exchange for privacy on an already-public recipe.
The asymmetry is the honest answer; a uniform one would be tidier and worse.

## §6 — Where a pull failure surfaces, and where it MUST surface

**Today (measured, §2.2):** an unpullable digest fails at
`flyMachinesClient.createMachine` → `OrchestratorApiError('fly', 400, 'failed to get
manifest …: unauthorized')`. It is loud. But it is loud **per job, at the worst moment**:
`ciRunnerBootService` has already recorded the intent, consulted the admission gate, and —
critically — **minted a JIT config** via `generate-jitconfig`, which is a GitHub-side runner
registration that now belongs to a machine that will never exist. Every queued job repeats
this. The tenant's experience is "CI silently never starts"; the operator's is a stream of
identical provider errors with no statement of the underlying cause.

**The decision: the pull path is asserted BEFORE the fleet accepts work, not per job.**

1. **A boot-time / health preflight** resolves the configured `MOTIR_RUNNER_IMAGE`'s manifest
   against the registry and fails loudly, once, naming the image reference and the registry's
   own error — not a generic provider 400. This is the assertion that makes the regression
   impossible to ship silently, which is the whole reason MOTIR-2005 exists.
2. **The per-job path keeps its existing error** — it is the correct backstop for an image
   that was pullable at preflight and is not now (a GC'd mirror, §5.2; a revoked visibility).
   It should carry a distinguishable reason so it is not confused with "Fly is down."

## §7 — `isFlyFleetConfigured()`: strengthened, but SPLIT — and what MOTIR-2006 wires

The card asked whether the predicate should mean **bootable** rather than _three strings are
non-empty_. **Answer: yes — but not by changing this function.**

`isFlyFleetConfigured()` is called from `getOrchestrator()` on **every provision** and from
`isOrchestratorConfigured()` in the **minute-granularity sweep**. It is synchronous, and
`lib/orchestrator/index.ts` documents why it must never throw or block: a self-hosted
`motir-core` must be _unable to reach this path_, not crash on it. Turning it into a network
call would put a registry round-trip on the hot boot path — inside `ci-runner-fleet.md` §6's
budget — and make a registry blip look like a deployment misconfiguration.

**So: two predicates, with the names doing the work.**

- **`isFlyFleetConfigured()` stays a presence check**, unchanged in behaviour and cost — and
  gains a doc comment saying, in one line, that it answers _"is this deployment wired for the
  fleet?"_ and **not** _"can it boot?"_. The reason it misled is that its name implied the
  second; a comment plus a sibling that really answers the second is the fix.
- **A new async `verifyFleetBootable()`** performs §6.1's preflight: resolve the configured
  image's manifest, return a typed result naming the reference and the registry's error.
  Consumed by the health/preflight surface, **never by the per-job path**.

**MOTIR-2006's scope, made actionable without a second round of deciding:** wire the runner
image as a **public GHCR pull** — no adapter change is required at all, and that is the
finding, since `image: input.image` is already the whole of it; add
`verifyFleetBootable()` + §6.1's preflight; add the doc comment on
`isFlyFleetConfigured()`; give the per-job failure a distinguishable reason (§6.2); and prove
a real machine boots in `motir-fleet` from the pinned digest (§2.5's second command is the
probe). The indexer's mirror belongs to MOTIR-1988/1989 under §5, not to MOTIR-2006.

## §8 — What MOTIR-2006 cannot do, filed as its own card

**Flipping the GHCR package to public is UI-only and irreversible.** GitHub documents the
path as org → **Packages** → the package → **Package settings** → _Danger Zone_ → **Change
visibility** → Public, and publishes **no REST endpoint** for it. A coding agent cannot
perform it, and `gh api` cannot either. Publishing is also not something a release lane
should do implicitly.

Per the card's own instruction — _if the decision needs work MOTIR-2006's scope does not
cover, file that card here_ — it is filed as **MOTIR-2009** (`type: manual`, executor
`human`), and **MOTIR-2006 is `blocked_by` it**. Until it is done the fleet cannot boot,
which is exactly the dependency the plan should show.

## §9 — Out of scope, but found while measuring: the sandbox image

`ghcr.io/moooon-b-v/motir-sandbox` — the BYOK CLI sandbox, nine published digests recorded in
`packages/cli/sandbox/README.md` — is **also private** (§2.1's probe, 2026-08-02), while
`docs/cli.md` tells every user to `docker run ghcr.io/moooon-b-v/motir-sandbox:claude` with
the words _"Pull and go — no checkout, no build."_ That flow cannot work for anyone outside
the org. It is the **same failure shape one product surface over**, and it is **not** one of
the three images this card binds. Logged as its own bug, **MOTIR-2010** (`notes.html` #27 — never absorbed
into the current subtask's scope), and §1's rule already answers it: the sandbox is built
from `packages/cli/sandbox/` in the **public** `motir-core` repo, so it is a publish, not a
mirror.

### §9.1 — What MOTIR-2010 established (2026-08-04)

**It is ONE package, not nine — measured, because the size of the fix depended on
it.** Every profile is a TAG in a single OCI repository: an anonymous manifest
`GET` for `:claude`, `:codex` and `:base` each returns the _same_ challenge,
`scope="repository:moooon-b-v/motir-sandbox:pull"`, and `sandbox-images.yml`
pushes all of them under one `IMAGE: ghcr.io/moooon-b-v/motir-sandbox`. GHCR
visibility is per-package, so **one flip covers all eighteen tags** (nine moving,
nine versioned). ⚠️ A bearer challenge is issued for repositories that do not
exist either — `moooon-b-v/motir-sandbox-claude` is challenged just as readily —
so a challenge proves the registry will discuss a name, never that a package is
there. The positive evidence is the shared scope across tags that demonstrably
exist.

**The visibility flip is carried by its own `manual` card** (mirroring MOTIR-2009
for the runner), because it is a console action with no REST endpoint and it
cannot be undone.

**What MOTIR-2010 itself shipped is the missing ASSERTION**, which is the durable
half: `packages/cli/sandbox/smoke/assert-public.mjs`, run by a new
`sandbox-public` job that holds no registry login and no `packages:` scope. The
existing verify job authenticated first, so it asked the question as the
publisher — for whom a private package pulls fine — which is how nine
unobtainable images passed a green release. A positive control runs first and
downgrades the run to INDETERMINATE if it fails, since a broken probe reports
"private" about everything and "private" is the answer being hunted. §12.1's
control observation is now enforced on every release rather than performed by
hand once.

## §10 — What this binds

| Card                   | What it must now do                                                            |
| ---------------------- | ------------------------------------------------------------------------------ |
| **MOTIR-2006**         | §7's wiring; §6's preflight; the real boot. Blocked by MOTIR-2009.             |
| **MOTIR-2009** (new)   | Flip `motir-ci-runner` to public in the GHCR package settings UI (§8). Manual. |
| **MOTIR-1988/1989**    | The indexer image takes §5's mirror, with §5's three constraints.              |
| **Epic 9 (MOTIR-673)** | The agent image takes §5's mirror unless it is ever built from public source.  |
| **MOTIR-1928 / 1994**  | Their live verifications now have a pull path to verify against.               |

## §11 — Sources

- Fly Machines API `config` schema — <https://fly.io/docs/machines/api/machines-resource/> (read 2026-08-02)
- _"private third party registries are not supported by fly"_ (Kurt, Fly) — <https://community.fly.io/t/using-the-fly-machines-api-with-private-images/18552>
- _"only supports public images or the fly registry"_; `skopeo copy` workaround; GC discussion — <https://community.fly.io/t/securing-images-for-use-with-machines-api/23277>
- `registry.fly.io` scope + `fly auth docker` — <https://fly.io/docs/blueprints/using-the-fly-docker-registry/>
- Package visibility is UI-only and irreversible — <https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility>
- Live probes §2.1–§2.4 — Fly app `motir-2005-pullprobe`, created and destroyed 2026-08-02

## §12 — What MOTIR-2006 measured when it wired this (2026-08-02)

§2 promised that the implementing card would **re-run §2.1 and §2.2**. It did, after
MOTIR-2009 flipped the package public. Recorded here rather than only in a PR body, because
this is where the next person reading the decision will look for whether it came true.

**§12.1 — the runner image is now anonymously pullable, and the digest resolves.** The §2.1
probe, re-run: `GET https://ghcr.io/token?scope=repository:moooon-b-v/motir-ci-runner:pull`
now returns `{"token":"…"}` (it returned `UNAUTHORIZED` on 2026-08-02 before the flip), and
the manifest fetch for the pinned digest `sha256:446c692d…` returns **HTTP 200**,
`application/vnd.oci.image.index.v1+json`. **Control, unchanged:** the same token request for
`moooon-b-v/motir-sandbox` still returns `UNAUTHORIZED` — so the probe still distinguishes the
two states rather than having started saying yes to everything (§9's bug, MOTIR-2010, is also
still open, as that control shows).

**§12.2 — a REAL Fly Machine boots from the digest, and is destroyed.** `POST /v1/apps/{app}/machines`
with the pinned reference returned **HTTP 201**; the machine reached state `started` (Fly's own
event log: `launch pending` → `launch created` → `start started`, ~21.7 s later — image pull
included); `image_ref.registry` resolved to `ghcr.io`. It was then destroyed (`ok: true`), the
app's machine list read back empty, and the throwaway app was deleted. **Negative control, in
the same app, minutes apart:** the still-private `motir-sandbox` reference returned **HTTP 400**
`failed to get manifest …: unauthorized` and created no machine — which is the exact body
`isImagePullRefusal()` classifies in `flyMachines.ts`.

**§12.3 — what MOTIR-2006 could NOT prove, handed to MOTIR-1928 explicitly.** §12.2 ran in the
**`personal`** Fly org, not in **`motir-fleet`**, and that substitution is load-bearing enough
to name: the coding-agent sandbox has no `motir-fleet` credential. Verified rather than
assumed — the only Fly token reachable from the sandbox enumerates exactly one organization
(`personal`) and `GET /v1/apps?org_slug=motir-fleet` returns **HTTP 403**. Anonymous pull is a
Fly-platform behaviour, not an org-scoped one, so §12.2 establishes the MECHANISM; what remains
unproven is that `motir-fleet`'s **own app, token and region** boot this digest.
**MOTIR-1928 owns that**, stated here as an obligation rather than left implied — which is the
failure §0 says this story kept repeating.
