# `motir login` is a device grant whose approval mints a CLI-scoped PAT

**Status:** accepted · **Story MOTIR-1863 · MOTIR-1864**

## Context

Motir has **two credential systems that do not currently meet.**

- **Better-Auth sessions** — cookie-borne, minted by `lib/auth/index.ts`
  (`plugins: [nextCookies()]`), read server-side by that module's `getSession()`.
  Everything in the web app authenticates this way.
- **Personal access tokens** — a `motir_pat_` bearer, 32 random bytes,
  sha-256-hashed at rest (`lib/apiTokens/token.ts`), resolved by
  `apiTokensService.verify` to `{ user, workspaceId, scopes }`, and consumed by
  the two bearer gates: `lib/apiTokens/routeAuth.ts` (REST) and the MCP
  transport gate. Everything **outside** the browser authenticates this way.

The CLI is squarely on the second side: `packages/cli/src/mcpClient.ts` opens one
streamable-HTTP transport whose only `requestInit` header is
`Authorization: Bearer <pat>` — a session cookie is not a credential it can
present, and no gate would accept one if it could.

What ships today is **paste-only**. `motir auth login`
(`packages/cli/src/commands/auth.ts`) takes `--token`, falls back to
`MOTIR_TOKEN`, else prompts on a TTY; validates the secret with a real
`connect()` / `listToolNames()` / `whoami()` round trip; then writes it to
`~/.config/motir/config.json` — `chmod 600` in a `0700` dir, keyed by normalized
server URL (`packages/cli/src/config/userConfig.ts`). The user gets that secret
by hand from **Settings → Account → API tokens → Create** (`docs/cli.md` §
Authenticate). `MOTIR_TOKEN` is honoured **at login only** — `docs/cli.md` §
Files and environment says so explicitly, and `MOTIR_SERVER` does not exist at
all.

Two facts about the runtime shape the whole decision:

1. **The terminal and the browser are frequently not on the same machine.** A
   `motir auto` run dispatches across the workspace where the repos live —
   routinely a remote box reached over SSH, a dev container, or a VM with no
   graphical session. `packages/cli/src/browser.ts` already encodes that
   reality: it checks `DISPLAY`/`WAYLAND_DISPLAY`, resolves `false` rather than
   throwing, and its header states the contract — _"The CLI ALWAYS prints the URL
   first, so this is purely additive."_
2. **The published sandbox does not log in at all.** `docs/cli.md` § The sandbox
   mounts `~/.config/motir` **read-only** — _"`motir auth login` runs on the
   host, the container only consumes the result"_ — which
   `userConfig.stateDir()`'s docstring repeats as the reason CLI state moved to a
   separate home.

