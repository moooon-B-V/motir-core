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

### Approve and merge

In a project set to ask before merging, **Motir raises one approve-and-merge gate
on the work item a run delivered, once every pull request that run opened for it
has passed its checks** — one gate over all of them, whichever repositories they
are in. The work item's **Development** section shows it — the pull requests
themselves and the run's **How to test** — with one control, **Review & approve**.
That opens the approval full screen, and **that is where you answer it**: the
Development section, like every other section of the work-item page, never
carries the verbs itself.

A push to any of those pull requests **withdraws** the question: you would
otherwise be approving commits that are no longer the ones that merge. Nobody
decided it, and Motir asks again when every check is green. In a project set to
merge automatically, no gate is raised at all.

A **draft** pull request is never asked about, however green its checks: its
author has said it is not ready, and GitHub will not merge one. Motir asks when
the pull request is marked **ready for review**, and converting it back to a
draft withdraws a question that was already waiting.

### When a decision gate appears

A `type: decision` work item decided by an agent ships its decision as **one file under
`docs/decisions/`** in a pull request. When that pull request's head is seen, Motir asks
you to accept the decision: the work item's **Development** section shows the document
itself, rendered, with the pull request beneath it, and **Review & approve** opens both full
screen, where you answer. The document is the question; the pull request is what accepting
it merges. There is no _How to test_ part: a decision
ships a document, not something to run.

**One press answers both.** _Approve and merge_ records that you accept the decision and
merges its pull request — or, when its checks have not passed yet, the pull request
merges on its own once they do, with no second press. In a project that merges
automatically, the pull request still waits for your answer: an agent's decision never
merges before a person has accepted it.

**Approve is disabled when there is no single document to accept** — the pull request
adds none, adds more than one, the file is gone from its head, or Motir could not read
it. The section says which, in words. _Request changes_ stays available, because
sending it back to the agent is exactly what those cases need. A push that changes the
document withdraws the question and asks about the new version; a push that leaves the
document alone keeps your answer, and only the merge is asked again.

A decision card worked by a person asks nothing here: a person choosing between options
is a different question — the next section's.

### When a choice appears

A `type: choice` work item is a question the planner **declined to decide for you** —
two or more options, each with what it is **best for** and why, and a person picks one.
Nothing is recommended: that is what makes it a choice rather than a decision.

Motir asks it **on its own, from the work item's description**, as soon as the
description reads complete and nothing it waits on is still open. The work item's page
shows a **Choice** section with the question, **why it is a choice** (research
contradicts what you said, there is a better option than what you said, or your
requirement allows two workflows), the options and what the pick gates — and **Review &
choose**, which opens the full-screen view where you pick.

