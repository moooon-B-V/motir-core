# ADR: Guided manual work — a manual card is guided by Motir AI, not run; a manual child in a parent run is a gate; **To approve** becomes **Waiting on you**

- **Status:** Proposed (2026-10-03, planner-recorded for MOTIR-7458). It writes
  down a direction the requester settled in one message on 2026-10-03, so they
  can confirm at this card's decision gate that it was understood. **No
  application behaviour ships with this record.**
- **Epic / Task:** MOTIR-6010 (Refine AI planning) · Task MOTIR-7458.
- **Consumed by:**
  - **MOTIR-7459** — _Guide me through a manual work item_. Its decision
    subtask MOTIR-7461 amends `conversation-turn-intent.md` with the guide
    turn's wire, job kind and write path.
  - **MOTIR-7460** — _A manual card in a parent run is a GATE that waits on a
    person_. Its decision subtask MOTIR-7472 amends `approval-gates.md` with the
    manual-work gate kind, and MOTIR-7476 renames the tab.
- **Builds on:** the shipped manual predicate (`lib/dto/ready.ts`
  `isManualReadyItem`; the CLI's `packages/cli/src/autoLoop.ts`
  `classifyReadyItem` → `needs_human`), the to-do list (`work-item-todo-list.md`,
  including its AMENDMENT 1 from MOTIR-6856), the conversation turn intents
  (`conversation-turn-intent.md`), the approval gates (`approval-gates.md`), and
  the CLI guide `motir guide` (MOTIR-6708).
- **Supersedes:** MOTIR-6010's body as approved before 2026-10-03. This plan
  re-authors it to add a seventh capability (guided manual work) and its
  boundary. No earlier decision on the epic is contradicted.
- **Superseded by:** none.

> Convention (set by `work-item-type-taxonomy.md`): a decision record is a
> markdown file under `docs/decisions/`, structured **Status → Context →
> Decision → Consequences**.

---

## Context

**What "manual" means today.** A work item is done by hand when
`executor === 'human' || type === 'manual'`. The server's `isManualReadyItem`
and the CLI's `classifyReadyItem` both use this predicate. This record keeps it
unchanged and calls such a card a **manual card**.

**What the product does with one today.** Three things, and none of them fit:

1. **The page offers Run.** A manual card's page has the same Run section as a
   code card. No agent can act on it, so the section offers something that
   cannot happen.
2. **A parent run skips it without saying much.** Inside a parent run a manual
   child is classified `needs_human`. It is skipped and only named in the run's
   summary. Nothing in the product asks a person to do it.
3. **Guidance exists only outside the product.** A person can be walked through
   a manual card's to-do list only by the CLI skill `motir guide` (MOTIR-6708),
   running in their own agent. MOTIR-6856 already said that until Motir has a
   secret store, _"a person works the list, guided by Motir"_. There is no
   in-product guide yet.

**The Workbench tab.** The tab at `?tab=approvals` is labelled **To approve**
(zh 待审批) and lists decisions only. The code already describes it as "what is
waiting on you" (`lib/workbench/tab.ts`; the strip-order comment in
`app/(authed)/workbench/_components/WorkbenchTabs.tsx`).

---

## Decision

### §1 — A manual card offers **Guide me through** in place of Run

A manual card's page shows no Run section. It shows a **Guide me through**
button. The predicate is the one above, unchanged.

### §2 — The guide is the one Motir AI overlay, in a GUIDE conversation

The button opens the existing Motir AI overlay, anchored on that card, in a
guide conversation. It is not a new surface.

| Area              | Shows                                           |
| ----------------- | ----------------------------------------------- |
| Right             | The conversation with Motir AI.                 |
| Left (the canvas) | The card's to-do list, ticked as the walk goes. |

**Changes to the list are made by asking Motir AI**, not by editing on the
canvas.

### §3 — A card with no list: save it, or walk it as a temporary list

If the card has no to-do list, Motir AI proposes one from the card and offers
two choices:

| Choice                          | Writes to the card | Can be resumed |
| ------------------------------- | ------------------ | -------------- |
| **Save to the card**            | Yes — the list     | Yes            |
| **Walk it as a temporary list** | Nothing            | No             |

The temporary walk is quicker. Motir AI **states the difference when it
offers the choice**: if the person stops part-way through a temporary walk, it
cannot be resumed.

### §4 — The walk: one step at a time, an animated tick, resume, offer to close

- Motir AI gives **one step at a time**.
- When the person confirms a step, Motir AI ticks it, **with an animation on the
  canvas**.
- On a **saved** list, a later guide **resumes where the person stopped**.
- When every step is ticked, Motir AI **offers to close the card**. It does not
  close it unasked.

