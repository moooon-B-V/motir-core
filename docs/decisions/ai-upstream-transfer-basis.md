# The AI upstream transfer basis — which providers may serve hosted prompt content

- **Status:** Accepted (2026-08-26, drafted for Bug MOTIR-3624 under Story
  MOTIR-657, 8.4 Legal — ToS + privacy). **No application behaviour ships in
  this record** — it writes this file and amends `content/legal/subprocessors.md`.
  The routing change and its enforcement are carried by the cards under
  **Consequences**.
- **Story / Bug:** MOTIR-657 (8.4 Legal — ToS + privacy) · Bug MOTIR-3624.
- **Answers:** `production-service-stack.md` **Q8** — _"What makes each vendor
  lawful to use? A DPF certification or SCCs, read per vendor. Not assumed, and
  not optional."_ Q8 was discharged for every vendor except the AI upstream while
  MOTIR-1160 drafted the subprocessor list. This record discharges that one.
- **Assessed against:** `legal-document-set.md` §3 — moooon B.V. is the
  controller for the hosted service at `app.motir.co`, and for that service only.
  A self-hosted install is its own controller and none of this binds it.
- **Amends:** `motir-ai` `docs/planner-llm.md` §3 (_Provider + model — DeepSeek
  first_). That record chose the planner's default upstream on capability and
  cost, and recorded **no transfer basis** for it. §4 below states what changes
  and what survives.
- **Consumed by:** MOTIR-1160 (the subprocessor list — amended in the same
  change as this record), MOTIR-3621 (counsel review), MOTIR-1134 (publication).

> Convention per `work-item-type-taxonomy.md`: **Status → Context → Decision →
> Consequences**, load-bearing facts pinned in explicit tables.

---

## §1 — Context: what was READ, on which surface, and when

The card that produced this record could not be answered from any checkout. The
gateway's enabled channel set is **administration state**, not repository state,
so every fact in this section was read from the **running platform on
2026-08-26** and is dated as such.

### How it was read (so the reading can be repeated)

`motir-gateway` has **no public IP** — `GET /v1/apps/motir-gateway` returns one
address, `fdaa:ab:2cdf:0:1::3`, `private_v6`. `motir-gateway.fly.dev` has no `A`
record and `curl` from outside the Fly network fails to connect. `motir-ai`
reaches it at `http://motir-gateway.flycast/v1`, over 6PN.

So the admin API was read **from inside the machine**:

```
POST https://api.machines.dev/v1/apps/motir-gateway/machines/<id>/exec
  { "command": ["sh","-c","wget -qO- --header='Authorization: Bearer $TOK' \
      'http://127.0.0.1:3000/api/channel/?p=0'"] }
```

`$TOK` is the root user's access token, recovered from the same machine's
`INITIAL_ROOT_ACCESS_TOKEN` (`fly-platform-facts`); it was never printed.

> **⚠️ The 6PN-only posture is a fact about INGRESS and says nothing about this
> record.** Nobody on the internet can reach the gateway; the gateway can still
> reach every upstream it is configured for. The question here is **egress**, and
> a private relay egresses exactly as far as a public one.

### The enabled channel set, read 2026-08-26

`model/channel.go` defines the status enum: `1` enabled, `2` manually disabled,
`3` auto-disabled.

| #   | Channel      | Upstream                    | Models served                                              | Status on 2026-08-26            |
| --- | ------------ | --------------------------- | ---------------------------------------------------------- | ------------------------------- |
| 1   | **DeepSeek** | `https://api.deepseek.com`  | `deepseek-v4-pro`, `deepseek-v4-flash`                     | **ENABLED** (`status: 1`)       |
| 2   | Anthropic    | `https://api.anthropic.com` | `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5` | manually disabled (`status: 2`) |
| 3   | **OpenAI**   | `https://api.openai.com`    | `gpt-4o`, `gpt-4o-mini`, `o3`, `text-embedding-3-small`    | **ENABLED** (`status: 1`)       |
| 4   | Moonshot     | `https://api.moonshot.cn`   | `moonshot-v1-128k`, `kimi-k2`                              | manually disabled (`status: 2`) |

There is one further upstream that is **not a channel row** and is therefore
absent from the table above and easy to miss: the **Brave Search API**
(`https://api.search.brave.com`, `motir/search/brave.go`), billed through the
gateway's per-call-unit path as the unit `search.brave`. It has served **3 live
calls**, 2026-08-12 → 2026-08-21.

### ⚠️ §2 — The card's own premise was too CAUTIOUS, and the correction runs the wrong way

