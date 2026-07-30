# Spike — the four GitHub mechanics repo creation rests on

**MOTIR-1777** (Story MOTIR-1775 · reads into [`docs/decisions/project-repository-set.md`](./decisions/project-repository-set.md)) ·
2026-07-30 · method: GitHub REST/Apps documentation + live API transcripts against `api.github.com`.

This document answers four mechanics that the repository-SET story was planned on but never verified. It
records **what was observed**, not what is plausible. Where a mechanic could not be settled empirically in
this environment, it is marked **unverified** and carries the exact transcript to run — never a probable
answer. (`notes.html` #25: _"never assume an installed integration covers the full provider lifecycle — check
online, don't guess"_; the run-time claim gate: verify against shipped reality before building.)

## Verdicts

| #   | Mechanic                                                            | Verdict                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Does creating a repo need a grant the identity token does not have? | **verified — and the question's framing is wrong.** It is a GitHub App _permission_ (`Administration: write`), not an OAuth _scope_. Existing installations **and** existing user authorizations must approve.                       |
| 2   | Does an all-repositories installation cover repos created later?    | **verified** for access · **verified-with-caveat** for the event: **no `installation_repositories` delivery fires**, so Motir's mirror must be reconciled in-flow.                                                                   |
| 3   | Can a repo be added to an existing installation by API?             | **verified.** A real endpoint exists but is **unusable by Motir** (PAT-classic only). It is also **mostly unnecessary** — an app-created repo is auto-granted even on a `selected` install. Existing repos use the shipped hand-off. |
| 4   | Creating N repos in one flow                                        | **verified** for rate limits, partial failure, retry and the 422 signal (three live transcripts) · **unverified** for create latency — see §4.2, which names the blocker and the exact test.                                         |

---

## Mechanic 1 — the grant repo creation actually needs

### The premise this spike breaks

The card, and the ADR's restatement of it, ask _"whether creating a repo needs a **scope** beyond the identity
grant."_ **There is no scope to add.** Motir's identity grant is a **GitHub App user-to-server** flow, not a
classic OAuth App — `lib/services/githubIdentityService.ts:31` reads `GITHUB_APP_CLIENT_ID` /
`GITHUB_APP_CLIENT_SECRET`, and `buildAuthorizeUrl` deliberately sets **no `scope` parameter** at all:

```ts
// lib/services/githubIdentityService.ts (buildAuthorizeUrl)
// Identity-only grant: no `scope` (a GitHub App's user-to-server token
// carries no OAuth scopes — repo access comes from the installation, not
// this token).
```

A user access token minted by a GitHub App is governed by **the App registration's permissions**, plus what the
user authorized. So the answer to "which scope do we add" is: none — _a permission is added to the App
registration_, and that is a materially different, more expensive change (see re-consent, below).

### What each creation endpoint requires

From [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps?apiVersion=2022-11-28)
and the endpoint availability lists
([user access tokens](https://docs.github.com/en/rest/overview/endpoints-available-for-github-app-user-access-tokens?apiVersion=2022-11-28) ·
[installation access tokens](https://docs.github.com/en/rest/overview/endpoints-available-for-github-app-installation-access-tokens?apiVersion=2022-11-28)):

| Endpoint                              | App permission                                      | User access token (UAT) | Installation token (IAT) |
| ------------------------------------- | --------------------------------------------------- | ----------------------- | ------------------------ |
| `POST /user/repos`                    | Repository **Administration: write**                | ✅ **yes**              | ❌ **no — UAT only**     |
| `POST /orgs/{org}/repos`              | Repository **Administration: write**                | ✅ yes                  | ✅ yes                   |
| `POST /repos/{owner}/{repo}/generate` | Repository **Administration: write** (+ additional) | ✅ yes                  | ✅ yes                   |

Two consequences the code cards must absorb:

1. **A repo under a personal account can only be created with the acting user's token.** `POST /user/repos` is
   _not available to installation access tokens_. There is no server-side, user-absent path to a personal-account
   repo — which makes the Motir-org fallback the only credential-free option for a user who has no org.
2. **An org repo can be created server-side** with `lib/github/appAuth.ts`'s installation token, provided the
   installation carries `Administration: write` on that org.

### Re-consent — yes, and it is a two-sided gate

From [Editing a GitHub App's permissions](https://docs.github.com/en/apps/maintaining-github-apps/editing-a-github-apps-permissions), verbatim:

> "GitHub will send an email to each organization owner or user, notifying them of the request to update the app's permissions."
>
> "Each account where the app is installed will need to approve the new permissions."
>
> "Updated permissions won't take effect on an installation or user authorization until the new permissions are approved."
>
> "…each user that has authorized the app will need to approve the permission changes."

So adding `Administration: write` **does not silently upgrade anything**. Until an installation approves, the
App keeps its old permissions there; until a _user_ re-approves, their stored user access token still cannot
create a repo. **The product must treat "this workspace's grant is not yet upgraded" as a first-class state**,
not an error — the same shape as the existing "identity with no installation" state.

> **This is the input MOTIR-1779 (the manual grant card) applies.** Its wording must change from "add the OAuth
> scope" to: _add `Administration: write` to the Motir App registration, then approve the permission request on
> every existing installation, and re-authorize each connected user._

**Verdict: verified.** The scope question is answered by replacing it: no scope exists; the change is an App
permission, and it forces both installation-level and user-level re-approval.

---

## Mechanic 2 — does an all-repositories installation cover repos created later?

### Access: yes

[Reviewing and modifying installed GitHub Apps](https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps), verbatim:

> "If the GitHub App creates any repositories later, the app will automatically be granted access to those repositories as well."

And, stronger — this holds _even when the install is scoped to selected repositories_
([Installing a GitHub App from a third party](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party)):

> "Your GitHub App will have access to any repositories the app creates, even if someone only installs your app on selected repositories."

The no-chicken-and-egg argument therefore **holds** — for _access_. A repo Motir creates is inside the
installation the moment it exists, with no user round-trip.

### The event: no delivery — and this is the part that bites

`installation_repositories` is documented as _"A GitHub App installation was granted access to one or more
repositories"_, with actions `added` / `removed` — it describes a **change of selection**. An `all` installation
has no selection to change, so creating a repo produces no selection delta and **no `installation_repositories`
delivery** ([webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads?apiVersion=2022-11-28#installation_repositories);
corroborated by [community discussion #24379](https://github.com/orgs/community/discussions/24379) — an app
installed on all repositories of an org does not get a per-repository webhook when a new repo appears).

**Why this matters here specifically.** `lib/services/githubWebhookService.ts` only ever reaches
`reconcileInstallation` from two events:

```ts
case 'installation':               return this.handleInstallation(body);
case 'installation_repositories':  return this.handleInstallationRepositories(body);
```

and `reconcileInstallation` is what re-reads GitHub's authoritative repo set
(`fetchInstallationRepos`) and mirrors it into `GithubRepo` via `persistInstallation`. So: the App **can see**
the new repo, but **Motir's mirror will not learn about it** — no delivery, no reconcile, no `GithubRepo` row,
and no code-graph index enqueue (`enqueueNewlyAddedRepos`).

> **Defensive requirement for MOTIR-1781:** after creating each repo, the creation flow must drive the mirror
> itself — call the same reconcile/persist path in-flow rather than waiting for a webhook that will not arrive.
> Do **not** subscribe to the `repository` event as the fix: it would mirror repos created outside Motir too,
> which is a different product decision and is not what this card needs.

**Verdict: verified** (access) · **verified-with-caveat** (the event — GitHub documents when the event _does_
fire, not a negative statement that it does not; the negative is inferred from the event's definition plus
community evidence, and is cheap to confirm once the App has `Administration: write`).

---

## Mechanic 3 — can a repo be ADDED to an existing installation by API?

**The endpoint is real** — no invention needed:

`PUT /user/installations/{installation_id}/repositories/{repository_id}`
([Add a repository to an app installation](https://docs.github.com/en/rest/apps/installations?apiVersion=2022-11-28)) —
responses `204` / `304` / `403` / `404`; the `DELETE` counterpart removes one.

**But Motir cannot call it**, on three independent counts:

1. **Token type.** Documented as _"PATs (classic) with the `repo` scope"_. It does **not** appear in the
   endpoints-available list for GitHub App user access tokens, and not for installation tokens either. Motir has
   neither a classic PAT nor a mandate to ask for one.
2. **Installation shape.** The installation must have `repository_selection` of `selected`; it 422s for an
   installation on all repositories.
3. **Actor.** It requires admin access to the repository by the authenticated user.

**And it is mostly unnecessary.** Per Mechanic 2, a repo the App _creates_ is auto-granted even under a
`selected` install — so the only case that needs anything at all is **connecting an EXISTING repo** the
installation does not already cover.

For that case the answer is the **user hand-off**, and the precedent is already shipped:
`githubInstallationManageUrl()` in `lib/github/appLinks.ts` builds the installation-settings URL
(`https://github.com/organizations/{org}/settings/installations/{id}` or `https://github.com/settings/installations/{id}`),
under the module's stated honesty rule — _"repo selection is changed on GitHub's install screen, never faked
in-app."_ The connect row reuses that link; it does not gain an API path.

One adjacent limitation worth recording for the UI card: an install scoped to "Only select repositories"
**cannot currently be created with zero repositories selected** — GitHub disables the install button
([community discussion #191059](https://github.com/orgs/community/discussions/191059), open, no staff commitment).
So a brand-new workspace whose org has no repos yet cannot do a least-privilege selected install first and let
Motir create everything after; it installs on all repositories, or selects something existing.

**Verdict: verified.** Named API, named constraints, named hand-off — and the create path needs neither.

---

## Mechanic 4 — creating N repos in one flow

### 4.1 Rate limits — 2–5 repos is nowhere near any limit

From [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2022-11-28), verbatim:

> **Secondary:** "In general, no more than 80 content-generating requests per minute and no more than 500 content-generating requests per hour are allowed."
>
> "No more than 100 concurrent requests are allowed."
>
> "No more than 900 points per minute are allowed for REST API endpoints."
>
> **Primary:** "Primary rate limits for GitHub App user access tokens (as opposed to installation access tokens) are dictated by the primary rate limits for the authenticated user." · "GitHub Apps authenticating with an installation access token use the installation's minimum rate limit of 5,000 requests per hour."

Observed primary limit on this machine:

```console
$ gh api rate_limit --jq '.resources.core'
{"limit":5000,"remaining":4978,"reset":1785415174,"used":22}
```

**The number that governs repo creation is 80 content-generating requests per minute / 500 per hour.** A
two-repo project costs 2; a five-repo project costs 5. Creating 2–5 repos back-to-back does not approach it, and
serialising the calls (which §4.3 requires anyway) keeps it far below the 100-concurrent ceiling.

_Caveat, stated as a caveat:_ GitHub also applies undisclosed abuse limits on repository creation specifically,
with no published number. Nothing in the documented limits constrains this story's N, but a code path that ever
loops over an unbounded set must still honour `Retry-After` / `403 + secondary rate limit` and back off.

### 4.2 Latency — UNVERIFIED, and here is exactly why and how to settle it

**Not verified in this spike.** Measuring create latency requires actually creating repos, and the only GitHub
credential available in this environment (`gh`, scopes `gist, read:org, repo, workflow`) **has no `delete_repo`
scope** — scratch repos could be created but not cleaned up, leaving junk in the user's real account. This is
recorded as unverified rather than estimated.

What _is_ established: **the response does not mean the repository is ready.** Repositories generated from a
template return before their contents are populated — see
[terraform-provider-github#1081](https://github.com/integrations/terraform-provider-github/issues/1081)
(404s against a just-generated repo) and the widely-reported empty `default_branch` on the generate response
that appears only on a subsequent read. The generate endpoint is documented with a single success code (`201`)
and **no** readiness guarantee.

> **What the UI card (MOTIR-1782) must assume, plainly: per-row async, not one request.** Model repo
> establishment as a **per-row job with its own state** (`pending → creating → seeding → ready | failed`), each
> row poll-confirmed to readiness (`GET /repos/{owner}/{name}` returning a non-empty `default_branch`, or the
> contents read succeeding) before it is called done. Do **not** build a single synchronous "create the set"
> request that returns when the last call returns: even if creation itself proved fast, seeding is not
> synchronous, and one row's failure must not take the others' results with it.

To settle the number, run this with a token that has `delete_repo` (≈3 minutes, self-cleaning):

```bash
# requires: gh auth refresh -s delete_repo,repo
ORG=moooon-B-V; TMPL=nextjs-prisma-vercel-starter
for i in 1 2 3; do
  N="motir-spike-1777-$i"
  s=$(python3 -c 'import time;print(time.time())')
  gh api -X POST "/repos/$ORG/$TMPL/generate" -f owner="$ORG" -f name="$N" -F private=true --jq '.default_branch'
  c=$(python3 -c 'import time;print(time.time())')
  until gh api "repos/$ORG/$N/contents" --jq 'length' >/dev/null 2>&1; do sleep 1; done
  r=$(python3 -c 'import time;print(time.time())')
  python3 -c "print('$N create=%.2fs ready=%.2fs' % ($c-$s, $r-$s))"
done
for i in 1 2 3; do gh api -X DELETE "/repos/$ORG/motir-spike-1777-$i"; done   # cleanup
```

Record the output back into this section and flip the verdict.

### 4.3 Partial failure and retry — verified, with a usable "already created" signal

Repo creation is **one call per repo**; there is no batch endpoint and no transaction across repos. So repo 2
of 3 failing leaves **repo 1 created and intact** — nothing rolls back, and nothing needs to: the set is
established row by row.

**Retrying just the failed row is safe, because a colliding name is rejected rather than duplicated.** Three
live transcripts, run 2026-07-30 against `api.github.com` with a `repo`-scoped token, each targeting a name that
already exists (so nothing was created):

```console
$ gh api -X POST /user/repos -f name=calculator -i | head -1
HTTP/2.0 422 Unprocessable Entity

$ gh api -X POST /user/repos -f name=calculator
{"message":"Repository creation failed.","errors":[{"resource":"Repository","code":"custom",
 "field":"name","message":"name already exists on this account"}],"status":"422"}

$ gh api -X POST /orgs/moooon-B-V/repos -f name=motir-core
{"message":"Repository creation failed.","errors":[{"resource":"Repository","code":"custom",
 "field":"name","message":"name already exists on this account"}],"status":"422"}

$ gh api -X POST /repos/moooon-B-V/nextjs-prisma-vercel-starter/generate \
    -f owner=moooon-B-V -f name=motir-core
{"message":"Could not clone: Name already exists on this account",
 "errors":["Could not clone: Name already exists on this account"],"status":"422"}
```

Three findings from those transcripts:

1. **`POST /user/repos` is NOT idempotent — it 422s.** That 422 is a usable "this name is already taken"
   signal, which makes a per-row retry safe: a retry of an already-succeeded row cannot create a second repo.
2. **The generate endpoint's error shape is DIFFERENT.** `errors` is an array of **strings**
   (`["Could not clone: …"]`), not of objects — a shared error parser that reads `errors[0].message` (correct
   for `/user/repos` and `/orgs/{org}/repos`) will read `undefined` here. Detect the collision on the **422
   status plus a case-insensitive `already exists` match on `message`**, not on the `errors` element shape.
3. **A 422 is not proof that _Motir_ created it.** An unrelated repo of the same name collides identically. A
   row that 422s must be resolved as "name taken — connect it, or choose another name" and shown to the user,
   never silently adopted as this project's repo.

### 4.4 Template seeding N times from one starter — verified

`POST /repos/{template_owner}/{template_repo}/generate` names the **template** in the path and the **new repo**
in the body, so it is called once per target and the same starter can be the source of every row — there is no
per-template exclusivity. The starter is a valid template, confirmed live:

```console
$ gh api repos/moooon-B-V/nextjs-prisma-vercel-starter --jq '{full_name, is_template, private}'
{"full_name":"moooon-B-V/nextjs-prisma-vercel-starter","is_template":true,"private":false}
```

Per the [docs](https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28#create-a-repository-using-a-template):
_"To check if a repository is available to use as a template, get the repository's information using the Get a
repository endpoint and check that the `is_template` key is true"_ and _"If the repository is not public, the
authenticated user must own or be a member of an organization that owns the repository."_ The starter is
public, so no membership constraint applies to Motir's users.

**Is it synchronous enough to report success in-flow? No** — see §4.2. `201` means "accepted and the repo
record exists", not "the tree is seeded". Report a row as `ready` only after a readiness read succeeds.

**Verdict: verified** for rate limits, partial-failure semantics, the retry signal and template reuse ·
**unverified** for the latency number, with the test above.

---

## Findings that contradict the plan — called out by name

1. **MOTIR-1777 / MOTIR-1779 / the ADR all frame Mechanic 1 as an OAuth _scope_.** It is not: Motir's identity
   grant is a GitHub App user-to-server token that carries no scopes at all. **MOTIR-1779 must be re-worded** to
   "add `Administration: write` to the App registration; approve the permission request on each existing
   installation; re-authorize each connected user" — a strictly larger change than adding a scope, because it
   blocks on third parties (§1).
2. **`prisma/schema.prisma`'s `GithubIdentity` comment — _"This grant is IDENTITY ONLY … grants NO repo
   access"_ — is true today and becomes false the moment `Administration: write` ships.** MOTIR-1781 must update
   that doc comment in the same PR that first uses the identity token to create a repo, or the schema will
   actively mislead the next reader.
3. **"An all-repositories install removes the chicken-and-egg problem" is only half true.** It removes it for
   _access_; it does **not** deliver a webhook, so Motir's `GithubRepo` mirror does not learn about a repo it
   created (§2). Any card that assumed the existing `installation_repositories` → `reconcileInstallation` path
   would pick the new repos up is wrong — MOTIR-1781 owns an explicit in-flow reconcile.
4. **A personal-account repo cannot be created server-side.** `POST /user/repos` is user-access-token-only, so
   any design that has the backend create repos with an installation token works **only** for org-owned repos
   (§1). The Motir-org fallback is therefore load-bearing for users without an org, not a nicety.
5. **Repo-set establishment cannot be one synchronous request.** Template seeding is not synchronous (§4.2), so
   MOTIR-1782's state model is per-row async with polling — this is the shape the design must draw, and it is
   the one answer here that changes a UI card rather than a service card.

## Open item

Create latency (§4.2) is the single unverified number. It does not block MOTIR-1781 or MOTIR-1782 — both must
be built per-row async regardless, which is the conservative shape — but it should be filled in when a
`delete_repo`-scoped token is available, using the self-cleaning script above.
