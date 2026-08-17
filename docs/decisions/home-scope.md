# `/home` scope — the no-project state, the post-auth landing, and cross-project "my work"

**Status:** accepted · **Date:** 2026-08-17 · **Card:** MOTIR-2904 (Epic 8, Launch
readiness) · **Unblocks:** MOTIR-2761 · **Files:** MOTIR-2920, MOTIR-2921

## Context

MOTIR-2649 shipped `/home` as the signed-in landing surface: two tabs (My work,
Watching) over a **workspace-scoped** read — every project in the workspace the actor
may browse. MOTIR-2654 then pointed the post-auth `callbackURL` at it and gave it the
first row of the primary rail, above Dashboard.

MOTIR-2761 is the defect that follows: the rail's primary section is built **inside
`if (hasProject)`** (`app/(authed)/_components/SidebarNav.tsx:218`) and the top bar
renders a project switcher on every authed page, so the shell places `/home` firmly in
the **project** tier — above a page that resolves no project and that a project switch
therefore cannot change. The fix is to narrow `/home` to the active project.

Narrowing it has three consequences the shipped code depends on, and MOTIR-2761 marked
all three as open decisions while keeping an acceptance criterion that depended on
one. That criterion was un-evaluable by anyone who claimed the card (MOTIR-2905 is the
planning-bug record). This document is the missing half; MOTIR-2761's criterion is
rewritten against it.

The three dependencies, verified on `origin/main` @ `64fb9e6e`:

| #   | what depends on workspace scope                                                          | evidence                                                                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | a **second, duplicate Home row** rendered only in the no-project state                   | `SidebarNav.tsx:347-365` — _"Home is workspace-scoped: it works with no project … signing in lands here, so a reader in this state would otherwise have no nav row back to the page they arrived on"_ |
| 2   | `/home` renders **no no-project state at all** — only the My-work / Watching tab empties | `app/(authed)/home/page.tsx:46` calls `getWorkspaceContext()`, never `getActiveProject()`                                                                                                             |
| 3   | `/home` is the **post-auth landing** for an actor who may have no project                | `app/(auth)/sign-in/page.tsx:78` — `searchParams.get('next') ?? (draftId ? ONBOARDING_ENTRY_PATH : '/home')`                                                                                          |

And one more, which is a subtraction rather than a dependency: `/home` is the only
surface in the product that answers _"what is on me across this whole workspace"_.

## Decision

### 1. The frame — "no active project" means the actor can see ZERO projects

This is load-bearing for everything below, and it is not obvious from the name.
`getActiveProject()` (`lib/projects/index.ts:56`) delegates to
`projectsService.getActiveProject` (`lib/services/projectsService.ts:716`), which:

1. resolves the member's pinned `activeProjectId` — accepting it **even if archived**;
2. failing that, recovers to `projectRepository.findByWorkspace(...)[0]` and persists
   the pointer;
3. returns `null` only when that list is **empty**.

The list is read inside `withWorkspaceContext`, so RLS bounds it to what the actor may
see. So `null` does **not** mean _"you have not picked a project yet"_ — the resolver
never leaves an actor unpicked while a visible project exists. It means **there is no
project for this actor in this workspace**: a fresh workspace, or a member with access
to none.

That collapses two states people reason about separately into one, and it is why the
answer to §2.2 is a _create-first_ screen rather than a _pick-a-project_ screen. There
is nothing to pick.

### 2. The no-project state and the post-auth landing

#### 2.1 The `!hasProject` Home nav row is REMOVED

`SidebarNav.tsx:353-365` — the second, duplicate Home row — goes. Every other primary
entry is already correctly absent in that state; Home joins them, and the no-project
rail keeps only its bottom section (workspace settings, Job runs).

The row's own comment is the argument for removing it: it justifies itself by _"Home is
workspace-scoped: it works with no project"_, which is precisely the property being
removed. Once `/home` needs a project, a nav row offering it to a reader who has none
is a row that promises a room the product cannot open.

MOTIR-2762 already recorded the general form of this: _treat a special case invented to
make a new surface fit its slot as a signal about the slot, not a detail of the card._
The duplicate row **was** that special case. Fixing the mismatch removes its reason to
exist; keeping it would preserve the tell after curing the disease.

Consequence for MOTIR-2761: `tests/components/SidebarNav-home-door.test.tsx:73`
(_"is STILL OFFERED with no active project"_) is **inverted, not deleted** — the
no-project render must assert the row is **absent**, alongside the existing `Boards`
absence.

#### 2.2 `/home` with no active project renders the shipped create-first door

`app/(authed)/home/page.tsx` resolves `getActiveProject()` and, on `null`, renders
**`ProjectsEmptyState`** (`app/(authed)/_components/ProjectsEmptyState.tsx`) — the same
component `/dashboard` already renders in this exact state
(`app/(authed)/dashboard/page.tsx:34-41`).

Not a new component, and not new copy: `ProjectsEmptyState` already offers both doors
(MOTIR-1485 / 1486) — the accent **Plan with AI** door when `isMotirAiConfigured()`,
and **Create project**, which opens the shipped `CreateProjectModal`. It already carries
`shell.project.createFirst` / `emptyDescription` in both catalogues. So `/home` gains
its no-project state with no new surface and no new keys.

**Why not the `/ready` pattern, which MOTIR-2904 named as the leading candidate.**
`app/(authed)/ready/page.tsx:36-45` renders a bare
`EmptyState title={t('noProjectTitle')}` with **no action**, and `/items` and `/boards`
follow it. That is a fine convention for a surface a reader **navigated to** — they
came from somewhere and can go back. It is the wrong answer for a surface a reader is
**landed on**, and MOTIR-2904 set that bar explicitly: _landing on an empty state with
no onward action is not an acceptable answer._ After §2.1 there is no nav row to
`/home` in this state at all, so `/home` is now **only ever landed on** — by the
post-auth redirect, a bookmark, or a `?next=`. The actionable door is the one that
fits.

