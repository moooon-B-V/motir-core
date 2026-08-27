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

Grouped by their transfer position, because that is the difference that matters and it
does not track the flag on the company.

### No transfer outside the EEA

| Provider          | Models | Where it runs                                                             | Its data practices                                                                                                                                             |
| ----------------- | ------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Alibaba Cloud** | Qwen   | **Frankfurt, Germany.** Model Studio, with the deployment scope pinned EU | [EEA Data Processing Addendum](https://www.alibabacloud.com/help/en/legal/latest/ae8upq) · [GDPR trust centre](https://www.alibabacloud.com/trust-center/gdpr) |

Inference stays inside the Union, so Chapter V of the GDPR does not engage at all. This
is the strongest position on this page, and it belongs to a Chinese company's model —
which is worth stating, because the intuition that a Chinese model implies a Chinese
transfer is simply wrong, and this row is the counter-example.

### Transfer outside the EEA, with a processing agreement and Standard Contractual Clauses

| Provider      | Models               | Where it runs | Its data practices                                                                     |
| ------------- | -------------------- | ------------- | -------------------------------------------------------------------------------------- |
| **OpenAI**    | GPT, and embeddings  | USA           | [Sub-processor list](https://openai.com/policies/sub-processor-list/) · published DPA  |
| **Anthropic** | Claude               | USA           | Published Data Processing Addendum, incorporated automatically on its commercial terms |
| **Brave**     | Search (not a model) | USA           | Brave Search API Data Processing Addendum                                              |

Each publishes an Art. 28 processing agreement incorporating the Commission's Standard
Contractual Clauses (Modules 2 and 3, Decision 2021/914). Anthropic additionally offers
Zero Data Retention. These are ordinary, documented transfers.

### Transfer outside the EEA, with no processing agreement on offer

| Provider        | Models   | Where it runs              | Its data practices                                                           |
| --------------- | -------- | -------------------------- | ---------------------------------------------------------------------------- |
| **DeepSeek**    | DeepSeek | People's Republic of China | Published privacy policy and open-platform terms                             |
| **Zhipu AI**    | GLM      | People's Republic of China | `open.bigmodel.cn` platform terms                                            |
| **Moonshot AI** | Kimi     | People's Republic of China | [Kimi Open Platform terms](https://platform.kimi.ai/docs/agreement/modeluse) |

**None of these three publishes an Art. 28 processing agreement or Standard Contractual
Clauses for its hosted API.** What that means — and, just as importantly, what it does
not — is set out in full under
[_The three providers without a processing agreement_](/legal/subprocessors). The short
version: it is a gap in three vendors' paperwork, **not** a consequence of where they
are established. SCCs are available for transfers to any third country, and the row at
the top of this page is a Chinese provider with a clean instrument.

---

## Choosing, and restricting

**The model is selected per project.** At general availability the default is a provider
from one of the first two groups, so reaching the third is a deliberate choice made with
this page available. Hosted agents select their own model, which need not be the same
one the planner uses.

**The constraint is enforced where the request leaves**, not by convention: the gateway
routes on a residency group, and a provider with no recorded transfer basis cannot enter
the group that serves EU traffic. A request for a model that would breach the constraint
fails rather than silently routing — the correct failure, because a planning job that
errors can be retried and a transfer that has happened cannot be undone.

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
