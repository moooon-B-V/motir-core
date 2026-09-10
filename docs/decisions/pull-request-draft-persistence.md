# ADR: Draft-ness is PERSISTED on the mirror row, nullable and never backfilled — the link door's half of the draft lifecycle

- **Status:** Accepted (2026-09-10)
- **Story / Subtask:** Bug MOTIR-5002 (Epic MOTIR-2200) · found by MOTIR-4968's own
  compile error, which is the required `draft` field doing what it was made required for
- **Extends:** MOTIR-4968 (`NormalizedChangeRequest.draft` and
  `GitProvider.changeRequestLifecycle`'s draft arm)
- **Consumed by:** `prisma/schema.prisma` (`GithubPullRequest.draft`) ·
  `lib/repositories/githubPullRequestRepository.ts`
  (`UpsertGithubPullRequestInput.draft`) · `lib/services/changeRequestStatusSync.ts`
  (`syncChangeRequestStatus`'s upsert, `resyncLinkedPullRequest`)
- **Supersedes / superseded by:** none. It relaxes nothing in
  `lib/workItems/deliverySet.ts` or
  `workItemDeliveryRepository.countOtherOpenByWorkItem`, and it is deliberately NOT a
  general "readers can now see drafts" change — see §3.

> Structured **Context → Decision → Consequences → References**, the convention this
> repo's ADRs set. It exists because MOTIR-5002 required it: the card offered three
> options, said which was recommended, and said the choice had to be recorded here if
> the schema moved. It did, so this is the record.

---

## Context

**A card's status has more than one writer, and fixing the loudest one is not fixing the
behaviour.**

MOTIR-4968 was reasoned about as _the status machine cannot see a draft_, and the machine
it meant was the WEBHOOK: a delivery arrives, the seam maps it to a lifecycle, the sync
applies it. That framing is right about the cause and incomplete about the surface. The
same transition has a second entrance — the LINK — and it does not go through the seam at
all.

`resyncLinkedPullRequest` runs when `link_pull_request` attaches a card to a pull request
whose row PRE-EXISTED the link. It exists for a real ordering: `gh pr create` fires
`opened` within a second and the agent's link call lands several seconds later, so the
delivery correctly finds no card and moves nothing, and without the resync the card would
sit In Progress until the merge closed it. Having no payload, it SYNTHESIZES a
`NormalizedChangeRequest` from the stored row — and stated its lifecycle as a literal:

```ts
const cr: NormalizedChangeRequest = { …, state: 'open', merged: false, draft: false };
return syncChangeRequestStatus(cr, 'implemented', …);
```

Both pins were correct when every open pull request meant `implemented`. They stopped
being correct the moment a draft could mean otherwise, and **nothing anywhere connected
the two facts**, because a literal consults nothing. So the card reached `implemented` on
a pull request whose author had explicitly said it was not offered for review — the same
false assertion MOTIR-4968 removed from the webhook door, arriving through the link.

**Why it could not simply read the flag.** `github_pull_request` modelled draft-ness
nowhere, and that was deliberate: a draft must stay an OPEN linked pull request to
`workItemDeliveryRepository.countOtherOpenByWorkItem` and to `deliverySetShortfall`,
which is what holds a multi-repository card open while one repository's chain is still
stopped. MOTIR-4968 therefore pinned `draft: false` with a comment saying it was ASSUMED
rather than known, and filed this — because answering it is a schema decision, and a card
that picks one on the way past another card's acceptance criteria picks it without anyone
reviewing the choice.

The window is real rather than theoretical. A run that links immediately after
`gh pr create --draft` usually beats the webhook and CREATES the row itself (no resync, no
bug), but **a delivery that arrives first, a human linking an existing draft, and a
re-link all land squarely in it.**

## Decision

### 1. Persist it — option (a), the card's own recommendation

`github_pull_request.draft`, written by the status sync on every delivery.

The three candidates MOTIR-5002 named, and why this one:

| option                                        | what it costs                                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **(a) persist draft-ness**                    | a column beside `state` on a row every completion reader consults — mitigated by §3                      |
| (b) read the live pull request when resyncing | makes a LINK do network I/O, and needs a failure arm: a link must not fail because the host is down      |
| (c) do not resync when draft-ness is unknown  | gives up the resync's whole feature for every pull request, not only the rows that genuinely do not know |

(a) is the only one that keeps the feature intact and answers correctly without a network
call. **(c) is not discarded, though — it is kept as the arm for the rows (a) cannot
answer**, which is §2.

### 2. NULLABLE, never backfilled — and the resync DECLINES on null

The column takes no default and no backfill, so `null` means UNKNOWN — the same rule
`base_ref` and `merged_at` already state on this table.

Two writers legitimately do not know, and the type makes them say so rather than guess.
`UpsertGithubPullRequestInput.draft` is a **REQUIRED key whose value may be `undefined`**
— required so the compiler enumerates the producers (the argument
`NormalizedChangeRequest.draft` makes for itself one layer up), `undefined` so a writer
with nothing to assert can leave an existing value alone on update and the column NULL on
insert:

- **the status sync** — a real boolean off the delivery. The authority, and the only one.
- **`linkPullRequestByCoordinates`'s create arm** — `undefined`. `link_pull_request` is
  told the refs and the title, because an agent that has just run `gh pr create`
  truthfully knows them; it is never asked about draft-ness.
- **the historical backfill** — `undefined`. Merged rows only, where the flag decides
  nothing (`merged` answers the lifecycle on its first arm).

**The two guesses are not symmetric, which is why declining beats picking one.** Reading
null as `false` re-asserts this very defect on the population most likely to be a draft —
a parent run's pull request is a draft until its last child lands. Reading it as `true`
strands a ready pull request's card. So `resyncLinkedPullRequest` returns early on null,
exactly as it already does on a null `base_ref`, and for the same reason.

**Declining costs nothing where it fires.** A null row is either pre-migration, or a
placeholder this door's own create arm wrote — and a placeholder means no delivery has
arrived, so the delivery still to come does the transition itself.

### 3. The column has exactly ONE reader, and that narrowness is the design

`resyncLinkedPullRequest` and nothing else. Every other reader of this row must go on
seeing a draft as an ordinary OPEN pull request:

- `countOtherOpenByWorkItem` asks the database for `state: 'open'`;
- `deliverySetShortfall` collapses `state` / `merged` through `deliveryMemberState`;
- the Development surface renders the row.

None of them keys on `draft`, and none should. This is what makes the column safe to add
to a row the completion path consults: it decides ONE thing — the lifecycle a synthesized
change request carries — and is not a fact the rest of the product reasons over.

### 4. The resync routes through the SEAM, not a literal

`getGitProvider(repo.provider).changeRequestLifecycle(cr)`, off a `draft` it actually
knows. Its answer here is one of exactly two, and both are wanted: `'implemented'` for a
ready pull request (the feature, unchanged) and `null` for a draft, which
`syncChangeRequestStatus` honours by RECORDING the delivery and transitioning nothing. The
other two arms are unreachable from this door — `merged` and `state: 'closed'` both return
early — so nothing about a merge is re-derived from a link, which was and remains a
different feature needing its own argument.

## Consequences

- **A draft linked after its delivery no longer moves its card.** The `no_lifecycle_change`
  outcome the webhook door already produced is now what the link door produces too.
- **The mapping has one home.** A future change to what an open pull request means reaches
  both doors, which is precisely what the literal prevented.
- **A pre-migration row loses the catch-up.** Bounded and self-healing: any handled
  delivery (`opened` · `reopened` · `closed` · `ready_for_review`) writes the column, and
  the population never grows. This is the accepted cost of §2, and the alternative was to
  manufacture a `false` for every open pull request in the estate.
- **The historical backfill stays byte-idempotent.** It asserts nothing, so `rowMatches`
  owes no clause and a second sweep still writes zero. Had it asserted `false`, the first
  post-migration sweep would have rewritten every historical row — churning `updated_at`,
  which the Development surface orders by — to fill a column no reader of a merged row
  consults.

## References

- `lib/services/changeRequestStatusSync.ts` — `resyncLinkedPullRequest` (the reader and
  the null arm), `syncChangeRequestStatus`'s `prRow` (the writer), the
  `no_lifecycle_change` short-circuit.
- `lib/git/types.ts` — `NormalizedChangeRequest.draft` and its NOT-PERSISTED note, which
  is the constraint this ADR changes.
- `lib/git/providers/github.ts` · `gitlab.ts` — `changeRequestLifecycle`'s draft arm and
  the note on why its POSITION is the rule.
- `docs/decisions/work-item-delivery-links.md` — the delivery set the completion gates
  read, unchanged by this.
- `tests/github/linkDoorDraft.test.ts` — the door end to end, plus the source assertion
  that no lifecycle literal returns.
