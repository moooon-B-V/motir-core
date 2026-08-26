# ADR: Following the build — a derived public changelog, three follower tiers, one `public_follow` row

- **Status:** Accepted (2026-08-26)
- **Story / Subtask:** 8.9 (Follow the build — public changelog + follow/subscribe) · Subtask 8.9.1
- **Supersedes / superseded by:** none. It **retires one placeholder**: the external
  `links.changelog` row in `PublicOverviewSidebar` (8.9.5's deliverable), which
  points a public viewer off-site at a changelog Motir does not own.
- **Extends:** `public-projects.md` (Story 6.12 — the `public` access level and the
  public PROJECTION) and `epic-privacy.md` (Story 6.14 — the private-epic
  exclusion). This ADR adds **one new table, one new tab and one new feed** to
  that projection; it forks no parallel read or access system.
- **Consumed by:** 8.9.2 (design), 8.9.3 (`PublicFollow` + the changelog read
  model + migration), 8.9.4 (the `/p/[identifier]/changelog` page + service +
  SEO), 8.9.5 (follow / subscribe service + Follow button + manage), 8.9.6
  (Atom feed), 8.9.7 (the follower email digest), 8.9.8 (vitest), 8.9.9 (E2E).

> Structured **Status → Context → Decision → Consequences → References**, the
> convention this repo's ADRs set (`epic-privacy.md`, `public-projects.md`,
> `triage-model.md`). **No application behaviour ships in this subtask.** What it
> freezes is the set of shapes six downstream subtasks would otherwise each
> re-derive — and, above all, it settles the one question that decides whether
> this feature can leak: _what is a changelog entry, and which rows can become
> one?_

---

## Context

The public-project feature is shipped and complete as a **PULL** surface. A
visitor can reach `/p/<identifier>` and read the Overview, board, work-item
list, tree, roadmap and item detail; `/explore` ranks public projects; requests
can be submitted, upvoted and commented on; SEO, JSON-LD, sitemap and OG images
are all in place. Verified on `origin/main` at the time of writing, not asserted.

What is **absent** is every PUSH affordance:

- there is **no changelog** — the roadmap's Done column is a board, not a
  time-ordered stream, and it answers _what is done_ rather than _what shipped,
  when_;
- there is **no way to follow** a project — no row anywhere ties a person to a
  project they want to hear about;
- there is **no feed and no digest**, so a visitor who cares has to come back and
  look.

The tell is in the shipped code: `PublicOverviewSidebar` already renders a
`links.changelog` row — an **external URL a project admin types in**
(`PublicProjectLinksDto.changelog`, `lib/dto/publicProjects.ts`). Motir currently
tells its public visitors to go and read somebody else's changelog. Story 8.10
(the build-in-public launch) routes through this story precisely because the
launch act is _"follow along"_, and there is presently nothing to follow.

**Three questions have to be settled before any of it is buildable**, because
each has two defensible answers and six subtasks would otherwise pick
differently:

1. **Who is a follower?** An account? An email address? Nobody at all, with the
   feed doing the work?
2. **What IS a changelog entry?** A derived view of work items that reached
   `done`, or a new curated entity somebody writes by hand?
3. **How does the 6.14 privacy guarantee survive a feed?** A feed is the one
   surface that leaves the site, is cached by third parties, and is read by
   machines that never re-check.

### The verified mirror (rung 1 — observed, not asserted, 2026-08-26)

| product             | who can subscribe                                                                                                    | anonymous feed                                                                                                                                           | source of entries                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **GitHub Releases** | signed-in "Watch → Releases only"                                                                                    | **YES** — `https://github.com/<org>/<repo>/releases.atom` serves **Atom 1.0** anonymously (`HTTP 200`, 10 `<entry>` elements, `curl` with no credential) | derived from a repository event (a release being published)              |
| **Canny changelog** | account required — a subscriber must supply name + email or use Google / GitHub / Facebook login                     | **NO** — an RSS feed is an _open feature request_, not a shipped surface                                                                                 | curated entries an admin publishes, with a "Notify subscribers" checkbox |
| **Linear**          | account-level notification preference (Settings → Account → Notifications includes changelog among the update types) | not documented                                                                                                                                           | curated                                                                  |

Two things fall out of that table, and both are load-bearing below.