**Select an option, then press _Choose {option}_**, and confirm. Choosing records your
pick and moves the work item to **Done**, and then asks whether Motir AI should start
planning what the pick unblocks — see
[After you pick an option, Motir AI offers to plan the follow-up](#after-you-pick-an-option-motir-ai-offers-to-plan-the-follow-up).
_None of these — revise the options_ sends it back without moving anything, and the
question is asked again once the options change.

**What you chose is stamped on the record** — the option, what it was best for, why you
were asked and what it gates — and stays readable even if the description is edited
later. A description that is not complete asks nothing: the section says what is
missing instead, and nobody can choose until it is fixed. Editing the options of a
waiting choice withdraws the question and asks it again about the new options.

### When a decision asks you to confirm it

When a re-plan changes work you **already approved** — a different workflow, more
than was agreed, or less — the planner lays a `type: decision` work item on the epic
that says **why**. It is a decision the planner made **with you, in the
conversation**: it asks nothing new, and your job is to say whether that is what was
agreed.

Motir asks it **on its own, from the work item's description**, once the description
reads complete and nothing it waits on is still open. The work item's page shows a
**Decision** section with four parts — the **decision**, **what changed** and how,
the approved work it **supersedes**, and the epic's **resulting direction** in full —
plus the decision's written record, if it has one, as a link. **Review & confirm**
opens the full-screen view.

- **Confirm** records that you agree and moves the work item to **Done**. Nothing
  else changes: the work it supersedes was re-planned already.
- **Overturn** is for _"that's not what we discussed"_. It needs a short note saying
  what **was** discussed, moves the work item to **Cancelled**, and leaves a
  **re-plan owed** for the work it superseded. The overturn itself changes no other
  work item; the record offers **Re-plan with AI** so someone can start it — see
  [After you refuse a decision](#after-you-refuse-a-decision-motir-ai-offers-to-re-plan).

**The written record is optional.** For now it is a Markdown file attached to the
decision work item; confirming names that file on the record, and the record says
_Confirmed without a written record_ when there is none — never an error. If the file
is deleted later, the record still names it and says it was removed.

**Decisions accumulate.** A later decision on the same epic never replaces an earlier
one: both stay, each explaining the direction the epic took at the time. A decision
is a record of what was agreed, not a rule — where the code was changed on purpose
after a decision, the code is what the product does. A description that is not
complete asks nothing; the section says what is missing, and the work item can still
be moved to Done by hand.

### When a plan asks you to approve it

When you ask Motir AI to plan something, the planner tells you when it starts
writing the plan and that you can leave. **When the plan is ready, Motir asks you
to approve it**: a row appears in **To approve**, naming the plan and what it
proposes. You are the one asked because you asked for the plan. A plan the
auto-planner started on its own asks the workspace owner.

**Opening the row does not open the full-screen view.** It takes you back to the
planning surface, to the conversation that produced the plan, with the plan shown
for review. A plan with no conversation opens its own plan page instead. There
you can do one of three things:

- **Approve** turns the plan into work items, exactly as the plan's approve
  button always has.
- **Decline** ends the plan. Nothing is created. You can add a note saying why;
  it is not required.
- **Keep talking to the planner** to change the plan. The planner writes a new
  version of the same plan.

**There is no _Request changes_.** A plan is changed by talking to the planner,
so a request to change it would only wait for a conversation.

**While the planner is rewriting the plan, the question waits.** The row stays in
To approve, but **Approve** and **Decline** are refused until the planner
finishes, and the page says so. When it finishes, the same question can be
answered, about the new version. If you read the plan before the rewrite and
press Approve afterwards, Motir refuses and asks you to look at the new version
first.

A plan that becomes out of date because work it changes was finished or
cancelled elsewhere stops asking. Its row leaves To approve, and the plan page
says why.

Plans that were already waiting for approval before this shipped were given their
question once, when it was deployed. `pnpm db:backfill:plan-gates --dry-run`
confirms none was missed, and the same command without `--dry-run` repairs any
that were.

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

| verb                                 | what it records                                                                               | what it moves                                                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Approve**                          | that you said yes, to **this exact version**, and when                                        | the work item to **Done** — unless a pull request is going to merge for it, in which case see below                                  |
| **Request changes** on a **design**  | that you sent it back, your note explaining why, and your verdict — **Revise** or **Re-plan** | the work item back to **To do**, whichever verdict you chose — see [Sending back a design](#sending-back-a-design-revise-or-re-plan) |
| **Request changes** on anything else | that you sent it back, and your note explaining why                                           | **nothing.** The card stays where it is; the agent revises and publishes a new version to be decided                                 |

**Approving asks you to confirm. Sending something back asks you WHY.** Pressing
_Request changes_ — or _None of these_ on a choice — opens the same band, with a field
for your reason, and it will not send until you have written one.

**Why you are asked for a reason.** A refusal is the most useful thing a reviewer
tells the next person, and it is the one thing that was thrown away: the record said
_that_ you sent the work back, never _what_ you wanted instead. Whoever picks it up
next — a teammate, an agent, the planner — works from your reason, and anyone who
opens the card, the approval or the Approvals room later reads it, quoted, beside
who asked and when.

### After you refuse a decision, Motir AI offers to re-plan

Three refusals are about the **plan itself** rather than a version of some work:
**Request changes** on a decision document, **Overturn** on a decision you were asked
to confirm, and **None of these** on a choice. After one of them is recorded, the
planner is **offered, not opened**. The decided record asks, right where you pressed:

> **Re-plan {key} with Motir AI?** Motir AI opens on {key} with your reason already
> written as the first message. Nothing is sent until you send it — you can edit it
> first.

- **Re-plan with AI** (Enter) opens Motir AI on that work item, with your reason
  written into the message box as the first message. **Nothing is sent** until you
  press Send, so you can edit it, add to it, or clear it first. The approval view
  closes as the planner opens; closing the planner brings you back to the page.
- **Not now** (or Esc) opens nothing and keeps you on the decided record. The record
  now carries a **Re-plan with AI** button instead of the question.

**The button stays on the record.** Anyone who may plan on the work item sees
**Re-plan with AI** on those three decided records — on the work item's page and in
the approval view — and pressing it opens the same thing, with no second question. If
you already started that conversation recently, it takes you back to it rather than
starting a new one. The question itself is asked only once, to the person who pressed
the refusal; a reload shows the button.

A design sent back with **Re-plan** asks the same question — see the next section.

**Other refusals do not open the planner yet.** Sending back a story's recording or a
set of pull requests records your reason and moves nothing, as above; none of them
offers Motir AI today.

**Neither verb re-runs the agent.** Requesting changes records the decision. A design
sent back is at **To do**, ready for the next run, which is shown your reason — but
nothing starts that run for you: an automatic re-run on Motir's hosted agents is a
later feature.

### Sending back a design: Revise or Re-plan

On a design, **Request changes** asks for two things, and will not send until you
have given both: your **reason**, and a **verdict** — what kind of change you are
asking for. Nothing is chosen for you:

- **Revise** — _A small change: send it back to be redone._ The band tells you what
  happens: _{key} goes back to To do, and the next run starts from your reason._
- **Re-plan** — _This changes the work after it: re-plan with Motir AI._ The band
  says: _{key} goes back to To do, and Motir AI then offers to re-plan {parent}._

**Either verdict sends the design card back to To do.** A design sent back is not
finished and waiting for approval, so it no longer sits in review; it can be picked
up again like any card at To do. If the card also had a pull request waiting for you
to approve and merge, that question is withdrawn — its commits are about to change.
(A project whose workflow has no To do status records your reason and verdict and
leaves the card where it is.)

**The next run is shown your reason.** Whoever works the card next — an agent run, or
someone running `motir run` — is handed your reason under **Changes requested**,
beside the version you sent back, so the new version starts from what you asked for.

**The decided record names your verdict**, as _Sent back to revise_ or _Sent back to
re-plan_, above your quoted reason. The rows in _To approve_ and the Approvals room
lead with it.

**Revise asks nothing more.** The record and the card at To do are the whole answer.

**Re-plan then asks** before Motir AI opens, exactly as a refused decision does:

> **Re-plan {parent} with Motir AI?**

Here `{parent}` is the design's **story** — the work item the design belongs to —
because a design that changes the work after it changes the story's plan, not just
the design. **Re-plan with AI** opens Motir AI on that story with a first message
already written: your reason, quoted, and the work items waiting on the design.
Nothing is sent until you send it. **Not now** opens nothing, and the decided record
keeps a **Re-plan with AI** button that opens the same thing later, as above.

A design sent back on GitHub, rather than in Motir, carries no verdict: it records the
review, and the card stays where it is.

### After you pick an option, Motir AI offers to plan the follow-up

A choice exists because the planning stopped until someone picked. Once you press
**Choose {option}** and confirm, the decided record asks, right where you pressed:

> **Plan the follow-up with Motir AI?** Motir AI opens on {key} and starts planning the
> follow-up right away, from your choice. There is nothing to write or send — your
> choice is the first message.

- **Plan with AI** (Enter) opens Motir AI on the work item the choice sits under — or on
  the project, when the choice has no open container — and **the planning starts at
  once**. Your choice is sent for you as the first message (the option, what it is best
  for, and what the choice gates), so there is nothing to type, review or send. Saying
  yes is what spends the AI credits for that first message.
- **Not now** (or Esc) opens nothing and keeps you on the decided record, which now
  carries a **Plan with AI** button in place of the question.

**The button stays on the record.** Where the record used to say _"Follow-up planning
owed"_, it now shows what the choice gates and a **Plan with AI** button, for anyone who
may plan on the work item — on its page and in the approval view. Pressing it starts the
planning the same way; if you already started that conversation recently, it takes you
back to it and sends nothing again. The Plans page lists the conversation as the
**Follow-up to {key}**, with the option you chose.

**None of these is different.** It is a refusal, so it offers **Re-plan with AI**
instead, with your reason written into the message box and nothing sent until you send
it, as above.

### One qualification on Approve

Approve moves the card to Done **when nothing is going to merge for it.** If the
same card has a pull request open — which a design card usually does, because its
three files are committed like any other change — approving records the decision
without moving the card, and the merge is what finishes the card. Motir reads which
case you are in from the card itself; there is no setting, and nothing for you to
choose.

So on a design card with a pull request, approving is your **go-ahead to merge**
rather than the last step. The board keeps the card open until you do.

The rule underneath is worth knowing because it explains a board that looks
still: **exactly one thing ever writes Done.** Either the approval does, because
no merge is coming, or the merge does. Never both.

### Approve and merge, and what it does

On the approve-and-merge gate the verbs are **Approve and merge** and **Request
changes**.

- **Approve and merge** asks you to confirm, and lists every pull request first.
  It **records your approval before anything merges**, and the work item moves to
  **Approved**. Then each pull request merges — or, where its repository requires
  a merge queue, joins that queue and merges when the queue's checks pass. The
  work item moves to **Done** when every merge lands.
- **If one pull request cannot be merged**, the Development section says which
  and why, **your approval stands**, and that pull request offers **Retry merge**.
  After a reload it reads _Not merged yet_: the reason is not kept, so open the
  pull request to see it.
- **If the merge queue takes a pull request out**, its row reads **Left the
  queue** when its checks failed there (with the failing check linked when it
  is known), or **Removed from the queue** when someone took it out or the
  queue was cleared. A failure moves the work item back to **Implemented**.
  Your approval still stands: while the pull request is at the commits you
  approved, **Queue again** puts it back with no new question, and the work item
  returns to **Approved**. After a new push the row reads **New commits since
  approval** instead, and Motir asks again once every check is green. An
  ejected work item is not in _To approve_ — its question was already answered.
  In a project that merges automatically, the same row and a **Merge queue**
  note appear without a gate, and anyone who may edit the work item can press
  **Queue again**.
- **Request changes** records your note and moves nothing, as on every gate but a
  design's (see [Sending back a design](#sending-back-a-design-revise-or-re-plan)).

## Where you find what is waiting on you

**Workbench → To approve** lists every approval waiting on you in the active project, on one
page, with no pager. Each row reads as a sentence about the work item it is on:

- _Design for {title}_ — a design waiting for your look;
- _Acceptance video for story {title}_ — a story's recording;
- _{title} is finished_ — the work's pull requests passed their checks and wait for your yes;
- _Decision document for {title}_ — an agent's decision, shipped as a document;
- _Options for {title}_ — a choice for you to make;
- _{title} is decided_ — a decision on an epic waiting for you to confirm it.

The work item's key follows the sentence, and the column beside it holds the details — how many
files a design has, which repositories the finished work is in, what the decision says. The
repository and number of each pull request are in that column's tooltip, not on the row. A row
opens the approval full screen, over the page you are on.

If you ever have more approvals waiting than the list will show at once, a line under the last
row says how many are shown out of how many, and points you to **Approvals** in the project
rail, which lists every approval — waiting first, then decided — with the same rows.

## Who is asked, and who may answer

These are two different questions and Motir answers them differently on purpose.

- **Who is asked** — the work item's **assignee**, or its **reporter** when there
  is no assignee. Exactly one person. A question put to two people is a decision
  neither of them owns.
- **Who may answer** — the person who was asked (the assignee, or the reporter
  when there is no assignee), **or anyone holding the _Decide any approval_
  permission** (`approval:decide_any`). Workspace owners and admins and project
  Admins hold it by default, and a project can grant it to a custom role — a QA
  lead, say — without granting anything else.

Widening the second costs the first nothing: a permission-holder who decides
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

## Approving on GitHub

If your team reviews code on GitHub, you do not have to approve a second time in
Motir. **Approving every one of a card's pull requests on GitHub approves the card**,
and — because approving is the instruction to merge — those pull requests then merge,
or join their repository's merge queue, exactly as if someone had pressed _Approve
and merge_ here.

**Every one of them, at the commit that would be merged.** A card can deliver several
pull requests, and the question Motir asks is about all of them together. So one
approval out of two changes nothing yet: the card keeps waiting, and the row you
approved shows **Approved** so you can see where it has got to. The moment the last
one is approved, the card moves to **Approved** and the merges start.

**Which approvals count** — the same ones GitHub itself counts:

- the reviewer can write to the repository;
- the review is at the pull request's **current commit**. If someone pushes after
  you approve, your approval no longer describes the code, and the row says
  _Approved an earlier commit_ rather than silently ignoring it;
- the review has not been dismissed, and a comment-only review is not an approval.

**Requesting changes on GitHub** is an answer too: it decides the card's question,
records who asked and that it happened on GitHub, and merges nothing. The card stays
in review. **What the reviewer wrote in the review is kept as the reason**, and a
review with no text reads _No reason given on GitHub_ — Motir never refuses a GitHub
review for having no reason, because nobody pressed anything in Motir.

**A reviewer who has no Motir account.** This is ordinary on a repository Motir
hosts, and the record says so plainly rather than leaving a blank: it names their
GitHub handle and adds **Not a Motir member**. The approval counts exactly the same
— what changes is only how much Motir can tell you about who they are.

**Motir never writes to your review history.** It posts no review, no comment and no
status to GitHub, in either direction. Approving in Motir approves in Motir.

**In a project that merges automatically** no approval is asked for at all, so a
review on GitHub is recorded and decides nothing; the merge is the automatic one.

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

- **Merging from Motir is new and partial.** In a project set to ask before merging,
  a pull request whose checks all pass gets a merge gate, and approving it merges the
  pull request (or adds it to the repository's merge queue). In a project set to merge
  automatically, Motir merges it with no gate and records on the pull request that the
  setting allowed it; a refusal is posted as one comment on the work item. GitLab
  merge requests are not merged from Motir.
- **Motir does not review a pull request's diff.** The approve-and-merge gate
  asks you to approve the commits whose checks passed, and links out to each pull
  request; outside a gate, merging still happens on GitHub.
- **There is no per-project setting** that turns any of this on or off.
- **No email and no bell notification** is sent when a gate is raised.
- **Approving a plan through To approve is decided but not built yet.** Its rules
  are in the decision record's §11. Until it ships, a plan is still approved or
  declined only from its own plan page and the planning surface, and it does not
  appear in To approve.

Each is a separate piece of work, and this page will grow as they land.