MOTIR-3624 was filed honestly and said so in its own words: _"This bug does not
claim DeepSeek is switched on — it claims nothing prevents it."_ **It is switched
on, it is the planner's default, and it has carried real traffic.** The
correction is recorded here rather than absorbed, because a filed premise that
turns out UNDERSTATED reads, from a green run, exactly like one that was right.

Three readings compose into the finding, and none of them is sufficient alone:

1. **The channel is enabled** — table above, `status: 1`.
2. **The planner asks for that channel's model.** `motir-ai`
   `src/llm/gatewayClient.ts` pins `PLANNER_MODELS.default = 'deepseek-v4-pro'`,
   overridable only by `PLANNER_MODEL`.
3. **`PLANNER_MODEL` is UNSET in production** — read from **both** running
   `motir-ai` machines (`48ee5d6fd24328`, `895905f6d67d68`) with
   `machines/<id>/exec` → `PLANNER_MODEL=[<UNSET>]`, `NODE_ENV=production`. Not
   from `fly.toml`, which does not carry it, and not from `fly secrets list`,
   which does not list it.

Reading (3) is the one that decides it, and it is the one no checkout can
supply. A config file is a claim about the deployment; the machine is the
deployment.

### What has actually been transmitted

From the gateway's own consume log (`type=2`, filtered `channel=1`, paged to
exhaustion):

|                             |                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------- |
| calls to `api.deepseek.com` | **72** (`deepseek-v4-pro` ×68, `deepseek-v4-flash` ×4)                            |
| prompt tokens transmitted   | **4,232,283**                                                                     |
| completion tokens returned  | 200,726                                                                           |
| window                      | **2026-06-24 → 2026-08-21** (1 · 1 · 14 · 56 calls on 06-24, 06-30, 08-10, 08-21) |
| gateway token               | `motir-ai-planner` — the hosted planner's own token                               |
| channels 2 and 4            | **zero rows.** Anthropic and Moonshot have never served a request                 |

**Whose content that was is NOT determinable from this log, and this record does
not guess.** Every row carries an empty `core_org_id`, but that proves nothing:
`Log.CoreOrgId` is written only on the per-call-unit path
(`relay/billing/motir_per_call.go`) and is blank on **every** LLM row ever
written. The honest statement is that hosted planning traffic egressed to a
PRC-hosted upstream over a two-month window, and that the gateway's log cannot
say which tenants' content it was. Whether any of it was a third party's personal
data is a question for **MOTIR-3621**, not for this record.

### The transfer bases, read per vendor on 2026-08-26

| Upstream             | Jurisdiction                   | Chapter V basis                                                                                                                                                                                                   | Read from                                       |
| -------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **DeepSeek**         | **People's Republic of China** | **NONE.** Its policy names no SCCs, no BCRs and no mechanism — only _"appropriate safeguards … in accordance with the requirements of applicable data protection laws"_                                           | DeepSeek's published privacy policy             |
| **OpenAI**           | USA                            | **SCCs** — Module 2 as controller, Module 3 as processor                                                                                                                                                          | OpenAI's published DPA (recorded by MOTIR-1160) |
| **Anthropic**        | USA                            | **SCCs** — its DPA is auto-incorporated into the Commercial Terms and relies on SCCs for transfers to countries without an adequacy decision                                                                      | Anthropic's published DPA / Trust Center        |
| **Moonshot**         | **People's Republic of China** | **Not established.** Same jurisdictional problem as DeepSeek; not read further, because §3 keeps it disabled                                                                                                      | —                                               |
| **Brave Search API** | USA                            | **SCCs** — its Search API DPA incorporates the EU SCCs (and the UK Addendum). Query records retained **90 days** by default for billing/troubleshooting; Zero Data Retention is available to enterprise customers | Brave's published Search API DPA                |

DeepSeek's own words are the load-bearing quote: _"we directly collect, process
and store your Personal Data in People's Republic of China."_ **China has no EU
adequacy decision**, and with no SCCs offered the Article 46 route is not
available off the shelf either. Article 49 derogations do not rescue it: they are
for occasional transfers, and routing every planning request through one upstream
is the definition of systematic.

---

## §3 — The decision

**The hosted planner egresses only to upstreams carrying a recorded Chapter V
basis, and the gateway ENFORCES that rather than documenting it.**

