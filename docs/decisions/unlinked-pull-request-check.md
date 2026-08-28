# The unlinked-pull-request check — what writes it, what it fires on, and how loud it is

**Status:** accepted · **Date:** 2026-08-27 · **Card:** MOTIR-3673 (story MOTIR-3672)

Story MOTIR-3672 retires the title/branch parse, so an explicit link becomes the
only thing that associates a pull request with a work item. Retiring it without
enforcement trades a WRONG link for a MISSING one, which is quieter and therefore
worse: a card whose pull request merged and which nobody moved looks exactly like
a card whose work never started. This decides the enforcement.

> **On the file name.** `docs/decisions/` is slug-named, not numbered, so this
> takes the next free SLUG — checked against `origin/main` and against every
> `refs/remotes/origin/*` branch (`git ls-tree <branch> docs/decisions/…`),
> because two parallel runs picking the same name collide exactly as two picking
> the same number would.

---

## Q1 — what WRITES the failing signal

### The permissions, read from the API rather than assumed

The card's first instruction was not to assume Motir can write a check. It
cannot. Read on 2026-08-27 with an App JWT signed by the deployed
`GITHUB_APP_PRIVATE_KEY`, `GET https://api.github.com/app`, from inside the
`motir-core` Fly machine (the only place the key exists):

| App                                           | id      | permissions                                                                                                                                                                                 | events                                             |
| --------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **`motir-integration`** — the user-facing one | 4206669 | `checks: read` · `contents: read` · `issues: read` · `metadata: read` · **`pull_requests: write`** · `security_events: read`                                                                | `check_run`, `check_suite`, `pull_request`, `push` |
| `motir-studio` — provisioning                 | 4445390 | `actions: read` · `administration: write` · `contents: write` · `metadata: read` · `organization_actions_variables: write` · `organization_self_hosted_runners: write` · `workflows: write` | `workflow_job`                                     |

**There is no `checks: write` and no `statuses` permission at all**, on either
App. `motir-studio` is not a fallback: it is installed only on `motir-projects`
(`repository_selection: all`) and is never installed where a user's repositories
live — that separation is `project-repository-set.md`'s 2026-07-30 amendment and
`lib/github/appAuth.ts`'s module header, and borrowing it here would erase it.

`GET /app/installations` returns exactly **one** installation of the user-facing
App: `144235820`, account `moooon-B-V`, `repository_selection: selected`, whose
granted permission set is byte-identical to the App's own. So there is no
already-diverged installation to reconcile — a useful fact for the re-consent
question below, and one that will not stay true.

### The three probes, and why they are safe to have run

A permission list is a claim about what the API will do; these are the API doing
it. Each probe is addressed so that an **authorized** call fails on validation
rather than creating anything, which makes the HTTP code the whole answer and
leaves no artifact behind either way. Run with an installation access token for
`144235820`:

| probe                                                                | result                                           | reads as                                              |
| -------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| `POST /repos/moooon-B-V/motir-core/check-runs` (`head_sha` all-zero) | **403** `Resource not accessible by integration` | the App cannot create a check run                     |
| `POST /repos/moooon-B-V/motir-core/statuses/<all-zero sha>`          | **403** `Resource not accessible by integration` | the App cannot create a commit status                 |
| `POST /repos/moooon-B-V/motir-core/issues/99999999/comments`         | **404** `Not Found`                              | the permission gate PASSED; only the issue is missing |

The third is the one worth pausing on. `pull_requests: write` already carries the
right to comment on a pull request, so **the ADVISORY mechanism is available
today at zero permission cost, and the BLOCKING one is not.** That asymmetry is
the real content of Q1, and it would have been invisible from the permission list
alone.

### Decision — **option A: Motir writes a CHECK RUN**, and the permission is added

Motir adds `checks: write` to the `motir-integration` App and writes a check run
on the pull requests in scope (Q2), from the deliveries it already receives.

