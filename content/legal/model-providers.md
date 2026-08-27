---
title: Model providers
version: 1.0.0
effectiveDate: TBD
status: approved
---

# Model providers

**This page lists every model provider that can serve a Motir AI request, and links to
each one's own data practices.** It is referenced by the
[subprocessor list](/legal/subprocessors), and it exists as a separate page for a
reason: the provider set changes when a channel is enabled, and a list that changes
should not be welded into a document that is versioned and re-approved.

**This page is informational and is updated whenever the provider set changes.** It does
not vary the [Terms of Service](/legal/terms), the [Privacy Policy](/legal/privacy) or a
signed [DPA](/legal/dpa), and no notice period attaches to an edit here. The
contractual commitments about model providers live in those documents; this page tells
you who the providers currently are.

**Last reviewed: 2026-08-27**, against the routing table of the running gateway.

---

## Where this sits: three products, one company

moooon B.V. builds three things, and a reader of this page benefits from knowing which
one is doing what — particularly because two of them are usable without the others.

| Product           | What it is                                                                            | Can be used on its own?                                                       |
| ----------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **motir-core**    | The planning and project-management application — the board, roadmap and work items   | **Yes.** It is open source and can be self-hosted as standalone PM software   |
| **motir-ai**      | The planning intelligence — it drafts and revises plans                               | **Yes.** It can plan into other project-management tools, not only into Motir |
| **motir-gateway** | The LLM routing layer — one interface in front of many model providers, with metering | **Yes**, and it is intended to be offered to other companies                  |

**None of the three is a subprocessor of the others.** A subprocessor is a _third party_
a processor engages. All three are moooon B.V., so naming them on a subprocessor list
would list a company to itself. What they run **on** — Fly.io — is a subprocessor, and
it is named on the [subprocessor list](/legal/subprocessors).

### What motir-gateway does with your prompt

For the hosted Motir service the path is:

```
motir-core  →  motir-ai  →  motir-gateway  →  the model provider you selected
```

**motir-gateway is a relay, not a model.** It holds no model of its own and produces no
answers. Its job is to accept an OpenAI-compatible request, decide which upstream
_channel_ can serve the model that was asked for, forward the request, meter what it
cost, and return the response. It is the same shape as a public routing service such as
OpenRouter, and it is built to be one.

Three consequences worth stating plainly, because they are what a reader actually wants
to know:

- **It does not train on your content, and neither does motir-ai.** Nothing you send is
  used to train, fine-tune or evaluate a model of ours.
- **It stores what it must meter, and that is a usage record, not a transcript.** Token
  counts, the model name, the channel and a timestamp — the fields a bill is computed
  from.
- **It cannot make a provider behave differently from its own terms.** Once a request
  reaches a provider, that provider's published data practices govern what happens to
  it. That is exactly why they are linked below rather than summarised.

---

## The providers

One row per provider, with the two facts that decide whether you want your content going
there: **how long it is kept**, and **whether it trains a model**. There is no ranking
here and no grouping — the providers differ along these axes and you choose against them,
which is the only honest way to present a set a customer selects from.

The **transfer basis** of each — adequacy, Standard Contractual Clauses, or none on offer
— is a separate question with its own table, in
[_Transfer bases_ on the subprocessor list](/legal/subprocessors).

| Provider          | Models              | Region                      | Prompt retention                                 | Trains on your prompts?                | Its data practices                                                                                                                                             |
| ----------------- | ------------------- | --------------------------- | ------------------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenAI**        | GPT, and embeddings | USA                         | Up to 30 days for abuse monitoring, then deleted | **No** — not on API content            | [Sub-processor list](https://openai.com/policies/sub-processor-list/) · published DPA                                                                          |
| **Anthropic**     | Claude              | USA                         | Zero Data Retention available                    | **No** — not on commercial API content | Published Data Processing Addendum, incorporated automatically on its commercial terms                                                                         |
| **Alibaba Cloud** | Qwen                | **Frankfurt, Germany (EU)** | _Not confirmed_                                  | _Not confirmed_                        | [EEA Data Processing Addendum](https://www.alibabacloud.com/help/en/legal/latest/ae8upq) · [GDPR trust centre](https://www.alibabacloud.com/trust-center/gdpr) |
| **DeepSeek**      | DeepSeek            | People's Republic of China  | _Not confirmed_                                  | _Not confirmed_                        | Published privacy policy and open-platform terms                                                                                                               |
| **Zhipu AI**      | GLM                 | People's Republic of China  | _Not confirmed_                                  | _Not confirmed_                        | `open.bigmodel.cn` platform terms                                                                                                                              |
| **Moonshot AI**   | Kimi                | People's Republic of China  | _Not confirmed_                                  | _Not confirmed_                        | [Kimi Open Platform terms](https://platform.kimi.ai/docs/agreement/modeluse)                                                                                   |
| **Brave**         | Search, not a model | USA                         | Up to 90 days for query records                  | Not applicable                         | Brave Search API Data Processing Addendum                                                                                                                      |

**⚠️ A cell reading _not confirmed_ is an OPEN ITEM, not a pass.** It means we have not
yet read that vendor's published answer, and it should be treated as unknown rather than
as favourable. The four rows carrying them are being closed; until they are, a workspace
that needs a retention or training guarantee should select a provider whose row states
one.

**Neither moooon B.V. nor its gateway trains on your content**, whichever provider you
select. The rows above describe what the _provider_ does once a request reaches it.

---

## Restricting where your requests go

The table exists so it can be acted on, not only read.

- **Choose the model per project.** That choice determines the provider, and at general
  availability the default is a provider whose retention and training rows are stated
  rather than open.
- **Hosted agents choose their own model**, which need not be the planner's — so a
  workspace can plan on one provider and execute on another.
- **The constraint is enforced where the request leaves.** The gateway routes on a
  residency group, and a provider without a recorded transfer basis cannot enter the
  group that serves EU traffic. A request that would breach it **fails rather than
  routing** — the correct failure, because a job that errors can be retried and a
  transfer that has happened cannot be undone.

---

## How this list is kept accurate

It is read from the gateway's own routing table, which is the thing that actually
decides where a request goes. It is **not** compiled from anyone's memory of which
integrations exist — that method failed four times in a single day on the subprocessor
list, which is why that page now carries a test and why this one records its method.

⚠️ **The read is currently manual, and that is a known weakness.** The routing table
lives in the gateway's database rather than in a repository, so no test in `motir-core`
can see it. Until this page is generated from that table, a provider enabled without a
corresponding edit here would go unlisted, and only a human re-run of this method would
find it.

Questions about anything on this page: **[legal@motir.co](mailto:legal@motir.co)**.
