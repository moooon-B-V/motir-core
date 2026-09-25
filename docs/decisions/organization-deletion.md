# ADR: How an organization is deleted — Owner, name and step-up; 30 days closing read-only; a resumable erasure that leaves only the billing record

- **Status.** Proposed (2026-09-25) · Story MOTIR-6306 · Subtask MOTIR-6389
- **Supersedes.** None. No record decides organization deletion today:
  `role-model.md` says only WHO may do it (the Owner), and
  `lib/organizations/capabilities.ts` answers `deleteOrganization` for the Owner
  while `DangerZoneCard.tsx` renders the row disabled (`origin/main` `9f8210aa0`).
- **Extends.** `role-model.md` (the Owner alone), `account-deletion-cancel-path.md`
  (the same shape one tier down: a scheduled erasure with a reachable cancel).
- **Consumed by.** Every sibling under MOTIR-6306:
  MOTIR-6390 (design) · MOTIR-6391 (request table) · MOTIR-6392 (motir-ai closing) ·
  MOTIR-6393 (motir-ai offboard) · MOTIR-6394 (motir-ai purge-retained) ·
  MOTIR-6395 (emails) · MOTIR-6396 (read-only while closing) · MOTIR-6397 (Git
  offboarding) · MOTIR-6398 (motir-ai integration gate) · MOTIR-6399 (schedule and
  cancel service) · MOTIR-6400 (erasure sweep) · MOTIR-6401 (seven-year purge) ·
  MOTIR-6402 (danger zone goes live) · MOTIR-6403 (closing banner) · MOTIR-6404
  (motir-core integration gate) · MOTIR-6405 (E2E + acceptance video).

> Convention: Status → Context → Decision → Consequences, ending with what this
> record does NOT decide. It ships no behaviour; it is what makes the sixteen
> cards above build one thing.

---

## Context

Deleting an organization ends every workspace, project, hosted repository,
subscription and AI tenant it holds, at once. Four questions have to be answered
before any of it is built: what makes the act hard to do by mistake, how long it
stays reversible, what the organization is while it is reversible, and what
survives it.

Two of the answers are not free choices, because we have already published them:

- **DPA §10** (`motir-marketing` `content/legal/dpa.md`): _"Unless you ask
  otherwise, we delete it within **thirty days** of termination, except where
  storage is required by Union or Member State law."_ The same section says
  backups _"follow their own rotation"_ and are not restored to active use.
- **Privacy policy §6** (`content/legal/privacy.md`): billing records are _"kept
  as long as tax and accounting law requires, which in the Netherlands is
  generally **seven years**"_ (the AWR art. 52 retention).

### What the reference products do (fetched 2026-09-25)

| product          | reversible?                                                              | confirmation                                                               | source                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub           | no, irreversible; the name is unavailable for 90 days                    | type the org name                                                          | <https://docs.github.com/en/organizations/managing-organization-settings/deleting-an-organization-account>                                                                                  |
| GitLab.com       | pending deletion, **30 days**; restored from the group's Actions menu    | type the group path                                                        | <https://docs.gitlab.com/user/group/#schedule-a-group-for-deletion>                                                                                                                         |
| Figma            | **28 days**; team admins restore it; members cannot open files meanwhile | —                                                                          | <https://help.figma.com/hc/en-us/articles/360039965973-Restore-a-deleted-team>                                                                                                              |
| Atlassian        | **15 days**, restore by contacting support; every admin is emailed       | —                                                                          | <https://support.atlassian.com/organization-administration/docs/can-i-restore-an-organization/>, <https://support.atlassian.com/organization-administration/docs/delete-your-organization/> |
| Linear           | **48 hours**, any admin cancels; all admins emailed                      | an emailed code                                                            | <https://linear.app/docs/workspaces>                                                                                                                                                        |
| Slack            | no, permanent                                                            | a checkbox and the Primary Owner's password (SSO users must set one first) | <https://slack.com/help/articles/204067366-Delete-a-workspace>                                                                                                                              |
| Google Workspace | no, permanent                                                            | a checklist (export, cancel subscriptions, save billing records) first     | <https://knowledge.workspace.google.com/admin/billing/delete-your-organizations-google-account>                                                                                             |

### What `origin/main` ships (re-read at `9f8210aa0`)

- **Capability.** `orgCan('owner', 'deleteOrganization')` is true and false for
  `admin` and `member` (`lib/organizations/capabilities.ts`).
- **The one workspace delete.** `deleteWorkspaceCascade`
  (`lib/services/workspacesService.ts`) keeps two things alive on purpose: the
  code-graph offboarding row (`code-graph-index-fleet.md` §14.3) and the
  public-hostname reservation (`public-tenant-addresses.md` §8, Bug MOTIR-4366).
  It has two entries today, the org-Admin door and `deleteWorkspaceForErasure`.