**What it costs, stated rather than footnoted.** Adding a permission to a GitHub
App puts every existing installation into a pending state: the installation keeps
its OLD permission set until an account admin approves the new one, and until
then the App's writes are refused exactly as the probes above were refused. So an
installation that never re-consents **silently has no check** — not a broken one,
an absent one, which is the failure mode this whole story exists to end, one
level up.

**Today that cost is one approval by the `moooon-B-V` org owner**, because there
is exactly one installation. It is monotonically increasing in the number of
installations, and that is the argument for doing it now rather than after the
first outside user: the re-consent that costs one click today costs an email
campaign later.

**Why a check run and not a commit status.** Both need a permission we do not
have, so the cost is identical and the choice is on merit: a check run is
addressed by name (so it can be re-written in place as the answer changes),
carries a title, summary and text, is what a branch-protection rule names, and
can only be created by a GitHub App — which is what we are. A commit status has
no body and no update semantics beyond overwriting.

### Rejected — **option B: a workflow job in each repository**

A job in each repository calls a v1 endpoint and exits non-zero. Rejected on
reach, and the reach argument is the same one the parse existed for:

- **It only covers repositories that add the job.** The population the parse was
  kept for — a pull request opened by a person in a browser, in a repository
  nobody has instrumented — is precisely the population this misses.
- **There is no endpoint to call.** Every v1 resource today is keyed by work item
  (`/api/v1/work-items/[key]/…`) or project; nothing is addressed by pull
  request, so this needs a new PR-keyed resource, which is a public contract
  surface with its own versioning obligations.
- **It needs a credential per repository**, and one that can be used from a fork
  is one that leaks.

Recorded rather than omitted because it is the cheaper-looking option and its
flaw is a coverage gap, which does not show up in a demo.

### Rejected — **option C: a `REQUEST_CHANGES` review**

Worth recording because it is the only mechanism that is BLOCKING today with no
new permission: `pull_requests: write` allows submitting a review, and a
changes-requested review blocks merge wherever branch protection requires review
resolution. Rejected because the state it leaves behind is wrong: a review must
be dismissed or superseded, so linking the pull request does not clear it without
Motir also issuing a dismissal, and a review from an App reads to a human as a
code opinion rather than a bookkeeping signal. A check run is idempotent — the
same run name re-written to `success` — which is exactly the shape this needs.

---

## Q2 — what counts as UNLINKED

### The definition

**A pull request is UNLINKED when no `work_item_delivery` row names it.** That is
the whole rule. Not "no key in the title", not "no session branch", not "no
`work_item_id`" — the delivery table is the association after MOTIR-3655, and the
check asks the same question the completion gate asks.

### MOTIR-3656's Q0 answer, and what it does to the session-branch exemption

The card was written with two futures and told not to write the exemption before
reading which one landed. It landed. `docs/decisions/work-item-delivery-links.md`
(MOTIR-3656, accepted 2026-08-27):

> **There is ONE association between a work item and a pull request: a join
> table, many-to-many, carrying the repository.**

and, on this card by name:

> **What MOTIR-3673's exemption becomes — It disappears.** … Under this decision
> that pull request is linked to every card it delivers, from its first
> iteration, so the check passes on it for the ordinary reason. **MOTIR-3673's Q2
> should record the exemption as unnecessary rather than write it.**

**So no `motir auto` exemption is written.** A session pull request is linked to
each of the N cards it delivers by N rows, and it satisfies the check the same
way every other pull request does. The special case the card feared would be
baked in is not baked in.

### ⚠️ But the exemption is unnecessary only in the TARGET state, and the target state has not arrived

This is the one place where following the ADR literally would ship a permanently
red check on the busiest lane, so it is stated as a shipping-order constraint
rather than left to sequencing. Verified on `origin/main` at `f4b5793d7`:

- **`packages/cli/src` contains no call to `link_pull_request`, in any lane.**
  `grep -rn "link_pull_request\|linkPullRequest" packages/cli/src` returns
  nothing. The CLI is what OPENS the session pull request (`openSessionPr`,
  `updateSessionPr`) and it links nothing.