So the product has two shipped conventions for `getActiveProject() === null`, and the
discriminator between them is now written down: **a route a reader is LANDED on gets
the create-first door; a route a reader NAVIGATED to gets the in-place notice.**
`/ready`, `/items` and `/boards` are unchanged.

#### 2.3 Post-auth still lands on `/home`, unconditionally

`app/(auth)/sign-in/page.tsx:78` is **not** changed. The default stays `/home`, `?next=`
still wins, and the `draftId → /onboarding` branch is untouched.

The alternative — branching the landing on whether the actor has a project — is
rejected on two grounds. It would put a project-existence read into a public,
pre-session surface that has no context to do it with; and it would make the auth pages
the only callers in the app that pre-compute a destination's own context. Every route in
Motir resolves what it needs and renders its own empty state. With §2.2 decided, `/home`
in the no-project state **is** the create-first door, so there is nothing left for a
branch to accomplish.

**But sign-UP was never moved, and that is a real defect — filed as MOTIR-2921.**
`app/(auth)/sign-up/page.tsx:71` still defaults to `/dashboard` while sign-in defaults
to `/home`; MOTIR-2654 moved one of the two credential flows. Sign-up is the flow the
brand-new actor takes, so the actor this section is about is the one still on the old
route. Two shipped comments assert the pre-2654 world as fact — `dashboard/page.tsx:18-24`
(_"`/dashboard` is where both credential flows land"_, the MOTIR-2645 E2E settle
contract) and `home/page.tsx:84-86`. MOTIR-2921 is `blocked_by` MOTIR-2761, because
moving sign-up to a `/home` that is still workspace-scoped would regress the project-less
first screen relative to today's `/dashboard`.

### 3. Cross-project "my work" is RETAINED — at the workspace tier, as MOTIR-2920

The capability MOTIR-2761 removes is genuinely unreplaced, and the check was made rather
than assumed:

- `/items`, `/ready`, `/boards` and `/backlog` are all project-scoped, and saved filters
  are project-contained.
- The notification bell **is** workspace-wide and personal — and it answers _"what
  CHANGED that involves me"_, not _"what is ON me"_. A quiet item never enters it. (This
  is the same distinction that retired the "Needs you" widget as a duplicate of the bell;
  `home/page.tsx:30-36`.)

So after the narrowing, nothing answers the question. The decision is **retain**, and per
MOTIR-2904 the retention is a **card, not a sentence** — MOTIR-2920, an unexpanded story
under Epic 8: a workspace-tier surface at **`/my-work`**, carrying the
`assignee = me OR reporter = me` read plus Watching across every browsable project, i.e.
the read `homeService` performs today, relocated to a tier that matches its scope.

**The tier is the decision, not the route.** MOTIR-2762 recorded that MOTIR-2649 imported
the _scope_ of Jira "Your work" / Linear Inbox / Plane Home without importing their
_placement_ — in all three the cross-project surface sits **above** the project selector.
The lesson there is not "cross-project personal surfaces are wrong"; it is "a
cross-project surface belongs above the project selector." Retaining the capability at
the workspace tier is that precedent imported correctly. Dropping it outright would
over-learn the lesson and discard a good idea because of where it had been put.
`/my-work` is the route MOTIR-2920 starts from; its design pass may revise the path, but
not the tier.

**Explicitly NOT decided here:** when MOTIR-2920 is built. It is unexpanded and carries
no sprint. Retaining a capability is not scheduling it — but it now has a key, an owner
and a `blocked_by` edge to MOTIR-2761, which is what makes it a plan rather than a
promise (`notes.html` #168, #171).

### 4. What this record does not decide

- **Who may create a project.** §2.2 shows the create-first door to any actor with no
  visible project, exactly as `/dashboard` already does. Whether every workspace role
  should see a create door is a pre-existing question about `ProjectsEmptyState`, not one
  this narrowing opens.
- **`/dashboard`'s own future.** It keeps its route, its rail row and its projects-empty
  branch. That `/home` and `/dashboard` render the same screen in the zero-project state
  is correct: they are the two post-auth landings, and in that state they have the same
  job.
- **The `/ready` / `/items` / `/boards` no-project states.** Unchanged; §2.2's
  discriminator explains why they stay actionless rather than proposing they change.

## Consequences

- **MOTIR-2761 becomes runnable.** Its criterion 6 no longer defers to this record; it
  names the three outcomes (§2.1, §2.2, §2.3) and is evaluable by whoever claims the card.
- **MOTIR-2761 gains a UI change it did not have**: `SidebarNav.tsx:353-365` deleted, and
  `home/page.tsx` given a `getActiveProject() === null` branch rendering
  `ProjectsEmptyState`. `tests/components/SidebarNav-home-door.test.tsx:73` inverts. No new
  message keys in either catalogue — the reused component brings its own.
- **`/home` becomes reachable only with a project**, by nav. It stays reachable by URL in
  every state, and renders coherently there; nothing redirects.
- **Two cards carry the rest**: MOTIR-2920 (retain cross-project "my work" at the
  workspace tier) and MOTIR-2921 (align sign-up's post-auth default and correct the stale
  landing comments). Both are `blocked_by` MOTIR-2761.
- **A discriminator is now on file** for the two shipped `noProject` conventions
  (§2.2), so the next surface added to the app has an answer instead of a coin flip.
