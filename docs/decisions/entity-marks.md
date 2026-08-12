# ADR: Per-entity marks — an uploaded image for a project, nothing for an organization or a workspace, and nothing at all when a project has none

- **Status:** Accepted (2026-08-11, Yue's direction). It **replaces** the 2026-08-10 direction
  recorded on `MOTIR-2588`, which retired the project mark outright and gave no entity a mark
  of any kind.
- **Story / Subtask:** MOTIR-2588 (A project's mark becomes an uploaded image) · Subtask MOTIR-2589
- **Supersedes / superseded by:** supersedes the recorded deviation in `lib/projects/avatar.ts` and
  `design/projects/details.mock.html` — _"NOT an image upload … Jira's own default avatars are a
  preset library, and the 2.3.7 upload primitive is issue-attachment-scoped"_ (Story 6.8 · Subtask
  6.8.1). That deviation is **reversed**; §1 and §4 say why.
- **Consumed by:** MOTIR-2674 (shell design — the mark spec + the `md`–`xl` band), MOTIR-2675
  (projects design — the Details Image row), MOTIR-2676 (`Project.image` + its persistence
  contract), MOTIR-2677 (the upload endpoint), MOTIR-2678 (the settings Image row), MOTIR-2679
  (the shell), MOTIR-2680 (dropping the preset columns + the registry), MOTIR-2681 / MOTIR-2682
  (the story's test subtasks).

> Convention (set by `work-item-type-taxonomy.md`): a decision record is a markdown file under
> `docs/decisions/`, named for the thing it fixes, structured **Status → Context → Decision →
> Consequences**, with the load-bearing facts pinned in explicit tables/lists so downstream code has
> one authoritative source to implement against. No application behaviour ships in this subtask.

---

## Context

### What ships today

A project's mark is a **preset icon key + a colour-swatch key** — `Project.avatarIcon` and
`Project.avatarColor`, both nullable, validated against the 18-icon / 6-colour registry in
`lib/projects/avatar.ts`, written through the admin-gated `projectsService.updateDetails`, chosen in
Project settings → Details via `AvatarPicker`, and rendered by `ProjectAvatar` — which has exactly
four importers: `ProjectSwitcher.tsx`, `SettingsSidebarHeader.tsx`, `AvatarPicker.tsx` and
`ProjectDetailsCard.tsx`. **With no preset set it does not render nothing** — it falls back to the
project key's first two letters on an `--el-avatar-fallback` tile.

An organization's mark is `OrgAvatar`, a 20px `--el-tint-lavender` initial tile defined inside
`app/(authed)/_components/OrgControl.tsx` and rendered in two places: the bar trigger and the
switch-organization list. It has never been a stored field — it is derived from the org's name.

A workspace has **no mark at all**: `WorkspaceSwitcher` renders its name and a chevron.

### The direction

Yue, 2026-08-11: a project's mark becomes an **uploaded image**; when none has been uploaded the
header shows **nothing**; the organization and the workspace carry **no mark** in the header.

### Two things the earlier planning got wrong, corrected here on the record

**1. `/api/v1` never published `avatarIcon` or `avatarColor`.** MOTIR-2588 and the first version of
this card both asserted it did, and built a deprecation-window question on top of it — three costed
options, a recommendation, an instruction to name when the window closes and who closes it, and a
column-drop migration deferred until after it. On `origin/main`, `lib/api/v1/projects/schema.ts`
names those two fields exactly once, inside the block headed _"What is deliberately NOT here, and
why"_:

> _"`avatarIcon` / `avatarColor` — keys into Motir's own preset registry (`lib/projects/avatar.ts`).
> They are meaningless to a client that is not rendering Motir's UI, and publishing them would make
> that registry's key space public API."_

`projectSchema` carries `key`, `name`, `accessLevel` and `archived`. Nothing else. §5 records the
consequence; the mistake itself is MOTIR-2683.

**2. The command palette does not render the project mark.** It was listed among the render sites.
`AppCommandPalette.tsx` imports no avatar component; the command-palette tests name `avatarIcon`
only inside `ProjectDTO` fixtures. The render-site list in Consequences is the corrected one.

### Why this is a decision record and not a commit message

Every comparable tool draws _something_ when no image has been set (§3 has the observations). An
absence is indistinguishable from an oversight, and the reasonable response to an oversight is to
fix it — so without this document someone will re-add a generated monogram in good faith, and be
right to, on the evidence available to them.

---

## Decision

### 1. A project MAY carry an uploaded image

The preset icon-and-colour pair is retired and replaced by an image the team uploads. A project's
mark becomes _theirs_ rather than one of eighteen of ours, which is the thing a project mark is
actually for; and Motir stops maintaining a curated icon vocabulary nothing else in the product
uses.

**On the mirror axis this moves Motir TOWARD the convention, not away from it.** Jira's project
icon has always been _"a default icon or upload your own"_ (§3) — the preset-only registry was the
deviation, recorded as such in `lib/projects/avatar.ts`'s own header, and this reverses it.

### 2. An organization and a workspace carry no mark — EVER, not "none until one is uploaded"

They are containers you navigate _through_, not things a team decorates. The org's derived initial
tile is deleted; the workspace needs no change because it never had one.

**The decisive reason is mechanical rather than aesthetic, and it is worth stating first: there is no
way to give an organization an image.** No upload surface, no column, no route — the archived
`MOTIR-2544` / `MOTIR-2547` / `MOTIR-2549` set that would have built one never merged (verified on
`origin/main`, 2026-08-11: no `Organization.image`, no `AvatarUploadField`, no org upload route, no
org prefix in `lib/blob/referencedUrls.ts`). So **every org mark that has ever rendered was generated
from the name** — a letter on a tinted square, present for every organization, chosen by nobody. That
is precisely the thing §3 rejects, and it is not a fallback for a missing upload: with no upload
feature it is the ONLY state, so the tile is 100% placeholder and 0% identity.

This also fixes the shape of the rule. It is **not** _"show the org's mark when it has one"_ — an
organization cannot have one, so there is no conditional to implement and no empty state to design.
`OrgAvatar` and both of its call sites are deleted outright.

Beyond that, this is the tier where a mark earns least anyway: an organization is a billing and
membership boundary most people belong to exactly one of, and its name is already the first word of
the context path.

### 3. A project with no image renders NOTHING — no monogram, no generated colour, no reserved box

This is the load-bearing clause and the one that departs from both mirrors.

**Rung-1 observations, and where they were made (2026-08-11):**

| product    | what it does when nothing has been uploaded                                                                                                                                                                                                                                      | observed at                                                                                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Jira**   | A project always has an icon. Project settings → Details → **Change icon** → _"Choose from a default icon or upload your own"_, then Save details. Uploads accept JPEG / GIF / PNG; SVG is not supported.                                                                        | Atlassian support docs, [create-edit-and-delete-team-managed-projects](https://support.atlassian.com/jira-software-cloud/docs/create-edit-and-delete-team-managed-projects/) |
| **Linear** | Icons are **assigned automatically**, with generated colour: _"we've gone ahead to assign icons and generate random colors for them"_, and _"If your team name matched a specific keyword, we paired it with the most appropriate icon, otherwise we gave it the default icon."_ | [Linear changelog, 2022-01-20 — _New sidebar & team icons_](https://linear.app/changelog/2022-01-20-linear-preview-new-sidebar-and-team-icons)                               |

So the convention is unanimous: **never show nothing.** Motir departs from it deliberately, and
owes the reason:

- **A generated mark is indistinguishable from a chosen one.** Six projects in a switcher, each with
  a pastel square holding two letters, reads as six deliberate marks. It is six placeholders. The
  visual weight is identical to a real logo's while the information content is zero — the letters
  repeat the name that is already beside them, and the colour is a hash.
- **It costs width where Motir has none.** `MOTIR-2555` measured the shell's context row
  **overflowing by 47px at 320px** with the marks present. A slot that is never empty is a slot
  always paid for.
- **An empty space states the true fact.** Nobody has set one. That is worth communicating, and a
  generated tile actively hides it — which is also why it never gets set: the placeholder looks
  finished.

**The cost, stated rather than buried:** in a long switcher list, a per-row anchor genuinely helps
scanning, and rows without images lose it. That is the trade — accepted because rows keep their
name, and because a team that wants the anchor can upload one.

### 4. Storage composes the shipped avatar path — a second upload mechanism is NOT to be built

`User.image` already solves this problem in this repository, and a project image uses the same
shape rather than a parallel one:

| concern              | mechanism                                                                  |
| -------------------- | -------------------------------------------------------------------------- |
| where the bytes go   | `putPublicAsset` (`lib/blob/uploader.ts`) → the public bucket              |
| what is stored       | the object **KEY**, never a URL — no hosting origin is ever persisted      |
| how it is read       | `storedAssetUrl` composes the absolute URL at the DTO boundary, on read    |
| ownership gate       | a prefix check on the stored ref, `startsWith`, mirroring `isOwnAvatarRef` |
| replacing / removing | `deletePublicAsset`, **after** the transaction commits                     |

Two repos' worth of upload idiom is two sets of limits, two error vocabularies and two places to fix
a bug. The details — the route, the constants, the tests — belong to MOTIR-2676 and MOTIR-2677 and
are not designed here.

### 5. `/api/v1` is untouched, because it never carried these fields

No deprecation channel, no `deprecated: true` flag, no announcement and no window applies, because
§8's stability promise is a promise about **published** fields and these were never published (see
Context). `projectSchema`'s field set does not change anywhere in MOTIR-2588.

**The question this ADR was originally commissioned to answer — _"what does a versioned API do when
a published field stops meaning anything?"_ — is WITHDRAWN, not answered.** It is recorded here
rather than deleted so the next reader does not re-derive it from the same file: a `grep` that
reaches `lib/api/v1/projects/schema.ts` is a hit on a comment explaining an omission, and that reads
exactly like a hit on a publication.

**Dropping the columns therefore needs no window, and is not deferred to one: it is MOTIR-2680,
inside this story**, sequenced after the last reader is gone. `Project.image` is likewise **not**
added to `projectSchema` — publishing a field later is additive and allowed under §8; withdrawing
one is not, and no client has asked.

---

## Rejected alternatives

| alternative                                                                         | why not                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Keep the preset registry and add upload beside it** (Jira's actual shape)         | Two ways to set one thing, one of which nobody would pick once they can use their own logo. The registry's real cost is not its code, it is that every new icon request becomes a product decision about a vocabulary Motir does not otherwise need. |
| **Generate a monogram when no image is set** (Linear's shape, and today's fallback) | §3. This is the clause the whole ADR exists to hold.                                                                                                                                                                                                 |
| **Give the organization an uploaded mark too**                                      | An org is a billing and membership boundary, and its name already opens the context path. Adding a second uploadable mark doubles the surface for the tier that needs it least.                                                                      |
| **Deprecate `avatarIcon` / `avatarColor` in `/api/v1` first**                       | They are not in `/api/v1`. Doing the ceremony anyway would publish a precedent — that internal columns are covered by the public stability promise — that is both false and expensive to unwind.                                                     |
| **Keep the two columns after the picker is gone**                                   | A column nothing writes and nothing reads is not free: it is read, imitated, and eventually re-adopted. MOTIR-2680 removes them with their last reader.                                                                                              |

---

## Consequences

### What has to change, by path

Grouped, so the cards that follow inherit this list rather than re-deriving it:

- **The registry, the renderer, the picker** — `lib/projects/avatar.ts` (deleted),
  `app/(authed)/_components/ProjectAvatar.tsx` (deleted),
  `app/(authed)/settings/project/_components/AvatarPicker.tsx` (deleted),
  `lib/projects/errors.ts` (`InvalidAvatarError`).
- **`ProjectAvatar`'s four importers** — `ProjectSwitcher.tsx`, `SettingsSidebarHeader.tsx`,
  `AvatarPicker.tsx`, `ProjectDetailsCard.tsx`.
- **The org mark** — `OrgControl.tsx` (`OrgAvatar` and both its render sites), plus
  `ShellTierNav.tsx` and `OrgControl`'s `nameFrom` prop, whose `md`–`xl` band is the design problem
  §2 creates (below).
- **The data path** — `prisma/schema.prisma`, `lib/repositories/projectRepository.ts`,
  `lib/services/projectsService.ts`, `lib/dto/projects.ts`, `lib/mappers/projectMappers.ts`,
  `app/api/projects/[key]/route.ts`, `app/(authed)/settings/project/actions.ts` and `page.tsx`.
- **The blob seam (added, not changed)** — `lib/blob/referencedUrls.ts` gains a project-image prefix
  and its own-ref gate beside the avatar pair.
- **The seed** — `scripts/plan-seed/data/story-6.8.ts`.
- **The v1 comment** — `lib/api/v1/projects/schema.ts`'s omission list names two fields that will
  not exist; the bullet is corrected. `projectSchema` itself does not change.
- **The design assets** — `design/shell/` (the context row, the ladder, the brand tile) and
  `design/projects/` (the Details Image row, the switcher panel, the copy table).
- **The tests** — every `ProjectDTO` fixture and shell-markup assertion; `git grep -l "avatarIcon"
tests/` enumerates them.

### The `md`–`xl` band, handed to the design rather than settled here

`ShellTierNav` passes `nameFrom="xl"` to `OrgControl`, so between `md` and `xl` (768–1279px) **the
org tier renders its mark and nothing else** — the name is `hidden xl:inline`. Deleting the tile
under §2 leaves a ghost button holding a chevron. `MOTIR-2555`'s ladder was measured with that tile
present (`org-mark › project` at 259px natural, −7px at 768px), and its brand-tile section chose the
tile's neutral field _because_ `OrgAvatar` was an adjacent lavender square — an argument §2 removes
one of the terms from.

**Both answers are reopened, and MOTIR-2674 settles them with fresh measurements.** This document
does not pick pixels.

### What this does NOT decide

- **The USER avatar is untouched.** `User.image`, the Account › Profile Photo row, `AvatarField` and
  `TriageAvatar` all render a _person_, and a person's face is not a tenant mark. The stance in §2
  and §3 does not generalise to them.
- **The `--el-avatar-*` token ramp stays.** Removing `ProjectAvatar` does not orphan it:
  `TriageAvatar` consumes the six tints and `gitSettingsPrimitives.tsx` + `CodeAccessSettings.tsx`
  consume `--el-avatar-fallback`.
- **No image pipeline.** The file is stored as uploaded behind a MIME + size gate, exactly as an
  avatar is. Cropping and resizing are a separate capability nothing here implies.