**First: the anonymous tier is real, and Atom is the format that carries it.**
GitHub's `releases.atom` is the closest analogue to what a build-in-public
project needs — it is anonymous, it is per-project, it needs no row in anyone's
database, and it has been the developer-audience default for fifteen years.
Canny's RSS gap is the counter-example that proves the demand: it is one of the
requests on Canny's own public feedback board.

**Second: Canny's account requirement is where we deviate, and the deviation
earns its place with a concrete use case.** Canny's changelog subscriber is an
existing customer who already has an account in the product. Motir's public
project is the **launch funnel** — the follower is a prospect who has just
arrived from a link and has no Motir account and no reason yet to want one.
Requiring a signup before a person may hear about the thing they just decided
they were interested in inverts the funnel it exists to feed. So Motir ships the
email-only tier that Canny does not, and pays for it with a double-opt-in
confirmation (below). Per the decision-authority ladder, that is the one-line
justified use case a deviation from the mirror owes.

### The shipped ground this builds on (rung 2 — enforced reality)

Everything this ADR decides sits on machinery that already exists. Each was read
on `origin/main`, and each is cited by the subtask that consumes it.

| what                                        | where                                                                                                                                                                                                                                                                                                          | why it matters here                                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| The canonical **done-transition predicate** | `workItemRevisionRepository.aggregateResolutionTimeByBucket` / `aggregateNetResolvedByBucket` / `aggregateAverageAgeByBucket` / `aggregateSprintCycleByDay` — all four join `work_item_revision` to `workflow_status` and test `ts."category" = 'done' AND (fs."category" IS NULL OR fs."category" <> 'done')` | "shipped" is **already defined** in this codebase, four times, identically. The changelog does not get a fifth definition |
| The **status-revision predicate**           | `r."diff" -> 'status' IS NOT NULL`, described in `workItemRevisionRepository` as _"the established status-revision predicate in this file"_                                                                                                                                                                    | how a status change is found in the revision trail at all                                                                 |
| The **private-epic exclusion**              | `workItemRepository.findPublicHiddenDescendantIds` (one recursive CTE, depth-agnostic) + the `notExcludedSql` predicate helper                                                                                                                                                                                 | the 6.14 guarantee, as a single reusable SQL predicate rather than N filters                                              |
| The **triage exclusion**                    | `notInTriageSql`                                                                                                                                                                                                                                                                                               | triage items are not planned work and must not appear as shipped                                                          |
| The **public-safe column set**              | `findPublicProjectTreeLevel` selects `id / parentId / kind / key / identifier / title / status / priority / publicChildrenHidden` and nothing else — "the public boundary is structural"                                                                                                                       | the entry shape's ceiling                                                                                                 |
| The **public detail projection**            | `PublicWorkItemDetailDto` exposes `descriptionMd`                                                                                                                                                                                                                                                              | the feed's `<content>` exposes no column the public detail page does not                                                  |
| The **public-write RLS pattern**            | `public_request_vote_owner_or_system` (FOR ALL, owner-or-system) + `public_request_vote_public_project_read` (FOR SELECT, gated on `coalesce(current_setting('app.workspace_id', true), '') = ''` AND an `EXISTS` walking to `project.accessLevel = 'public'`)                                                 | the exact shape a second public-facing table takes                                                                        |
| The **public-write rate limiter**           | `lib/rateLimit/publicWriteGuard.ts`, `rateLimitKey('public-write', clientIp(req))`, the `RateLimitScope` union in `lib/rateLimit/keys.ts`                                                                                                                                                                      | abuse control that already exists and is already E2E-aware                                                                |
| The **transactional email backend**         | 8.5.3 (`lib/email.ts`, wired to the real provider) and `EmailDelivery`                                                                                                                                                                                                                                         | the digest has a backend to send through — and only in a deployment that configured one                                   |

---

## Decision

### 1. THREE follower tiers, and only ONE of them is a row

A "follower" is not one thing, and collapsing the three into one model is what
makes either the funnel or the privacy story wrong.

| tier           | identity                             | stored?                                | gets                                                 |
| -------------- | ------------------------------------ | -------------------------------------- | ---------------------------------------------------- |
| **Anonymous**  | none                                 | **NO ROW AT ALL**                      | the Atom feed, and the changelog page                |
| **Account**    | a Motir `User`                       | `public_follow.user_id`                | the follow state on the public chrome; opt-in digest |
| **Email-only** | a verified email address, no account | `public_follow.email` + a confirmation | opt-in digest; nothing else                          |