> **A correction to this card's premise, recorded rather than silently applied**
> (`notes.html` #45 — do not take "it is shipped/required" on the word alone).
> MOTIR-1864 lists _"the sandbox and SSH"_ as the two hard requirements. Per (2)
> the sandbox is **not** one: it consumes a host-minted credential through a
> read-only mount, which tier 1 and tier 3 already serve. The requirement that
> actually forces a browser-completed grant is (1) — **terminal and browser on
> different machines** — plus first-run ergonomics on a laptop. The mechanism
> below is unchanged by the correction; only its justification is, and it is
> stated here honestly so a later reader does not inherit a reason that does not
> hold.

---

## Q0a — The three tiers, and which wins

Three credential tiers coexist, deliberately, mirroring `gh` one-for-one
([gh auth login](https://cli.github.com/manual/gh_auth_login) ·
[gh environment](https://cli.github.com/manual/gh_help_environment)):

| Tier                | Motir                                 | `gh`            | Owner                                     | Exists for                                                                                     |
| ------------------- | ------------------------------------- | --------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1 · **env**         | `MOTIR_TOKEN` / `MOTIR_SERVER`        | `GH_TOKEN`      | **MOTIR-1876**                            | CI, the sandbox, any ephemeral box. No login step, no file, nothing to clean up.               |
| 2 · **interactive** | `motir login` (browser-completed)     | `gh auth login` | **MOTIR-1868** (+ MOTIR-1865, MOTIR-1867) | A human at a terminal who has never connected this machine. The default, and the one you type. |
| 3 · **paste**       | `motir auth login --token` (retained) | `--with-token`  | shipped                                   | A token you already hold, with a grant the device path does not offer.                         |

**Precedence, most explicit first:** `--token` (this invocation) →
`MOTIR_TOKEN` (this shell) → the stored credential in
`~/.config/motir/config.json` (this machine). Same ladder for the server:
`--server` → `MOTIR_SERVER` → the `.motir.json` link → the single stored server
(`packages/cli/src/serverResolve.ts` already implements flag → link →
single-stored; MOTIR-1876 inserts the env rung and defaults the host to
`app.motir.co`). A flag beats an env var because it is scoped to one command; an
env var beats a file because it is the operator's deliberate override of
persisted state.

That ladder has one sharp edge, and it is the reason `motir auth status` must
**name the tier that supplied the credential**: a stale `MOTIR_TOKEN` exported in
a shell profile silently outranks a fresh `motir login`, and the resulting
failure is a 401 deep in an unattended run. MOTIR-1876 owns printing it;
MOTIR-1872 owns documenting it.

**Why tier 3 survives** — the device path is deliberately un-configurable (Q2,
Q3), so `--token` remains the only way to carry a **non-default grant**: a token
with `work_items:delete` or `sprints:write`, or a 365-day/never expiry, or one
minted for a service account rather than a person. It is also the only tier that
works when the browser cannot reach the server at all (a self-hosted Motir on a
closed network, reached from a jump host). Removing it would trade a two-line
code path for a class of users with no route in.

---

## Q0b — Device authorization, not loopback + PKCE

**The received wisdom disagrees with this choice, so it is recorded as a
comparison, not a ratification** (`notes.html` #124 — score a shortlist against
load-bearing requirements; never validate the pre-picked option). The
load-bearing requirements:

- **R1** Works when the browser is on a **different machine** than the terminal
  (SSH, dev container, headless VM).
- **R2** Works with **no graphical session** and no listening port — the box may
  refuse inbound connections entirely.
- **R3** The secret **never transits the user's shell** (no paste, no history, no
  scrollback, no CI log).
- **R4** Reuses shipped primitives; adds no long-lived server inside the CLI.
- **R5** One mechanism for every case — a second code path is a second thing to
  break unattended.
- **R6** Survives a phishing attempt, or fails visibly.

| Option                                      | R1  | R2  | R3  | R4                                                 | R5  | R6                                            |
| ------------------------------------------- | --- | --- | --- | -------------------------------------------------- | --- | --------------------------------------------- |
| **A** Paste-only (status quo)               | ✅  | ✅  | ❌  | ✅ (shipped)                                       | ✅  | ✅ (no code to phish)                         |
| **B** Loopback redirect + PKCE              | ❌  | ❌  | ✅  | ❌ (an HTTP server + free-port dance in `motir`)   | ❌  | ✅ (redirect is same-machine by construction) |
| **C** Device authorization grant (RFC 8628) | ✅  | ✅  | ✅  | ✅ (`browser.ts` + the shipped Better-Auth plugin) | ✅  | ⚠️ (a code can be socially engineered)        |
| **D** A Motir-bespoke one-time code         | ✅  | ✅  | ✅  | ❌ (reimplements C by hand)                        | ✅  | ⚠️ (same as C, unreviewed)                    |

**Decision: C.** B is rejected on R1/R2, which are not edge cases here but the
common shape of a Motir run — the CLI dispatches where the repos are, and a
loopback redirect requires the browser to resolve `http://127.0.0.1:<port>` on
that same host. It also fails R4/R5: the CLI would have to bind a port and run an
HTTP server, and a same-machine-only mechanism forces keeping a second path for
every other case, which is exactly the branch that rots unattended. D reimplements
C with no review. A stays — as tier 3.

**The counter-argument, stated in full, because it is correct on its own terms.**
[CLI authentication methods compared](https://blog.logto.io/cli-authentication-methods)
holds that _"when the CLI can open a browser on the same machine, browser OAuth
with PKCE is strictly better than device code flow — same UX, stronger security
guarantees, no phishing vector,"_ and notes AWS moved off device code as a
default for that reason. Both halves are true. The conditional in the first
clause — _"on the same machine"_ — is what does not hold for Motir often enough
to build on, and the phishing vector in the second is real and is not designed
away below, only mitigated. `gh` reached the same conclusion for the same reason
(one flow that works over SSH), and Better-Auth ships the flow as a reviewed
plugin, so R4 costs nothing.

**The residual risk, and its mitigation.** Device code is phishable: an attacker
who can talk to the victim ("run this, then enter ABCD-EFGH") gets a credential
bound to the victim's account. Nothing in the protocol prevents it, so the
mitigation is entirely in the approval screen (MOTIR-1866 designs it,
MOTIR-1867 builds it), and it is **load-bearing, not decoration**. The screen
MUST state, before any button:

1. **What** is connecting — `motir` CLI, and the **hostname** it reported.
2. **Who** it will act as — the signed-in user's name and email.
3. **Which workspace** the credential will be bound to (the picker, Q3).
4. **Which scopes** it will carry, in plain words (Q2).
5. That approving **mints a credential**, and where to revoke it.

That inventory is what makes a code entered under someone else's instruction
visibly wrong: the hostname is not yours, or the workspace is not the one you
were told about. A screen that says only "Approve this device?" provides none of
that signal — which is why the design card cannot treat this list as optional
copy.

---

## Q1 — What approval exchanges, and who mints it

### What the shipped plugin actually does

Better-Auth `1.6.11` ships `deviceAuthorization`
(`node_modules/better-auth/dist/plugins/device-authorization/`). Read from the
installed source, not the docs:

- `index.mjs` mounts five endpoints — `/device/code`, `/device/token`, `GET
/device`, `/device/approve`, `/device/deny` — with options `expiresIn` (default
  `30m`), `interval` (`5s`), `deviceCodeLength` (40), `userCodeLength` (8),
  `generateDeviceCode`, `generateUserCode`, `validateClient`,
  `onDeviceAuthRequest`, `verificationUri` (default `/device`), `schema`.
- `routes.mjs`'s default user-code charset is
  `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — already free of `0/O/1/I/L`, so **no
  `generateUserCode` override is needed**. `GET /device` and `/device/approve`
  both `replace(/-/g, '')` the submitted code, so a displayed `ABCD-EFGH`
  grouping works natively.
- `buildVerificationUris` resolves the relative `/device` against
  `ctx.context.baseURL`, so the printed link inherits `lib/auth/index.ts`'s
  `baseURL` chain (`BETTER_AUTH_URL` → `VERCEL_BRANCH_URL` → `VERCEL_URL` →
  localhost) and a preview deployment prints its own URL. `trustedOrigins` is
  inherited unchanged.
- **`POST /device/token` completes into a SESSION.** On `status === 'approved'`
  it calls `internalAdapter.createSession(user.id)`, `ctx.context.setNewSession(…)`,
  deletes the `deviceCode` row, and returns
  `{ access_token: session.token, token_type: 'Bearer', expires_in, scope }`.
  That `access_token` is a **Better-Auth session token**, not a PAT — no bearer
  gate in this repo would accept it.
- **`/device/approve` takes `{ userCode }` and nothing else** — its body schema
  is literally `z.object({ userCode })`. It requires a session, and rejects with
  `DEVICE_CODE_NOT_CLAIMED` unless `GET /device?user_code=…` was called first
  while signed in (that read is what stamps `userId` onto the row).
- The plugin's `deviceCode` model **cannot be extended through the plugin**:
  `mergeSchema` (`dist/db/schema.mjs:110`) only renames a model or an existing
  field. There is no mechanism to add a field to it.

So the plugin owns the parts we want — code issuance, the claim, expiry, the
`slow_down` throttle, the pending/approved/denied machine — and gets exactly one
thing wrong for us: **the credential it hands back.**

### The options for fixing that, and why two lose

**Option 1 — a global Better-Auth `hooks.after` on `/device/token` that rewrites
the response body.** Rejected. By the time an after-hook runs, the plugin has
already created a real `Session` row and queued its `Set-Cookie` through
`nextCookies()`. The hook could swap the body but not un-create the session, so
every CLI login would leave an orphan browser session behind — a second live
credential, issued to a client that cannot use or revoke it. It also still has to
mint the PAT, so it saves nothing.

**Option 2 — the CLI polls the plugin's `/device/token`, then exchanges the
session token for a PAT at a second Motir route.** Rejected. Two round trips, an
extra plugin (`bearer`) to make a session token presentable as a `Bearer`
header, the same orphan session as Option 1, and a window in which a session
token is the CLI's credential.

**Option 3 — Motir owns the CLI-facing routes; the plugin stays a private
implementation detail.** Decided. The CLI never calls `/api/auth/*`; the plugin's
state machine is driven server-side through `auth.api.*`.

### The endpoints the substrate mounts

MOTIR-1865 mounts exactly these. `/api/cli/device/*` names the CLI-connect
**flow**, not the caller.

| Endpoint                           | Owner                                  | Called by          | Does                                                                                                        |
| ---------------------------------- | -------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `POST /api/cli/device/start`       | Motir (wraps `auth.api.deviceCode`)    | the CLI            | Body `{ hostname }`. Issues the codes; records `hostname` on the grant. Returns the RFC 8628 fields.        |
| `GET /api/auth/device?user_code=…` | the plugin, as-is                      | the `/device` page | Claims the code for the signed-in session and returns `{ user_code, status }`. **Must precede approve.**    |
| `POST /api/cli/device/approve`     | Motir (wraps `auth.api.deviceApprove`) | the `/device` page | Body `{ userCode, workspaceId }`. Asserts membership, records the workspace choice, then flips to approved. |
| `POST /api/auth/device/deny`       | the plugin, as-is                      | the `/device` page | Flips to denied.                                                                                            |
| `POST /api/cli/device/token`       | Motir                                  | the CLI            | The poll. Five-state branch; on approved, **mints the PAT and returns the plaintext once**.                 |

Plugin config in `lib/auth/index.ts`'s `plugins` array:
`deviceAuthorization({ verificationUri: '/device', expiresIn: '15m', interval: '5s', validateClient })`.
`15m` rather than the default `30m` — a shorter code lifetime is a smaller
phishing window, and fifteen minutes is ample to open a browser, sign in, and
approve. `validateClient` pins `client_id` to the CLI's own identifier so an
unrelated caller cannot open grants against this deployment.

`workspaceId` and `hostname` are **Motir-owned nullable columns on the
`DeviceCode` Prisma model** (which MOTIR-1865 adds — there is no such model
today). The plugin's adapter neither reads nor writes them; a Motir repository
does, per the 4-layer rule. This is the answer to `mergeSchema`'s
rename-only limitation: we own `schema.prisma`, so we add the columns there
rather than trying to extend the plugin's schema.

### The mint happens at the POLL, not at approval

`lib/services/apiTokensService.ts` states the invariant this preserves: _"The
plaintext secret lives in exactly ONE place ever: `create`'s return value."_
Minting at approval time would force parking a plaintext (or reversibly
encrypted) secret at rest until the CLI collects it, breaking that invariant for
the sake of ordering. So **approval records a decision** (status + workspace +
hostname) and the **poll that observes it mints**, returning the plaintext in the
same response that creates it. Concretely, `POST /api/cli/device/token` on
`approved`:

1. Reads the grant row (device code, status, expiry, `lastPolledAt`, workspace).
2. Calls `apiTokensService.create(userId, workspaceId, { label, scopes, expiresAt })`
   — which re-asserts membership itself (`workspacesService.assertMembership`).
3. Deletes the grant row (single-use), then returns the plaintext.

A user who approves and then kills the CLI therefore leaves **no token behind** —
nothing minted, nothing to revoke. That is a feature, and it is the reason this
ordering was chosen over the more obvious one.

This does not weaken `docs/mcp.md`'s rule that _"a PAT itself cannot mint more
PATs."_ The authority for this mint is the **browser session** that approved it,
established on the approval screen; no bearer token authorizes anything here.

### Success shape

```json
{
  "access_token": "motir_pat_…",
  "token_type": "Bearer",
  "scope": "read work_items:write integration",
  "expires_in": 7776000,
  "user": { "id": "…", "name": "…", "email": "…" },
  "workspace": { "id": "…", "name": "…", "slug": "…" }
}
```

RFC 8628 field names are kept so the CLI's branch is the standard one; `user` and
`workspace` are Motir additions so `motir login` can print the same
`Logged in as … (workspace …)` confirmation `motir auth login` prints today
**without a second `whoami` round trip**. The device path also skips the
connect + `listToolNames` validation `authLogin` performs: a server-minted token
cannot be the wrong token. Tier 3 keeps that validation, because a pasted one can.

### The five error states the CLI branches on

Every failure is **HTTP 400** with `{ error, error_description }` — the plugin's
own shape (`routes.mjs`), mirrored by the Motir route so a generic RFC 8628
poller works unchanged.

| `error`                 | When                                                | The CLI does                                                                              |
| ----------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `authorization_pending` | Grant is still `pending` — nobody has approved yet. | Keep polling at `interval`. This is the normal case; it is not an error to show the user. |
| `slow_down`             | Polled inside `pollingInterval` of `lastPolledAt`.  | Add 5s to its interval and keep polling. Never abort.                                     |
| `access_denied`         | Grant is `denied`. The row is deleted.              | Print `Approval was denied. No credential was written.` Exit non-zero.                    |
| `expired_token`         | `expiresAt` has passed. The row is deleted.         | Print `The code expired before it was approved. Run 'motir login' again.` Exit non-zero.  |
| `invalid_grant`         | Unknown `device_code`, or a `client_id` mismatch.   | Hard error — a bug or a tampered request, not a retry.                                    |

A sixth, `server_error`, is HTTP 500 and is the only one that means "not your
fault, try again."

**Denied and expired write nothing.** `setCredential` is called on success only,
so `~/.config/motir/config.json` is untouched on either path — a prior working
credential for that server survives a failed `motir login` intact. MOTIR-1868
owns that, and MOTIR-1870 owns proving it.

---

## Q2 — Scopes: the narrow CLI set, fixed at the boundary

**Decision: `['read', 'work_items:write', 'integration']`, not
`DEFAULT_TOKEN_SCOPES`.**

`docs/cli.md` § Scopes asserts this is what the CLI needs; the assertion was
verified rather than copied. Every tool the shipped client calls
(`packages/cli/src/mcpClient.ts`, sixteen of them: `whoami`, `list_ready`,
`next_ready`, `get_work_item`, `transition_status`, `dispatch_prompt`,
`mark_integrated`, `complete_session`, `expand_item`, `open_plan_session`,
`append_plan_turn`, `submit_plan_session`, `get_plan_status`, `get_plan`,
`list_sprints`, `search_work_items`) maps through `TOOL_SCOPES`
(`lib/mcp/scopes.ts`) into exactly those three. The CLI calls **nothing** gated
by `work_items:archive`, `work_items:delete`, or `sprints:write` — so
`DEFAULT_TOKEN_SCOPES` (all-minus-delete) over-grants three scopes to a
credential that lives unattended on a remote box.

The set is named once, as **`CLI_TOKEN_SCOPES` in `lib/mcp/scopes.ts`** — beside
`TOKEN_SCOPES` and `DEFAULT_TOKEN_SCOPES`, in the module that already owns the
tool→scope totality guarantee, so the CLI's requirement is stated in the same
place a new tool must be classified.

**The approval screen shows the scopes and cannot change them.** Not widen: a
control that grants `work_items:delete` on a screen whose threat model is social
engineering is the one affordance that turns a phishing success into a
destructive one. Not narrow either: a hand-narrowed grant breaks `motir auto`
somewhere in the middle of an unattended run, which is the worst place to
discover a missing scope. A user who wants a different grant mints in **Settings
→ Account → API tokens → Create** (which keeps its full scope + 30/90/365/never
choice, untouched by this decision) and uses tier 3.

---

## Q3 — Expiry and workspace binding

**Workspace — chosen on the approval screen.** A PAT binds to exactly one
`workspaceId` and `apiTokensService.create` asserts membership, so the choice
cannot be deferred or defaulted server-side. The picker is seeded by
`apiTokensService.listScopeOptions(userId)` — the same org → workspace tree the
create modal already uses (every organization the user belongs to, with the
workspaces of it they can reach) — and pre-selects the approving session's
**active workspace**. A user with exactly one workspace sees it as a static line,
not a control: there is no choice to make, and rendering one implies otherwise.
The server re-asserts membership at mint time regardless of what the form posted.

Consequence, worth stating because it will surprise someone: the CLI is bound to
**one workspace per credential**, like every other PAT (the token's
`workspaceId`, not the owner's default, is what the MCP gate resolves). Working
two workspaces from one machine means two `motir login` runs against two server
entries, or tier 1 with two `MOTIR_TOKEN` values.

**Expiry — 90 days.** The same recommended default the settings modal ships
(`CreateTokenModal.tsx` opens on `'90'`; `docs/mcp.md` § Creating an API token
calls 90 days the recommended default), so the two mint paths agree and there is
one number to document. Not `never`: an unattended credential on a box you may
not still own is precisely the one that should age out. Not shorter: re-login is
a human interruption, and a device grant is only reachable by a human at a
browser. Not offered as a choice on the approval screen — same reasoning as Q2,
fewer controls on the phishable surface; 365/never remains a Settings + tier-3
path.

Consequence: expiry surfaces as a 401 like any other invalid token
(`apiTokensService.verify` → `ApiTokenExpiredError`; both gates return 401
without distinguishing), which the CLI already renders as the single
`Token invalid or expired.` error with its hint (`docs/cli.md` §
Troubleshooting). MOTIR-1872 must point that hint at `motir login`; MOTIR-1869's
connect panel should show the CLI token's expiry so it is visible before it
bites.

---

## Q4 — Label, and revocation as the only kill switch

**Label: `CLI · <hostname>`.** The hostname is the machine running the CLI —
known only to the CLI, which is why `POST /api/cli/device/start` takes it in the
body and stores it on the grant. It is display-only, so it is trimmed to the
100-char label limit `apiTokensService.normalizeLabel` enforces and never
interpreted. The label appears in two places, and that is the whole point: on the
**approval screen** (so the user can tell whether the device connecting is
theirs — mitigation item 1 above) and in the **Settings → Account → API tokens**
list, where a row reading `CLI · workbox` beside its last-used timestamp makes
"disconnect that machine" an obvious, complete action.

**Revocation in Settings is the ONLY kill switch.** `apiTokensService.revoke`
stamps `revokedAt`; `verify` then throws `ApiTokenRevokedError` and both gates 401. There is no other stop: no server-side session to expire, no device
registry, no remote wipe of the config file.

And `motir auth logout` is **not** revocation. It calls
`removeCredential(serverUrl)`, which deletes the local copy and nothing else
(`userConfig.ts`) — a token copied elsewhere keeps working. Should `motir logout`
revoke server-side? **No.** A PAT cannot manage PATs — `docs/mcp.md`: _"A PAT
itself cannot mint more PATs — the MCP tool surface has no token-management
tool"_ — and adding a revoke capability to the bearer surface so the CLI can
self-destruct would hand every leaked token the ability to lock its owner out of
their own automation. Revocation stays a cookie-session action. MOTIR-1872 must
say "logout forgets, revoke kills" in those terms rather than leaving the reader
to assume the first does the second.

---

## Consequences

- **This document ships no code** (`notes.html` #50 — a decision card is not an
  implementation). Every seam named above is unbuilt: the plugin is not in
  `lib/auth/index.ts`'s `plugins` array, there is no `DeviceCode` model in
  `prisma/schema.prisma`, no `/api/cli/device/*` route, no `/device` page, no
  `CLI_TOKEN_SCOPES`, and no `motir login` command. MOTIR-1865 owns the
  substrate, MOTIR-1867 the page, MOTIR-1868 the command, MOTIR-1869 the connect
  panel, MOTIR-1876 tier 1. A card that "uses the device grant" still has the
  device grant as an unbuilt prerequisite.
- The two credential systems now meet at exactly one seam — `POST
/api/cli/device/token` — and nowhere else. A session authorizes a mint; it
  never becomes a bearer.
- Better-Auth's plugin stays a private implementation detail. The CLI's contract
  is `/api/cli/device/*`, which versions with Motir, so a plugin upgrade that
  changes the session shape cannot break a published CLI.
- Adding an MCP tool now carries a **third** question beside its `TOOL_SCOPES`
  entry: does the CLI call it, and if so does `CLI_TOKEN_SCOPES` already cover
  it? A tool gated by `sprints:write` that the CLI later calls would 403 on every
  device-minted token.
- Phishing resistance is a **UI** property here, not a protocol one. If the
  approval screen ever loses the who/what/workspace/scopes inventory, this
  decision's risk assessment no longer holds — which makes that inventory a
  regression surface for MOTIR-1867's tests, not just copy.
- The device grant is unconfigurable by design (fixed scopes, fixed 90-day
  expiry, no delete). Tier 3 is therefore load-bearing, not legacy, and
  `docs/cli.md` must present it that way.

## Context refs

- `lib/auth/index.ts` · `lib/services/apiTokensService.ts` ·
  `lib/apiTokens/routeAuth.ts` · `lib/apiTokens/token.ts` · `lib/mcp/scopes.ts`
- `packages/cli/src/mcpClient.ts` · `commands/auth.ts` · `config/userConfig.ts` ·
  `serverResolve.ts` · `browser.ts`
- `app/(authed)/settings/account/_components/CreateTokenModal.tsx`
- `docs/cli.md` §§ Authenticate · The sandbox · Files and environment ·
  Troubleshooting · `docs/mcp.md` §§ Creating an API token · Token scopes
- `node_modules/better-auth/dist/plugins/device-authorization/{index,routes,schema,error-codes}.mjs`
  · `dist/db/schema.mjs` (`mergeSchema`) — better-auth `1.6.11`
- [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628) ·
  [gh auth login](https://cli.github.com/manual/gh_auth_login) ·
  [gh environment](https://cli.github.com/manual/gh_help_environment) ·
  [CLI authentication methods compared](https://blog.logto.io/cli-authentication-methods)
- MOTIR-1833 (`docs/decisions/code-access-for-planning.md`) — the sibling ADR
  precedent in this Story family.