- **The dispatch prompt contradicts itself for the lane that matters.**
  `sessionLineageWorkflow` step 7 — _"Do NOT open a pull request for this item"_ —
  while `outcomeProtocol` steps 3–4 unconditionally say _"open the pull request"_
  then _"link it with the link_pull_request tool"_. `outcomeProtocol(src)` takes
  no session branch and cannot vary by grammar, so a session-lineage agent
  receives both instructions and has no coherent one to follow.

MOTIR-3678 is the card that fixes the prompt. **The check must not be enabled
before per-card linking is actually happening on the session lane** — the
constraint is on ENABLEMENT, not on merge order, and it is a rollout gate
MOTIR-3675 owns (see _What this costs MOTIR-3675_).

### The exemption rule — three clauses, each a property of the delivery

Stated as properties, not as a list of today's bots, because the list of bots is
not stable and a rule that enumerates them is wrong the day somebody adds one.

1. **A pull request whose author is a BOT is out of scope** —
   `pull_request.user.type === "Bot"`. This is Dependabot and renovate today and
   every bot anybody installs tomorrow, without naming any of them. The payload
   already carries it: `resolveGithubChangeRequestContext` reads the author from
   the same object (`readAuthorGithubUserId`).
2. **A pull request in a repository that is not bound to a project is out of
   scope** — `GithubRepo.projectRepo` is null. A repository selected on the
   installation so Motir can read its code is not a repository Motir plans work
   in, and a red check there is an unasked-for opinion about somebody else's
   repository. `ProjectRepo` is the existing expression of "this repository holds
   planned work", so no new concept is introduced.
3. **A DRAFT pull request is out of scope until it is marked ready.** A draft is a
   work-in-progress by declaration; demanding its association before it is offered
   for review is the noise Q3 is trying to avoid. The check appears on
   `ready_for_review`.

**Not exempt, deliberately:** a pull request into a NON-DEFAULT base. A stacked
pull request still delivers a card and still owes its link; what its base costs it
is completion, and `deferred_non_default_base` already answers that. Association
and completion are different questions and only one of them is about the base.

**Not exempt, and this is the interesting one:** a session pull request that
resolves to ZERO cards. Under the join table that is a genuinely orphaned session
— work integrated onto a branch that no card claims — and it SHOULD go red. The
branch-keyed future would have needed a rule here; the join-table future does not,
because zero rows is just unlinked.

---

## Q3 — red, or advisory

### Decision — a check run with `conclusion: failure`, and Motir does not decide whether that blocks

The check is written as a genuine failure, not a `neutral`. But **a failing check
run does not block a merge unless the repository requires that check by name in a
branch-protection rule**, which is the repository owner's setting and not Motir's.
That allocation is the answer to the card's dilemma rather than a dodge of it:

- **Motir's obligation** is to make the missing association VISIBLE at the moment
  somebody can still act on it, in the place they are already looking. A `failure`
  does that; a `neutral` is a grey dot people learn not to read, and the failure
  MOTIR-2164 records one system over is exactly a signal that fires only when
  somebody remembers to look for it.
- **The repository's owner** decides whether it wedges anyone. A team that wants
  the rule enforced adds it to required checks; one that wants a nudge does not.
  Nobody is stuck at 2 a.m. by a default Motir chose for them.

### The escape hatch

**The primary hatch is the action the check asks for: link the pull request.** It
is one MCP call (`link_pull_request`) or one control on the item page, both
available to anyone who can see the card, and the check is re-written to `success`
by that write — not on the next delivery. That immediacy is what makes it a hatch
rather than a wait.

**The secondary hatch, for a pull request that genuinely delivers no card** — a
README typo, a revert, a hotfix nobody planned — **is a LABEL: `no-work-item`.**
A label is chosen over a title token deliberately: this story is retiring the
title as a carrier of machine-read meaning, and reintroducing one here would be
the same mistake wearing a different name. Anyone with write access to the
repository can apply it, it is visible in the pull-request list, and the check
recomputes on `labeled` / `unlabeled`.

**Who may use it: anybody who can push to the repository.** No approval, no role
gate. A hatch that needs permission is a hatch that gets routed around, and the
label is a public statement on the pull request either way.