**The anonymous tier stores nothing, and that is the decision, not an omission.**
The feed and the page are public reads of public data; a visitor who wants to
follow anonymously subscribes in their own reader and Motir never learns they
exist. GitHub's `releases.atom` is exactly this, and it is why "Copy RSS" is a
first-class affordance in the subscribe popover rather than a footnote.

**The account tier is the primary one.** It is the tier the Follow button drives,
it is the one that shows state (`Following` / `Follow`) on return visits, and it
is the one that needs no email confirmation — the address is already verified by
`User.emailVerified`, and re-confirming a verified address is friction that buys
nothing.

**The email-only tier is the deviation from Canny, justified above.** It is
strictly weaker than the account tier: it grants a digest and nothing else. It
carries no session, no upvote, no comment, and it is not a shadow account.

**One table for the two stored tiers, not two.** `public_follow` carries a
NULLABLE `user_id` and a NULLABLE `email`, with exactly one of them set. Two
tables would duplicate the digest fields, the unsubscribe token, the project FK
and every read the digest job makes, and would make "how many followers does
this project have?" a UNION.

The shape 8.9.3 builds:

```prisma
model PublicFollow {
  id        String @id @default(cuid())
  projectId String @map("project_id")

  // Exactly one of these is set — enforced by a CHECK constraint, not by
  // convention (see §7).
  userId String? @map("user_id")
  email  String? // stored LOWERCASED; the unique index is on the stored form

  digestOptIn Boolean   @default(false) @map("digest_opt_in")
  confirmedAt DateTime? @map("confirmed_at")

  // Both tokens are stored HASHED — never the token itself (§7).
  confirmTokenHash      String?   @map("confirm_token_hash")
  confirmTokenExpiresAt DateTime? @map("confirm_token_expires_at")
  unsubscribeTokenHash  String    @map("unsubscribe_token_hash")

  lastDigestAt DateTime? @map("last_digest_at")
  createdAt    DateTime  @default(now()) @map("created_at")
  updatedAt    DateTime  @updatedAt @map("updated_at")

  project Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  user    User?   @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([projectId, userId])
  @@unique([projectId, email])
  @@index([projectId, digestOptIn])
  @@map("public_follow")
}
```

**No `workspace_id`, deliberately** — and this is the one place the newest-table
convention does NOT apply. `public_follow` follows `public_request_vote`, which
also carries none: the row's tenancy is inherited from its project, the writer is
by construction NOT a member of that workspace, and a public request arrives on a
connection with **no `app.workspace_id` bound at all** (measured and recorded in
`20260815200000_public_project_join_read_policies`). A `workspace_id = current_setting(...)`
policy on this table would deny every write it exists to accept. §7 gives the
policy set instead.

**Both relations are modelled on both sides** (`Project.publicFollows`,
`User.publicFollows`) — the FK-`@relation` rule in `motir-core/CLAUDE.md`, no
raw-SQL-only FK.

### 2. The changelog is DERIVED from done-transitions. There is no update entity in v1

**A changelog entry is a work item that entered a `done`-category status, dated
by that transition.** No new entity, no curation step, no publish button.

The reason is not economy — it is that Motir already knows the answer, four
times over. `aggregateResolutionTimeByBucket`, `aggregateNetResolvedByBucket`,
`aggregateAverageAgeByBucket` and `aggregateSprintCycleByDay` each derive
"entered done" from the same join, and one of them documents the intent
outright: _"so every report agrees on 'done'"_. A changelog that defined shipped
differently would be a fifth definition, and the first one a **public** reader
sees. A curated entity would additionally mean a build-in-public project has to
be _maintained_ to look alive, which is precisely the failure mode a
derived-from-the-tracker changelog exists to avoid — the whole pitch is _the plan
IS the changelog_.

**`shippedAt` is the item's MOST RECENT transition into a `done`-category
status** — not its first.

That is a deliberate divergence from `aggregateAverageAgeByBucket`, which uses
the FIRST such transition, and the reason is that the two answer different
questions. Age-to-resolution asks _how long did this take_, so the first
resolution is the honest one. A time-ordered feed asks _what shipped, when_, and
an item that was reopened and re-shipped last week shipped last week. Using the
first transition would file it under a date its readers have already scrolled
past — which is the same as not publishing it.

