# Prodect findings log

This file is the file-based fallback for the bug-logging protocol defined
in `notes.html` mistake #27 (out-of-scope findings during Subtask
execution). Every entry below was discovered by a coding agent (or by the
planner during validation) while executing a Subtask, but was outside that
Subtask's acceptance criteria — so it got logged here rather than absorbed
into the current PR.

**Lifecycle:** the planner scans this file as part of every replan pass.
Each finding becomes one of:

- A new Subtask (the finding's description becomes the AC).
- An addition to an existing planned-but-not-dispatched Subtask.
- A documented deferral with a re-review trigger.

Once a finding is converted into a Subtask, its entry below gets a
`> Resolved: <Subtask-ID>` note appended but is NOT deleted — the audit
trail of "what we found and what we did about it" is more valuable than a
short list.

**Future state:** when the Prodect MCP exists, agents log via the
`create-bug` tool instead of editing this file. This file then becomes
read-only history.

---

## #1 — Better-Auth `accountLinking.trustedProviders: ['google']` didn't auto-link an email-first User to a later Google sign-in

> **Status: Resolved in Subtask 1.1.7 (the same Subtask that surfaced it).**
> Normally a finding here would defer to a later Subtask per the
> mistake-#27 protocol — log, don't absorb. We deviated for this entry
> because Prodect itself is the project being built using its own workflow
> right now (no bug-tracker exists for these findings to flow into yet),
> and the fix was a single config line tightly coupled to the test that
> surfaced it. The protocol stands for future Subtasks once Prodect has
> a real bug-tracker landing place.

- **Found in:** Subtask 1.1.7 (E2E Playwright tests for auth) — observed
  while validating `tests/e2e/auth-google.spec.ts`.
- **Introducing Subtask:** 1.1.4 (Google OAuth + accountLinking wiring).
  Compounded by 1.1.3's `user.emailVerified` defaulting to false on
  email/password sign-up plus no verification UX (deferred).
- **Files involved at discovery:** `lib/auth/index.ts` accountLinking
  block; `lib/users/repo.ts` createUser (sets `emailVerified: false`).
- **How it manifested:** email-first User signs up → signs out → clicks
  "Continue with Google" with the same email → Better-Auth's callback
  rejected the link with `account_not_linked` and redirected to
  `/api/auth/error?error=account_not_linked`.
- **Root cause:** Better-Auth 1.6.11's `oauth2/link-account.mjs` line 22
  gates linking on `requireLocalEmailVerified` (default `true`) ANDed
  with the existing user's emailVerified column, separately from the
  `trustedProviders` check. Even with Google in `trustedProviders`,
  linking was blocked because our email-first User had
  `emailVerified: false`.
- **Fix:** Set `accountLinking.requireLocalEmailVerified: false` in
  `lib/auth/index.ts`. This defers the verification gate to the
  provider's `userInfo.emailVerified` (which Google enforces upstream
  before issuing the id_token), aligning the behavior with the
  `trustedProviders: ['google']` intent. Side benefit: Better-Auth
  promotes the local user.emailVerified to true on the linking sign-in
  (link-account.mjs line 48), so the cross-provider sign-in upgrades
  the User to verified.
- **Verified by:** `tests/e2e/auth-google.spec.ts` Part 3 — email/password
  sign-up → sign-out → Google sign-in with same email → /dashboard, with
  DB assertions that exactly one User row exists with both credential
  and google Account rows tied to it AND `emailVerified === true`.

The reverse direction (OAuth-first then email/password sign-in) remains
unsupported and is NOT in scope for this Subtask. OAuth-only users have
no credential Account row with a password hash, so credential sign-in
returns INVALID_PASSWORD. Adding it would require either a "set a
password" UI for OAuth-only users or a "passwordless" sign-in path. Track
as a candidate Subtask once Story 1.1 has a profile-settings surface.

---