---

## Q4 — what happens to pull requests that are open when this ships

**Nothing. They carry no check, and there is no backfill.**

The check is written from `pull_request` deliveries, and the actions it fires on
are `opened`, `reopened`, `ready_for_review`, `synchronize`, `labeled`,
`unlabeled`. An already-open pull request receives none of those until somebody
pushes to it — at which point `synchronize` writes the check for the first time.

**So the honest answer is: they go red on their next push, and that is
acceptable**, for two reasons. It is a small, self-draining population — every
open pull request either merges or gets pushed to. And the remedy is one call by
whoever is already working on it, on a signal that has appeared next to the work
they are doing rather than in a report nobody opened.

**A retroactive backfill is rejected.** Writing checks onto every open pull
request at deploy time turns a rule change into a morning of red, on work that was
correct under the rule in force when it was opened. A rule that starts applying at
the next event is the one people can act on.

---

## What this costs MOTIR-3675 (the build card)

Named here so the build card inherits a list rather than discovering one.

1. **The App permission.** `checks: write` on `motir-integration`, plus the
   approval on installation `144235820`. Until it is approved every write is a
   403, so the writer must treat a 403 as _not configured here_ and stay silent —
   never retry, never error a delivery.
2. **A check-only branch of `handlePullRequest`, ABOVE the `HANDLED_PR_ACTIONS`
   gate.** That set is `opened` · `reopened` · `closed` today, and the service's
   own header says the file-listing cost is affordable _because_ `synchronize` is
   not in it. The check needs `synchronize` and three more actions, so it must
   NOT widen that set: it takes its own action list and runs neither the status
   sync nor `capturePullRequestFiles`.
3. **A head SHA to address the check to.** `GithubPullRequest` has no
   `head_sha` column, so the link-side write (the immediacy the hatch depends on)
   has nothing to address.

   > **⚠️ AMENDED AT BUILD TIME (MOTIR-3675) — NO COLUMN IS ADDED.** This step
   > said _"stamp `head_sha` from every handled delivery, and fall back to a live
   > `GET /pulls/{n}` when it is null"_, and the fallback turned out to be the
   > whole answer: the webhook path already carries `pull_request.head.sha` in the
   > payload, so only the LINK path ever needs a lookup, and that path is doing
   > network I/O either way. What the column would have bought is one saved round
   > trip; what it costs is a schema change on a development database several
   > parallel sessions share, where a migration one of them did not write shows up
   > as drift in its own `migrate diff`. `readPullRequestHeadSha` in
   > `lib/github/checkRuns.ts` is what shipped, and `pull_requests: write` already
   > covers the read. Recorded here rather than left describing a design that was
   > not built.

4. **Recompute from the LINK side too** — `link_pull_request` and
   `unlink_pull_request` re-write the check for the affected pull request. Without
   this the hatch is "link it, then push something", which is not a hatch.
5. **The enablement gate from Q2's ⚠️ block.** The check may be turned on only
   once the session lane actually links per card (MOTIR-3678's prompt fix, and a
   CLI that either links or is confirmed not to need to). Shipping the writer
   before that turns every `motir auto` pull request red.

---

## Consequences

- **Motir writes to a repository for the first time.** Everything the
  user-facing App did until now was a read plus a status write inside Motir's own
  database. A check run is a visible artifact on somebody else's pull request, and
  that is a new relationship with the user's repository, not just a new endpoint.
- **The check is the enforcement for a rule the product cannot otherwise keep.**
  Once the parse is gone, nothing else notices an unlinked pull request until a
  merge fails to move a card — and by then the person who could have linked it in
  one call has moved on.
- **An installation that does not re-consent has no check, silently.** This is
  the honest residual: the same class of quiet absence the story is fixing,
  displaced one level to the permission layer. It is bounded (one installation
  today), it is observable (the 403 is loggable), and there is no version of
  option A without it.
- **`no-work-item` becomes a label with meaning**, which is a small vocabulary
  the product now owns in the user's repository. Named as a cost because
  repository-level vocabulary is easy to add and hard to remove.