Consequences of that choice, all of them intended:

- **A reopened item leaves the feed and comes back higher.** An item that moves
  out of `done` has no current shipped date and is not an entry; when it returns
  it re-enters at the new date. A feed reader will see it twice, months apart.
  That is a true statement about the build.
- **An item created directly at a done status is NOT an entry.** No status
  revision is written for a row created at its status (the importer's
  authoritative set — `workItemRevisionRepository.findLatestStatusChange`
  documents exactly this), so it has no transition and no `shippedAt`. An
  imported backlog of already-closed issues does not flood the changelog on day
  one. This is the right default and it is worth stating, because it reads as a
  bug the first time somebody imports.
- **`shippedAt` is not stored.** It is derived per read. A denormalized column
  would need a backfill and a write-path hook on every transition, and would then
  be a second place for "shipped" to drift — the same argument
  `epic-privacy.md` §6 makes when it defers a denormalized root-epic column.

**The curated note is DEFERRED, and it is deferred as an ADDITION, not an
alternative.** When it lands it attaches prose to an entry that already exists;
it never becomes the source of entries. That keeps the invariant _every entry is
a real state change in the tracker_ — the property that makes the changelog
trustworthy — and it means the deferral cannot silently become a re-decision.
It is not part of Story 8.9 and no card in 8.9 builds toward it.

### 3. The entry shape, its ordering, and its page

An entry carries **exactly the public-safe columns the tree level already
projects**, plus the derived date and the ancestor chip:

| field                                                      | source                                                           |
| ---------------------------------------------------------- | ---------------------------------------------------------------- |
| `identifier`, `key`, `title`, `kind`, `status`, `priority` | the public-safe set `findPublicProjectTreeLevel` already selects |
| `shippedAt`                                                | §2 — the latest into-done transition's `changedAt`               |
| `epic` (`identifier` + `title`), nullable                  | the item's ancestor epic, for the entry's chip                   |
| `href`                                                     | `/p/<identifier>/items/<KEY>` — the shipped public detail route  |

**No assignee, no estimate, no story points, no reporter, no sprint** — the
public boundary stays structural, as `findPublicProjectTreeLevel`'s own note
puts it, rather than becoming a mapper's responsibility.