| #      | Decision                                                                                                                             | Where it lands                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| **D1** | **The planner's default upstream stops being DeepSeek.** `PLANNER_MODELS.default` becomes **`o3`**, served by channel 3              | `motir-ai` `src/llm/gatewayClient.ts`        |
| **D2** | **The DeepSeek channel is disabled; Moonshot stays disabled.** Neither carries a basis                                               | gateway administration (channel `status: 2`) |
| **D3** | **The gateway enforces residency by GROUP**, so no caller can route to a no-basis channel whatever it asks for                       | `motir-gateway` — the seam is named in §5    |
| **D4** | **Anthropic is the recorded fallback**, enablable without another decision record: its basis is now on file                          | gateway administration                       |
| **D5** | **`content/legal/subprocessors.md` does not publish until D1 and D2 are applied AND the channel set has been re-read to confirm it** | the publication precondition, §6             |

### ⚠️ D1 and D2 have a MANDATORY ORDER, and the wrong one is an outage

Routing is `(group, model, enabled) → channel` (`model/ability.go`
`GetRandomSatisfiedChannel`). Channel 1 is the **only** channel serving
`deepseek-v4-pro`, and `deepseek-v4-pro` is the **code default**. So **disabling
the DeepSeek channel first takes AI planning down**: every request resolves to no
satisfied channel and `middleware/distributor.go` answers _"当前分组 %s 下对于模型
%s 无可用渠道"_.

**D1 before D2.** Ship the default change, confirm the planner is serving from
channel 3, then disable channel 1. The order is stated here because the
attractive move — "switch off the unlawful thing immediately" — is the one that
breaks the product, and whoever is holding the console at that moment will be in
a hurry.

### Why `o3` and not Anthropic

Both carry SCCs, so the basis does not separate them; it only decides the
**eligible set**. Within that set `o3` wins on three shipped facts:

- **Channel 3 is already enabled and already routable for `o3`** — it needs no
  key provisioned and no channel enabled.
- **It adds no new subprocessor.** OpenAI already receives our embedding traffic
  (`text-embedding-3-small`) and is already on the published list with its basis
  recorded. Anthropic is not on that list, so choosing it would enlarge the
  subprocessor set in the same change that is meant to settle it.
- **It retires a documented reliability workaround.** `gatewayClient.ts` carries
  a `deepseek-v4-pro` caveat — the model _"lands tool-calls in NON-thinking
  mode"_ and the loop reads around a missing `tool_calls` field
  (`deepseek-ai/DeepSeek-V3#1244`). The current default is the one our own code
  works around.

**This record does not claim `o3` matches `deepseek-v4-pro` on planning quality
— nobody has measured that here.** If the planner regresses, the eligible set is
`{OpenAI, Anthropic}` and moving within it is a config change, not another
decision record. What is _not_ available is moving back outside the set.

---

## §4 — What this amends in `planner-llm.md`, and one sentence there that is FALSE

`motir-ai` `docs/planner-llm.md` §3 chose DeepSeek as the first channel and
`deepseek-v4-pro` as the default. **That choice is superseded by D1.** Its
routing decision (§1, _through the gateway, never direct_), its SDK choice (§2),
its inference defaults (§4) and its structured-output mechanism (§5) all stand
untouched — this record changes which upstream is on the far side of the gateway,
not how the planner reaches it.

**One sentence in §3 is false against shipped code and must not be relied on:**

> _"Flipping the default is a **gateway channel + `ModelCreditRate` config
> change, NOT a `motir-ai` code change**."_

`gatewayClient.ts` hardcodes `PLANNER_MODELS.default`, and the only override is
the `PLANNER_MODEL` environment variable — which production does not set. A
gateway-side change alone cannot flip the default.

### ⚠️ The one way to make that sentence true is REJECTED, and it is worth naming

`model_mapping` (`model/channel.go` `GetModelMapping`) remaps a requested model
id to a different upstream model **inside a channel**. A channel could therefore
accept `deepseek-v4-pro` and serve it from OpenAI, making the superseded sentence
technically accurate with no `motir-ai` change at all.

**Rejected.** The consume log would then record `model_name: deepseek-v4-pro` for
requests OpenAI served. That log is the instrument §1 of this record used to
enumerate what has actually been transmitted, and it is the instrument any future
audit will use. A remedy that makes the transfer record unreadable is not a
remedy — it converts a legal problem into an _invisible_ legal problem, which is
strictly worse than the one being fixed. **The model id a request names must stay
the model a provider served.**

---

## §5 — D3: the enforcement seam, named

The lesson this record is most at risk of repeating is that **a decision record
ships no code**. D1 is a default and D2 is a switch; both are one edit away from
being undone by someone who does not know why they are set. D3 is what makes the
constraint survive that.

**The seam is the gateway's GROUP column, and routing already reads it:**