### §5 — Motir AI may correct the list during the walk — never a ticked step, never silently

The list can be wrong. During the walk Motir AI may **add, rewrite, remove or
reorder** steps that are **not yet done**. It never changes a ticked step. It
says each change, and why, in the conversation.

### §6 — Motir AI may edit the guided card itself — that card only

The conversation can change what needs to be done, so Motir AI also edits the
guided card as it goes: its **title, description and explanation**. Each edit is
**stated in the conversation** and is **undoable**. It **edits no other card**.

### §7 — Files attached to a guide turn are kept on the card

The person may attach a **screenshot or a text file** to a guide turn. The file
is **attached to the card**, and Motir AI reads it. A temporary walk still
cannot be resumed (§3): the attachment is on the card, the walk is not.

### §8 — Motir AI never runs a step and never checks a third-party system

Motir AI **never runs a step itself**. It **never checks a third-party system**
(a dashboard, a DNS record, a provider console). It reads only Motir, and it
takes the person's word that a step is done. MOTIR-6856 stands unchanged: an
agent to-do is still never run by the hosted agent.

### §9 — In a parent run, a manual child is a GATE decided by doing the work

Inside a parent run, a manual child is no longer a silent `needs_human` skip.
It raises a **manual-work gate** that waits on a person. The gate is decided
**by doing the work**, through **Guide me through** or **Mark done**. There is
nothing to approve or decline.

**A parent run does not resume by itself when that gate clears.** The person
runs it again. A parent run that continues on its own belongs to MOTIR-6858
(Autonomous project lead), not here.

### §10 — The Workbench tab **To approve** is renamed **Waiting on you**

The tab that lists gates now holds **work to do** (§9) as well as **decisions to
approve**, so **To approve** no longer describes it.

| Language | Before     | After              |
| -------- | ---------- | ------------------ |
| en       | To approve | **Waiting on you** |
| zh       | 待审批     | **等你处理**       |

**The address does not change: it stays `?tab=approvals`.** The tab's code
already separates its action label from its slug (`WorkbenchTabs.tsx`: _"The
LABEL is an action and the SLUG is a set"_), so only the label moves.

**Alternatives weighed:**

| Name               | Verdict    | Why                                                                                                                                                            |
| ------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Waiting on you** | **Chosen** | Covers both a decision to approve and work to do. The Workbench already calls this tab "what is waiting on you" (`lib/workbench/tab.ts`, `WorkbenchTabs.tsx`). |
| _Needs you_        | Rejected   | Covers both kinds too, but it is a new phrase the code has never used for this tab.                                                                            |
| _Your turn_        | Rejected   | Reads as a turn order, which this tab is not. It is also a new phrase the code has never used for this tab.                                                    |

---

## Consequences

- **The epic gains a seventh capability.** MOTIR-6010 makes planning a governed,
  recoverable, self-correcting part of the product: surgical tools in every
  session, several trees from one conversation, the session as a record, the
  plan as an approval gate, refusals that come back with their reason, the
  obsolescence mark, and a difficulty on every leaf. It now also includes
  **Motir AI walking a person through manual work**. This plan's `modify` of
  MOTIR-6010 makes that edit, not this record.
- **Two technical contracts follow, each as an amendment owned by its story**
  (see _Consumed by_):
  - the guide turn's wire, job kind and write path → `conversation-turn-intent.md`
    (MOTIR-7459, via MOTIR-7461);
  - the manual-work gate kind → `approval-gates.md` (MOTIR-7460, via MOTIR-7472).
- **Every place that names the tab changes its label** (MOTIR-7476). Links and
  bookmarks keep working, because `?tab=approvals` does not change.
- **The CLI guide stays.** `motir guide` (MOTIR-6708) still walks a person
  through a card in their own agent. This record adds the in-product guide; it
  does not retire the CLI one.

---

## What this does NOT decide

- **The guide turn's wire format, job kind, prompt or write path.** Those are
  MOTIR-7461's amendment to `conversation-turn-intent.md`.
- **The manual-work gate's subject, routing, raise, withdrawal or data model.**
  Those are MOTIR-7472's amendment to `approval-gates.md`.
- **The visual design** of the Guide me through button, the canvas or the tick
  animation. Those are the stories' own design work.
- **Any change to the manual predicate.** It stays
  `executor === 'human' || type === 'manual'`.
- **Whether Motir AI may ever run a step or check a third-party system.** It may
  not under this record. A later runner, once Motir has a secret store, is
  MOTIR-6856's question and is not reopened here.
- **A parent run that resumes by itself** when a gate clears. That is
  MOTIR-6858's.
- **Renaming the `approvals` slug, or any other Workbench tab.**
- **Retiring the CLI `motir guide` skill.**