- **Order: `shippedAt DESC`, tiebroken by `key DESC`.** `changedAt` alone is not
  a total order — two revisions in the same millisecond tie, and an unbroken tie
  makes both the rendered order AND cursor pagination non-deterministic
  (PRODECT_FINDINGS #38, recorded on `listByWorkItem`). A page boundary landing
  mid-tie skips or repeats a row.
- **Cursor pagination**, keyed on `(shippedAt, key)`, matching the public tree's
  `take + 1` convention so `hasMore` needs no COUNT. Page size **20** on the
  page, "load more" appended.
- **`type` is not shown.** A public reader does not need to know that a shipped
  thing was a `chore` rather than a `code` card, and the type taxonomy is an
  internal planning vocabulary (`work-item-type-taxonomy.md`).

### 4. The digest: weekly, opt-in, double-opt-in for the email tier, cloud-only

- **Cadence: WEEKLY, Monday 09:00 UTC.** One cadence, not a per-follower choice.
  A build-in-public project ships continuously and a daily mail is unsubscribe
  bait; a monthly one is not "following the build". Weekly is Canny's and
  GitHub's practical default and is the only cadence 8.9.7 builds.
- **Opt-in, default OFF, for BOTH stored tiers.** Following is not subscribing.
  An account follower who presses Follow gets follow state and nothing in their
  inbox until they tick the digest box in the subscribe popover.
- **Double opt-in for the email-only tier; NONE for the account tier.** An
  email-only follow writes a row with `confirmed_at = NULL` and mails a
  confirmation link; nothing is sent to that address again until it is
  confirmed, and an unconfirmed row older than **7 days** is swept. An account
  follower's address is already verified by `User.emailVerified` — re-verifying
  it is friction with no security content.
- **A digest with nothing in it is NOT SENT.** A week in which a project shipped
  nothing produces no mail. Silence is information; an empty "0 items shipped"
  mail is the thing that trains people to filter you.
- **Every digest carries a one-click unsubscribe** resolved by
  `unsubscribe_token_hash`, requiring no session and no account, plus
  `List-Unsubscribe` / `List-Unsubscribe-Post` headers.
- **`last_digest_at` is the window's lower bound**, per follower, so a follower
  who joins mid-week gets the next full week rather than a backfill, and a failed
  send does not silently skip a window.

**Cloud-only, and the self-host stance is explicit.** The digest needs the 8.5.3
transactional-email backend. In a deployment with no email provider configured,
the digest opt-in is **not offered** — not offered and broken, but absent, the
way the DSN-unset monitoring path in 8.5.6 is absent. The changelog page and the
Atom feed have no such dependency and work fully self-hosted. This is the
free/cloud split for this story, in one line: **RSS is everywhere; email is where
email is configured.**

### 5. The feed: Atom 1.0, served at `changelog.xml`, anonymous, 50 entries

- **Format: Atom 1.0**, not RSS 2.0 — the format GitHub serves for the closest
  analogous surface (verified above), and the one with a required, unambiguous
  `<updated>` per entry, which is the field this feed is entirely about.
- **Route: `/p/<identifier>/changelog.xml`**, `Content-Type:
application/atom+xml`. The extension is `.xml` because that is the URL Story
  8.9's own verification recipe names; the payload is Atom because §5 says so.
  **Both are true and there is no conflict to resolve** — the extension is not
  the media type. `/changelog.atom` is **not** also served: one canonical URL,
  because a feed URL is copied into readers and outlives every redirect we would
  later regret.
- **Anonymous.** No session, no account, no rate-limit key beyond the shared
  public read path. The feed is the anonymous tier.
- **Scope: the latest 50 entries.** Not paginated — feed readers do not page, and
  a feed that grows without bound is a feed that eventually times out. A reader
  wanting the whole history follows `<link rel="alternate">` to the page.
- **`<content>` carries the item's `descriptionMd`, truncated to 1000
  characters, as `type="html"`.** This exposes no column the public item-detail
  page does not already expose (`PublicWorkItemDetailDto.descriptionMd`) — it is
  the same public data through a second door. Truncation is for feed size, not
  for privacy.
- **`<id>` is a stable tag URI** — `tag:<host>,<project-created-year>:work-item/<id>`
  — so an entry that changes title is updated in a reader rather than duplicated,
  and an entry that re-ships (§2) keeps its identity while its `<updated>` moves.

### 6. Privacy: the 6.14 exclusion, plus the one row it does NOT cover

Every changelog read — the page, the feed, and the digest — passes through the
same three predicates the public tree read already uses:

1. `notExcludedSql(alias, excludeIds)` where `excludeIds` comes from
   `workItemRepository.findPublicHiddenDescendantIds(projectId, workspaceId)` —
   the 6.14 private-epic descendant set;
2. `notInTriageSql(alias)` — triage submissions are not planned work;
3. `archivedAt IS NULL`.

**And one predicate 6.14's helper does not supply, which this ADR adds:**

> **A private epic's OWN row must be excluded from the changelog, even though
> 6.14 deliberately keeps it visible in the tree.**

`findPublicHiddenDescendantIds` returns descendants only — its own doc comment
says so — because in the TREE the private epic's row stays visible as the
deliberate _"this epic is not public"_ placeholder. That is correct for a tree
and wrong for a stream: a changelog entry is an assertion that a specific thing
shipped, and there is no such thing as a placeholder entry. A private epic
reaching `done` would publish its title — the one field 6.14 leaves visible — as
a shipped item, into a feed, permanently. So the changelog read adds
`NOT (kind = 'epic' AND "publicChildrenHidden" = true)` on top of the exclusion
set.

This is the single most important sentence in this ADR and 8.9.8 asserts it
directly.

Two further guarantees, both structural rather than conventional:

- **The whole surface is gated on `project.accessLevel = 'public'`**, through the
  same 6.12 public access check every other public read uses. A non-public
  project has no changelog page and no feed — 404, not an empty feed.
- **The digest re-runs the exclusion at SEND time, not at follow time.** An epic
  made private on Wednesday must not appear in Monday's mail because it was
  public when the item shipped. The digest composes its item set from the same
  service read the page uses, at send.

### 7. Abuse, tokens, and the four registries a new route owes

**Rate limiting reuses the shipped limiter.** A new `RateLimitScope` value
**`'public-follow'`** joins the union in `lib/rateLimit/keys.ts`, guarded exactly
as `publicWriteGuard` guards `'public-write'`:

- **the follow / unfollow write** is keyed on `(scope, clientIp)`;
- **the email opt-in** is keyed on `(scope, clientIp)` **and** on
  `(scope, email)` — two buckets, because one IP enumerating addresses and one
  address being mail-bombed from many IPs are different attacks and a single key
  stops only one of them;
- **the new limiter honours `E2E_DISABLE_RATE_LIMIT`** through
  `rateLimitingDisabled()` in `lib/rateLimit/limiter.ts`. It does **not**
  introduce a second env var — the E2E suite signs several users up from one IP
  and a limiter that ignores the flag flakes every multi-user spec.

**Tokens.** The confirmation token and the unsubscribe token are both
high-entropy, generated server-side, **stored only as a hash**, compared in
constant time, and single-use for the confirmation (which additionally expires
in **24 hours**). The unsubscribe token does not expire — an unsubscribe link
must work in a mail somebody finds two years later.

**Enumeration.** Every follow/unfollow/opt-in response is the same regardless of
whether the address was already following. The endpoint must not become an
oracle for _"does this person follow this project"_.

**The CHECK constraint.** `public_follow` carries a database-level
`CHECK (("user_id" IS NULL) <> ("email" IS NULL))`. Exactly-one-of is an
invariant, and an invariant a service enforces is an invariant a second service
will one day not enforce.

**RLS.** `public_follow` mirrors `public_request_vote`'s two-policy set exactly:

- **`public_follow_owner_or_system`** — `FOR ALL`, `USING` / `WITH CHECK`
  `current_setting('app.system_admin', true) = 'true' OR "user_id" = current_setting('app.user_id', true)`;
- **`public_follow_public_project_write`** — the arm the email-only tier needs,
  gated on there being **no bound workspace**
  (`coalesce(current_setting('app.workspace_id', true), '') = ''`) AND an
  `EXISTS` walking `project.accessLevel = 'public'`, so an unbound connection may
  insert a follow **only** on a public project and only for a row with
  `user_id IS NULL`.

Postgres combines permissive policies per command, so the second policy widens
exactly the commands it names and nothing else; a tenant session keeps precisely
the visible set it had. `tests/tenant-root-creation-rls.test.ts` holds a
**totality guard** — every RLS-enabled table must admit all four verbs, and the
set of tables WITHOUT RLS is compared as a SET — so this table ships its policies
in the same migration or it fails a test in a shard nowhere near the diff.

**Four whole-tree registries the new routes owe**, none of which any local run
touches:

1. **`docs/decisions/permission-inventory.md`** — every `app/api/**/route.ts`
   appears as a `` `/api/...` `` literal; two guards read it.
2. **`lib/mcp/payloads/sharedResources.ts` → `MCP_UNREACHABLE_RESOURCES`** — if a
   v1 resource component is registered for the OpenAPI document.
3. **`tests/e2e/shard-plan.ts`** — 8.9.9's new spec needs a MEASURED cost row, or
   it is assigned to no leg and never runs.
4. **`vitest.config.ts` `coverage.include` + `thresholds`** — both halves, for
   every new gated file.

### 8. What each downstream subtask takes from this record

| subtask                      | what it cites here                                                                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **8.9.2** design             | §1's three tiers (the popover has three affordances, not one), §3's entry shape and page size, §5's "Copy RSS", §6 (a private epic is simply absent — there is no placeholder state to draw) |
| **8.9.3** schema + access    | §1's model and CHECK constraint, §2's derived read and `shippedAt` definition, §6's three-plus-one predicates, §7's RLS policy set                                                           |
| **8.9.4** changelog page     | §3 in full, §5's `<link rel="alternate">` pairing, §6's `accessLevel` gate, the sitemap + JSON-LD conventions the other public tabs use                                                      |
| **8.9.5** follow / subscribe | §1's tiers, §4's opt-in defaults, §7's rate-limit scope, tokens and enumeration rule; it also RETIRES `links.changelog`                                                                      |
| **8.9.6** Atom feed          | §5 in full                                                                                                                                                                                   |
| **8.9.7** digest             | §4 in full, and §6's "re-run the exclusion at SEND time"                                                                                                                                     |
| **8.9.8** vitest             | §2's reopen and created-at-done cases, §6's private-epic-row assertion, §7's CHECK + RLS                                                                                                     |
| **8.9.9** E2E                | §1's logged-out → signed-in journey, and the shard-plan row in §7                                                                                                                            |

---

## Consequences

**Good.**

- **"Shipped" has one definition in this product.** The changelog reuses the same
  done-transition predicate the four reports use, so the public stream and the
  internal reports can never disagree about what shipped.
- **The changelog maintains itself.** A team that uses Motir to plan gets a
  public changelog for free, which is the actual pitch of building in public with
  a tracker. Nobody has to remember to write an entry.
- **The anonymous tier costs nothing and reaches the audience that matters
  most.** A developer subscribes in their reader and Motir stores no personal
  data at all.
- **One table, one migration, one RLS pattern already proven on this exact
  access path.**

**Costs, accepted.**

- **A derived changelog is only as good as the tracker's hygiene.** A project
  that closes items in bulk publishes a bulk changelog. That is a true statement
  about the project, and it is the pressure that makes the tracker honest — but
  it will surprise the first team it happens to.
- **`shippedAt` costs a join per read.** It is derived from `work_item_revision`
  rather than stored. The read is index-backed and paginated, and the alternative
  (a denormalized column) buys speed with a backfill, a write-path hook and a
  second source of truth.
- **The email-only tier is a personal-data surface Motir did not previously
  have.** An address with no account is stored, so it needs the confirmation
  sweep, the unsubscribe path and a deletion story. That is the price of the
  funnel, and §7 pays it explicitly rather than leaving it to 8.9.5.
- **The reopen behaviour will read as a bug.** An item appearing twice in a feed,
  months apart, is correct under §2 and will be reported at least once.

**Rejected alternatives.**

- **A curated `ProjectUpdate` entity for v1.** It makes the changelog a second
  thing to maintain, and a build-in-public project that stops maintaining it
  looks dead while shipping daily. Deferred as an addition (§2), not an
  alternative.
- **Account-only following, as Canny does.** Rejected for the funnel reason in
  the Context, with the deviation justified there.
- **Deriving entries from the roadmap's Done column.** The Done column is a board
  projection with no time axis; it answers a different question and would need a
  date invented for it.
- **`workspace_id` + the standard workspace RLS policy on `public_follow`.**
  Rejected because a public write arrives with no bound workspace, so the policy
  would deny every write the table exists to accept — measured, not assumed
  (`20260815200000_public_project_join_read_policies`).
- **Serving both `/changelog.xml` and `/changelog.atom`.** Two URLs for one feed
  splits subscriber counts and doubles the surface that must keep working
  forever.

---

## References

- `docs/decisions/public-projects.md` — Story 6.12: the `public` access level and
  the public PROJECTION this extends.
- `docs/decisions/epic-privacy.md` — Story 6.14: the `publicChildrenHidden` flag
  and the server-side exclusion §6 reuses (and §6's one addition to it).
- `docs/decisions/status-derivation.md` — the status model the done-transition
  predicate reads.
- `docs/decisions/work-item-type-taxonomy.md` — why `type` is an internal
  vocabulary and not a public one (§3).
- `docs/decisions/production-service-stack.md` — the transactional-email backend
  the digest depends on (§4).
- `lib/repositories/workItemRevisionRepository.ts` — the four aggregates that
  already define "entered done".
- `lib/repositories/workItemRepository.ts` — `findPublicHiddenDescendantIds`,
  `findPublicProjectTreeLevel`, `notExcludedSql`, `notInTriageSql`.
- `lib/rateLimit/publicWriteGuard.ts`, `lib/rateLimit/keys.ts`,
  `lib/rateLimit/limiter.ts` — the limiter §7 extends.
- `prisma/migrations/20260614225729_add_public_project_access/` and
  `prisma/migrations/20260813210000_public_request_vote_public_read/` — the RLS
  policy pair §7 mirrors.
- Rung-1 observations (2026-08-26): `https://github.com/prisma/prisma/releases.atom`
  (HTTP 200, Atom 1.0, anonymous); Canny changelog emails
  (`help.canny.io/en/articles/9346252-changelog-emails`) and its open RSS request
  (`feedback.canny.io/feature-requests/p/changelog-rss-feed`); Linear notification
  settings (`linear.app/docs/notifications`).