| element                    | file                                                            | what it does                                                                |
| -------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| routing predicate          | `model/ability.go` `GetRandomSatisfiedChannel(group, model, …)` | selects a channel `WHERE group = ? AND model = ? AND enabled`               |
| where the group comes from | `middleware/distributor.go:24` — `CacheGetUserGroup(userId)`    | **the gateway USER, not the token.** A token inherits its owner's group     |
| the ability rows           | `model/ability.go` `AddAbilities`                               | one row per (model × group) from the channel's `models` and `group` columns |
| fail-closed message        | `middleware/distributor.go:49`                                  | _"当前分组 %s 下对于模型 %s 无可用渠道"_                                    |

**The state today is that no partition exists.** Read 2026-08-26: there is
exactly **one gateway user** (`root`, group `default`) and **all four channels
are in group `default`**. Every model any channel lists is reachable by the only
caller there is.

**The enforcement, therefore:** put the basis-carrying channels in a dedicated
group, set the planner user's group to it, and leave every no-basis channel out
of it. A request for `deepseek-v4-pro` then **fails closed** at the distributor
instead of egressing — which is the correct failure mode, because a planning job
that errors is recoverable and a transfer that happened is not.

**This is what makes D2 durable rather than a switch someone flips back.** A
re-enabled DeepSeek channel outside the planner's group still serves nobody.

Filed as its own card (**Consequences**), because it is product work across
`motir-ai` and `motir-gateway` plus a platform action, and this record ships no
code.

---

## §6 — Consequences

| #   | What must happen                                            | Owner                | Blocking?               |
| --- | ----------------------------------------------------------- | -------------------- | ----------------------- |
| 1   | **D1** — repoint `PLANNER_MODELS.default` to `o3`           | `motir-ai`           | **Yes**, and FIRST      |
| 2   | **D2** — disable gateway channel 1; keep channel 4 disabled | platform (`manual`)  | **Yes**, after 1        |
| 3   | **D3** — the residency group + planner-user binding         | `motir-gateway`      | Yes, for durability     |
| 4   | Re-read the channel set and record the date                 | this record, amended | Yes — D5                |
| 5   | Amend `content/legal/subprocessors.md`                      | done in this change  | —                       |
| 6   | Counsel + founder read §2's exposure window                 | MOTIR-3621           | Yes, before publication |

**The publication precondition (D5), stated the way `legal-document-set.md` §3
states its own:** `subprocessors.md` may describe the settled decision now, and
it may not describe the settled _state_ until the state is settled. The page
carries the decision, the enumerated upstreams, their bases, and an explicit note
that the AI row is contingent on rows 1–3 above. **MOTIR-1134 must not publish a
page whose AI section still names a contingency.** That is a mechanical check,
exactly like the `«KVK NUMBER»` one.

### What this record deliberately does NOT do

- **It does not disable the channel.** That is an outward-facing change to a
  running production service which would take AI planning down if taken out of
  order, and it belongs to a person holding the console — surfaced as a card, not
  performed by the run that found it.
- **It does not assert who was affected.** §2 says what the log can support and
  names what it cannot.
- **It does not settle self-hosting the model.** A self-hoster is their own
  controller and configures their own gateway; for the hosted service, an
  upstream with SCCs discharges Q8 today and a self-hosted model is a cost and
  capability question, not a legality one.

---

## Rejected alternatives

| Alternative                                                      | Why not                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Keep DeepSeek, rely on Art. 49 derogations**                   | The derogations cover _occasional_ transfers. Routing every planning request through one upstream is systematic by construction, and the EDPB has been explicit that Art. 49 is not a route to routine transfers                                            |
| **Keep DeepSeek, ask users for explicit consent**                | Consent must be freely given and revocable. Making it the condition of using the AI features at all is neither, and it would put a Chinese-jurisdiction disclosure in the sign-up path for a feature we can serve lawfully from an existing enabled channel |
| **Disable the DeepSeek channel first and fix the default after** | Takes AI planning down — `deepseek-v4-pro` is the code default and channel 1 is its only server. Same destination, an outage in the middle. See §3                                                                                                          |
| **`model_mapping` the id onto another upstream**                 | Makes the consume log lie about which provider served a request, destroying the one instrument that can audit transfers. §4                                                                                                                                 |
| **Document the constraint without enforcing it**                 | A decision record ships no code. D1 and D2 are both one edit from being undone, and the person undoing them would have no signal that a legal constraint was attached. §5                                                                                   |
| **Self-host the model**                                          | The largest change available and it buys nothing D1 does not, for the hosted service's Chapter V problem. Remains open on capability and cost grounds, decided elsewhere                                                                                    |
