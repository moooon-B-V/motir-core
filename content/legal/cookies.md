---
title: Cookie Policy
version: 1.0.0
effectiveDate: TBD
status: approved
---

# Cookie Policy

**This policy covers the hosted Motir service at `app.motir.co`, operated by moooon B.V.
It does not describe a self-hosted installation**, which sets whichever cookies its own
operator configures.

## We do not ask for cookie consent, and this is why

**Motir sets no advertising cookies, no tracking cookies, and no third-party analytics
cookies.** Every cookie below is either strictly necessary to deliver the service you
asked for, or remembers a preference you set yourself.

Under the ePrivacy rules — Article 5(3) of the ePrivacy Directive, as implemented in the
Dutch Telecommunicatiewet — consent is required for storage that is **not** strictly
necessary to provide a service the user explicitly requested. Nothing here falls outside
that exemption, so **there is no consent banner**, and that is a statement about what the
product does rather than a position we are taking.

Our product analytics is **Plausible**, chosen partly because it is cookieless: it sets
no cookie at all and does not identify individual visitors. So analytics adds nothing to
the list below.

**If that ever changes** — if a future feature sets a cookie that is not strictly
necessary — this policy is amended and a consent mechanism ships with it. It would be a
change to the product, not a reinterpretation of this page.

---

## Every cookie the service sets

The list is derived from the application source rather than from memory, and was last
verified on **2026-08-26**.

### Signing in and staying signed in

These are managed by our authentication library. They are strictly necessary: without
them there is no way to know who you are between one request and the next.

| Cookie                          | What it does                                                                                                                                                                                                                             | Class                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| The session cookie              | Identifies your signed-in session. `HttpOnly`, `SameSite=Lax`, and `Secure` in production, so it is not readable by scripts and does not travel cross-site                                                                               | Strictly necessary            |
| The two-factor challenge cookie | Short-lived. Carries you from the password step to the second-factor step of a single sign-in                                                                                                                                            | Strictly necessary (security) |
| `trust_device`                  | Set only if you choose **remember this device** during two-factor sign-in, so you are not challenged again on that browser. It is a signed pointer to a server-side record with its own expiry — revoking the device deletes that record | Strictly necessary (security) |

### Remembering where you are and what you chose

| Cookie         | What it does                                    | Class      |
| -------------- | ----------------------------------------------- | ---------- |
| `workspace_id` | Which workspace you are currently looking at    | Functional |
| `motir.org`    | Which organization you are currently looking at | Functional |
| `NEXT_LOCALE`  | The interface language you selected             | Functional |

### Connecting an external service

Set only when you begin connecting a repository or importing from another tool, and
cleared once that connection completes. Each carries a one-time value that lets us verify
the response really came from the flow you started — a standard protection against
cross-site request forgery. **A workspace that connects nothing never receives any of
them.**

| Cookie                                                                           | Set during                                            |
| -------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `github_oauth_state`                                                             | Connecting GitHub                                     |
| `gitlab_oauth_nonce`                                                             | Connecting GitLab                                     |
| `jira_oauth_state`, `jira_oauth_verifier`                                        | Importing from Jira                                   |
| `linear_import_oauth_state`                                                      | Importing from Linear                                 |
| `plane_import_oauth_state`, `plane_import_oauth_base`, `plane_import_oauth_slug` | Importing from Plane                                  |
| `import_oauth_return`                                                            | Returning you to the page you started the import from |

### One cookie that needs more than a table row

| Cookie               | What it does                                                                                                                                                                                          | Class      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `motir_pending_idea` | Holds the project idea you type on our public landing page — **up to 2000 characters of your own text** — so that it is still there after you create an account and can start your first plan from it | Functional |

**We describe this one separately because it is the only cookie that stores something you
wrote, rather than an identifier or a setting, and because it is set before you have an
account.** If you type an idea on the landing page and never sign up, that text sits in
your own browser and reaches us only if you continue. It is discarded once it has been
used to start your first conversation. If you would rather it were not stored at all,
clear it with your browser's site-data controls, or do not type into that box.

---

## Cookies we do not set

No advertising or retargeting cookies. No cross-site tracking. No social-media pixels.
No third-party analytics cookies — see the Plausible note above. No cookie on this
service is read by any other website.

## Managing cookies

You can delete cookies and block them through your browser's settings. **Blocking the
strictly-necessary ones will sign you out and prevent you from signing back in**, because
they are the mechanism by which being signed in works at all. Blocking the functional
ones is harmless: the interface will simply forget your workspace, organization and
language between visits.

## Changes

We amend this policy when the set of cookies changes, and it carries a version and an
effective date at the top so you can see which version you read.

Questions: **privacy@motir.co**.
