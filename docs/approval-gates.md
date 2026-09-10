# Approval gates

An **approval gate** is Motir asking one person one question and holding the work
until they answer it. It is how a human stays in the loop when an agent has done
something that needs a yes before anything else moves.

This page describes the gate that ships today: the one raised when an agent
publishes a **design result**. The approve language is deliberately one language
rather than one per thing being decided, so the rest of this page is mostly true
of the kinds that come later too — but only the design gate exists right now, and
[What does not exist yet](#what-does-not-exist-yet) says so explicitly rather
than leaving you to find out.

The decision record behind it is
[`docs/decisions/approval-gates.md`](./decisions/approval-gates.md).

---

## When a gate appears

A `type: design` work item's agent finishes by publishing its design result — the
mock, the notes and the screenshot — onto the card. **Motir raises the gate in
the same moment**, not when somebody opens the page. Until then there is nothing
to decide, and after it the card is waiting on a person rather than on an agent.

You will find it on the work item's page, in the **Design result** section.

## What you see

The gate always renders as the same three bands, in the same order, and the order
is the point:

1. **What you are looking at** — the kind of decision, which version it is asking
   about, when it arrived, and where the decision stands.
2. **The subject itself, rendered.** For a design result that is the mock, the
   notes and the screenshot — the actual thing, not a link to it.
3. **The verbs**, underneath — because you decide after you look.

An Approve button with nothing above it is not a review, which is why the frame
is built this way and why the buttons are never moved above the subject.

## The two verbs, and what each one does

| verb                | what it records                                        | what it moves                                                                                        |
| ------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| **Approve**         | that you said yes, to **this exact version**, and when | the work item to **Done** — unless a pull request is going to merge for it, in which case see below  |
| **Request changes** | that you sent it back, and your note explaining why    | **nothing.** The card stays where it is; the agent revises and publishes a new version to be decided |

**Approving asks you to confirm.** Sending something back does not — a reversible
act asked about twice is friction rather than care.

**Neither verb re-runs the agent.** Requesting changes records the decision; the
revise loop that dispatches a new run off the back of it is not built yet.

### One qualification on Approve

Approve moves the card to Done **when nothing is going to merge for it.** If the
same card has a pull request open — which a design card usually does, because its
three files are committed like any other change — approving records the decision
and moves nothing, and the merge is what finishes the card. Motir reads which
case you are in from the card itself; there is no setting, and nothing for you to
choose.

So on a design card with a pull request, approving is your **go-ahead to merge**
rather than the last step. The board keeps the card open until you do.

The rule underneath is worth knowing because it explains a board that looks
still: **exactly one thing ever writes Done.** Either the approval does, because
no merge is coming, or the merge does. Never both.

## Who is asked, and who may answer

These are two different questions and Motir answers them differently on purpose.

- **Who is asked** — the work item's **assignee**, or its **reporter** when there
  is no assignee. Exactly one person. A question put to two people is a decision
  neither of them owns.
- **Who may answer** — the **assignee, the reporter, or an admin**. Three people
  can press a button that was shown to one.

Widening the second costs the first nothing: a reporter or an admin who decides
from the work-item page never has the gate appear in their own queue. It exists
so that a gate whose one recipient is on leave, has left, or was never the right
person is not a permanent stop.

Anyone who can see the card but may not decide it sees the state and no buttons.

## What is kept

**Approving keeps the version you approved, indefinitely.** A design that is
published again normally supersedes the old one and its files are reclaimed after
a week; an approved version is exempt, so _"what did I actually say yes to?"_ has
an answer months later.

**Sending a version back does not keep its files.** The record of the decision is
kept — who, when, and the note — and the design it was about is allowed to go.
That is the intended trade: the trail still says _you sent v1 back on the 8th
because the confirm step was wrong_, and it does not keep a picture of v1.

**Approvals accumulate.** If a card is reopened and a new design approved, both
approved versions are kept — the second does not replace the first.

## After the decision

A decided gate is **final**. There is no edit path: a record of a decision that
can be changed afterwards is not a record of anything.

Reopening the card is still allowed, and is an ordinary board move (**Done → In
Progress**) that a person makes. The next run publishes a new design, which
raises a new gate to be decided on its own terms. No agent ever reopens a card
for you.

## What the decision keeps a record of

Every decided gate is written down as evidence, not as a status change with a
timestamp. It carries who decided it, when, **which exact version** they were
looking at, who the question had been put to, under which relationship to the
card they were entitled to answer, whether it arrived through the app, the API or
an agent, what it caused, and their note.

The name of the person who decided is stored beside the link to their account, so
a decision stays attributable after they leave the workspace. That matters
because _nobody decided this_ and _the person who decided this has gone_ must not
read the same afterwards.

## What does not exist yet

Stated plainly, because a document that only describes what works leaves you
guessing about the rest:

- **There is no Approvals tab.** Gates are decided on the work item's own page.
  There is no single place that lists everything waiting on you.
- **Motir does not merge pull requests**, and there is no gate for approving or
  merging one. Merging still happens on GitHub.
- **There is no per-project setting** that turns any of this on or off.
- **There is no gate for approving a decision document**, though the language is
  built to take one.
- **No email and no bell notification** is sent when a gate is raised.

Each is a separate piece of work, and this page will grow as they land.