- **The step-up.** `TwoFactorManager.tsx` collects a password once for the
  gated actions, and only from an account that HAS one: `lib/auth/index.ts`
  sets `allowPasswordless: true`, and for a Google-only account _"their re-auth
  is the session itself"_. **There is no server-side passkey step-up to reuse.**
- **What cascades from `organization`.** `CiPeriodCharge`, `CiPeriodUsage`,
  `CiWorkflowRunUsage`, `CiContainerUsage`, `CiContainerUsageSlice`,
  `CiContainerPeriodCost`, `CiRunnerProvisioningIntent`, `GithubInstallation`,
  `GithubRepo` all carry `onDelete: Cascade` to it (`prisma/schema.prisma`).
- **What ALSO cascades from `workspace`.** Every one of those except
  `CiPeriodCharge` also cascades on `workspace_id`, and so do `github_repo` and
  `github_installation` (a GitLab connection is a `github_installation` row with
  `provider: 'gitlab'`). **So erasing the workspaces takes the Git rows and the
  per-workspace meters with it, before anything later in the sweep can read them.**
  `CiPeriodCharge` is the only org-keyed-only billing row.
- **motir-ai.** `AiOrganization` cascades `CreditLedger`, `CreditTransaction`,
  `StripeCustomer` and `StripeSubscription`. A `CreditTransaction` survives the
  loss of its run or turn (`onDelete: SetNull`, _"losing the run must never
  delete the CHARGE"_). `stripeGateway.ts` reads subscription items _"across ALL
  of a customer's active subscriptions"_, because the tracker subscription id is
  not stored. `offboardOrganization` (`src/services/codeGraphOffboardingService.ts`)
  removes an organization's code graphs.
- **The org slug.** `organization-url.md` Decision 3: `Organization.slug` is
  _"internal substrate from now on, not a user-facing value"_. No route, link or
  hostname is addressed by it. Public hostnames belong to WORKSPACES, and their
  reservation already happens inside the workspace delete.
- **Accounts.** `accountErasureService` blocks the Owner of a SHARED organization
  (`owners <= 1 && members > 1`). A solo Owner's erasure removes their
  memberships and sole-member workspaces instead.

---

## Decision

### 1. Who, and how hard it is to do — the Owner, the exact name, and a fresh step-up

Scheduling a deletion requires all three, checked on the server in one request:

1. **The capability.** `orgCan(role, 'deleteOrganization')`, the Owner alone.
   An Admin or Member is refused on the server and shown no control.
2. **The organization's exact name**, typed. This follows GitHub and GitLab: it
   proves the reader is deleting the org they think they are.
3. **A fresh step-up**, which proves the person at the keyboard is the Owner and
   not a hijacked session:
   - **An account with a password re-enters it**, verified on the server.
   - **An account with no password must have signed in within the last
     10 minutes**, by whatever method it signs in with (Google or a passkey).
     If not, it is sent to sign in again and comes back to the dialog.

   **This departs from the brief, which said "passkey where the account has no
   password".** No server-side passkey assertion exists to reuse. The shipped
   step-up treats a passwordless account's session as its re-auth
   (`lib/auth/index.ts`). That is acceptable for turning 2FA on. It is not
   acceptable for ending an organization, because a session can be months old.
   A recent sign-in is the same proof of possession a passkey assertion would
   give, and it needs no new ceremony. Slack's alternative, forcing an SSO user
   to create a password first, is rejected as friction that proves nothing more.

**One open request per organization.** A second schedule is refused while one
is open. Scheduling and transferring ownership both lock the organization row,
so they cannot interleave. **Transfer is refused while the org is closing**:
the Owner cancels first. The person who can cancel therefore cannot change
during the window.

### 2. How long it stays reversible — 30 days, no early purge

- **The due date is the scheduling time + 30 days, stored on the request at
  scheduling** and never recomputed. That is the number DPA §10 promises, read as
  `lib/users/dataSubjectRequests.ts` reads privacy §6: _"the erasure runs AT day
  30"_. It is its OWN named constant, commented with the DPA §10 promise. The two
  windows happen to be equal today, but they are different promises in
  different documents, and neither should move the other.
- **No early purge**, not even by the Owner. The window exists to survive a
  mistake or a compromised Owner session, and an early purge is that mistake's
  fast path.
- 30 is also the middle of the reference range: GitLab 30, Figma 28, Atlassian
  15, Linear 2 days. Longer would need a DPA change.
- **The window is reachable**, which `code-graph-index-fleet.md` §14.3 demands of
  a grace period: the Owner's account survives it (§5 below) and can sign in to
  cancel.

### 3. What the organization is during the window — read-only, and impossible to miss

From the moment it is scheduled, the organization is **closing**:

- **Every actor in every workspace of the org resolves to read-only
  permissions**, the Owner included. The same applies to API tokens, to agent
  dispatch, to automation rules and to the org's scheduled jobs, which are paused
  rather than failed.
- **Billing stops renewing.** Every active subscription of the org's Stripe
  customer is set to cancel at period end: _every_ one, not the stored
  `StripeSubscription` row, because motir-ai does not store the tracker
  subscription's id. New checkouts and seat changes are refused.
- **Nothing is hidden.** Members keep reading what they could read (Figma's
  "inaccessible until restored" is rejected, because it removes the one exit a
  member has), and **the personal-data export stays open**. Each member can take
  their own archive, which covers the workspaces they belong to.
- **Every member sees an app-wide banner** naming the date and who scheduled it,
  and linking the export. The Owner's banner carries Cancel.

Axis (a), leaving it fully usable, is rejected: a 30-day window that people keep
writing into is a window of loss.

### 4. Cancel

The Owner can cancel at any time before the due date. **A cancel restores
exactly the prior state**: writes reopen, dispatch, automations and jobs resume,
and every subscription's cancel-at-period-end is lifted. A cancel racing the
sweep at the due date is decided by the request row's lock. Whichever commits
first wins, and the loser is refused cleanly, never half-applied.

### 5. Accounts during and after

- A Member's or Admin's own account deletion is unaffected.
- The Owner's own account deletion stays under the existing block for the Owner
  of a shared organization (`accountErasureService`), closing or not. **The block
  lifts when the tombstone is written**, because the Owner then holds no
  membership. So the Owner's account is guaranteed to outlive the window they
  alone can cancel.

### 6. The erasure — a resumable sweep, Git FIRST

At the due date a **system-scoped sweep** erases the organization. It records
its progress on the request row after each step, so an interrupted run resumes
at the step it had not finished. The order is fixed, and **it departs from the
brief, which put the workspaces first**:

1. **Git.** This must come before the workspaces, because `github_repo` and
   `github_installation` (GitLab connections included) cascade on
   `workspace_id`, and erasing the workspaces first would destroy the list this
   step walks.
   - Repositories **Motir hosts** (owner login = the provisioning org,
     `lib/git/hostOwnership.ts`) are deleted. The takeover flow
     (`projectRepoTakeoverService`) is offered throughout the window, so a team
     that wants its code takes it first.
   - Repositories the customer **connected** are **never** deleted. Our GitHub
     App installation is uninstalled where the API allows, and each GitLab
     connection is disconnected, which removes Motir's webhooks from the
     customer's projects.
2. **Every workspace, through `deleteWorkspaceCascade`**, the one delete, via
   a third system entry beside the two it has. Its two survivals come with it:
   the code-graph offboarding row, and the public-hostname reservation.
3. **motir-ai offboards the tenant.**
   - It cancels every subscription now.
   - It removes the code graphs (`offboardOrganization`).
   - It erases projects, jobs, lessons and embeddings.
   - It keeps `AiOrganization` as a tombstone holding only `CreditLedger`,
     `CreditTransaction`, `StripeCustomer` and the (now cancelled)
     `StripeSubscription`.
   - **The Stripe customer is not deleted**: its invoices are the fiscal
     record.
4. **The organization row becomes a tombstone.**
   - Its name becomes a fixed erased label.
   - Its slug becomes a random value.
   - Its memberships are removed.
   - Every flag it carried is reset.

The sweep then emails the Owner and Admins that it is done. That is the last
message they get from the organization.

**No slug reservation — this departs from the brief** (a 90-day reservation, after
GitHub). GitHub reserves an org name because the name IS an address
(`github.com/<org>`). Motir's org slug is not: `organization-url.md` Decision 3
makes it internal substrate that nothing routes on. There is nothing to
impersonate. The addresses a person _can_ follow are workspace hostnames, and
those are reserved already, for ever, by step 2.

### 7. What survives — the billing record, for seven years

The tombstone keeps exactly:

- **In motir-core:** the `organization` row, scrubbed, and its `CiPeriodCharge`
  rows. These record per period what was accounted, charged and debited. They
  are the charge record, and they are the one billing table keyed to the
  organization alone.
- **In motir-ai:** the `AiOrganization` tombstone, `CreditLedger`,
  `CreditTransaction`, `StripeCustomer` and `StripeSubscription`.

**The meters are NOT kept.** `CiPeriodUsage`, `CiWorkflowRunUsage` and the
three `CiContainer*` tables are the inputs a charge is computed from, or our own
cost, and they cascade with their workspace in step 2. motir-ai's `UsageMonthly`
is the same kind of row (a per-project token rollup) and cascades with its
`AiProject` in step 3. They go, as they already do when account erasure deletes a sole-member
workspace. The charge they produced survives on `CiPeriodCharge` and in the
credit ledger, and the customer's invoices live in Stripe.

**Seven years after the tombstone is written**, a purge removes it and its
billing rows in both repositories: motir-core's `organization` row and its
`CiPeriodCharge` rows, and motir-ai's tombstone with its ledger and Stripe ids.
motir-ai refuses to purge an organization that is not a tombstone.

### 8. Who is told

| moment                  | who is emailed                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| scheduled               | **every member**: Owner, Admins and Members (Atlassian and Linear email admins only; members lose their work too, so they are told) |
| 7 days and 1 day before | the Owner and Admins                                                                                                                |
| cancelled               | every member                                                                                                                        |
| erased                  | the Owner and Admins                                                                                                                |

Emails are sent after the commit that caused them, never inside it.

### 9. Backups

Backups are not scrubbed. They age out on their own rotation, which DPA §10 and
privacy §6 already disclose: data present only in a backup is never restored to
active use. This record promises nothing beyond what those two documents say.

---

## Consequences

**The sixteen cards build to §1–§9.** Where this record departs from the
story's brief, a sibling's current text says something this record makes false.
Those clauses are listed here by key. Each is amended on that card once this
record is accepted and merged, citing the merge commit. None of them changes a
card's scope; each changes a mechanism, an order or a list.

| card                                               | clause this record makes false                                                                                                                                                                                 | becomes                                                                                                                               |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| MOTIR-6390 (design), MOTIR-6402 (danger zone)      | _"the password step-up, or passkey where the account has no password"_                                                                                                                                         | a password when the account has one, otherwise a sign-in within the last 10 minutes (§1); the design draws the "sign in again" branch |
| MOTIR-6399 (schedule service)                      | _"a fresh passkey assertion for a passwordless one"_; the `passkeyAssertion` input                                                                                                                             | the session's sign-in time checked against 10 minutes (§1)                                                                            |
| MOTIR-6391 (request table)                         | `erasureStep` ordered `workspaces \| git \| ai \| tombstone`                                                                                                                                                   | `git \| workspaces \| ai \| tombstone` (§6)                                                                                           |
| MOTIR-6400 (sweep)                                 | step order with workspaces first; _"writing a slug reservation digest with a 90-day expiry"_; AC _"`slug` replaced, with a reservation present"_ and _"its `CiPeriodCharge` / `CiPeriodUsage` rows unchanged"_ | Git first; slug replaced, no reservation; `CiPeriodCharge` unchanged and the meters gone (§6, §7)                                     |
| MOTIR-6401 (seven-year purge)                      | billing tables listed as `CiPeriodCharge`, `CiPeriodUsage`, `CiWorkflowRunUsage`, the container-cost rows                                                                                                      | `CiPeriodCharge` alone remains on a tombstone (§7)                                                                                    |
| MOTIR-6404 (core integration gate)                 | _"its `CiPeriodCharge` / `CiPeriodUsage` / `CiWorkflowRunUsage` rows are unchanged"_                                                                                                                           | `CiPeriodCharge` unchanged; the meters erased with their workspaces (§7)                                                              |
| MOTIR-6392 (motir-ai closing)                      | the AC's singular _"leaves it `cancel_at_period_end = true`"_, and one `renewalWasOn` flag for the org                                                                                                         | every active subscription of the customer, each restored to its OWN prior value (§3); the card's body already says "every"            |
| MOTIR-6393 (offboard), MOTIR-6394 (purge-retained) | `UsageMonthly` listed among the rows KEPT                                                                                                                                                                      | `UsageMonthly` is erased with its projects (§7)                                                                                       |

**Account erasure already behaves as §7 says, and its header says otherwise.**
A sole-member workspace erased for a departing user takes its `Ci*Usage` rows
with it, while `accountErasureSweepService`'s header says the `Ci*Usage` meters
_"survive by construction"_. The charge record does survive, so nothing owed is
lost. The false sentence is filed as its own bug, MOTIR-6409, rather than edited
in this record's pull request.

## What this does NOT decide

- **An organization-wide export.** DPA §10 offers to _"delete or return"_
  Customer Data at the customer's choice, and today the only export is the
  personal one. Whether Motir owes an org-level export, and who builds it, is
  **not decided here** and has no card yet. It is the gap the story names.
- **What a Member's personal archive contains.** It is unchanged; this record
  only keeps it reachable.
- **Removing a single workspace**, and who may do it. That is MOTIR-6309, as it
  stands.
- **Organization-addressable URLs.** `organization-url.md` stands. If they are
  ever adopted, a slug reservation becomes a real question to decide then.
- **The wording of the emails, the banner and the dialog.** That belongs to the
  design (MOTIR-6390) and the copy it carries.
- **What happens to the memberless organization row that a SOLO Owner's account
  erasure leaves today.** It predates this story and is not a deletion the
  Owner asked for.
