# ADR: The role model — ROLE on the workspace, ACCESS on the project, three org roles, and an automatic Visitor

- **Status:** Proposed (2026-09-25). The SHAPE was settled by the owner (Yue) in the planning
  conversation on 2026-09-24. Three details, Q1–Q3, are recommendations: the approval of this record
  confirms or overturns each one.
- **Work item:** MOTIR-6165 (`type: decision`), the first card of epic MOTIR-6164
- **Amends:** `organization-tier.md` §4, `public-projects.md` (the access levels),
  `member-facing-permissions.md` (project roles as grants), `public-surface-hosts.md` §2 (the `/p/*`
  row). See _What this amends elsewhere_; each edit rides the card that builds it, not this diff.
- **Consumed by:** MOTIR-6167 (the org's three roles) · MOTIR-6168 (roles on the workspace, and the
  migration) · MOTIR-6169 (access on the project) · MOTIR-6170 (the Visitor) · MOTIR-6179 (the rooms'
  tabs and view-only keys) · MOTIR-6171 (motir.co's read pages move into the app) · MOTIR-6166 (the
  surface scan that offers each role only what it can use)
- **Amended:** 2026-09-26 — reading R1 OVERTURNED at the MOTIR-6456 design gate: an org Admin is a
  Manager in every workspace of the org. See _AMENDMENT 1_ at the end.

---

## Context

Today a person's abilities in a project come from four places that combine:

| layer         | on `origin/main` (`fcd51840b`, 2026-09-25)                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| organization  | `OrganizationRole` = `owner \| admin \| member` (`prisma/schema.prisma`, `lib/organizations/roles.ts`) |
| workspace     | `WorkspaceMembership.role`: `MemberRole` = `owner \| admin \| member \| viewer`                        |
| project role  | `ProjectMembership.role` (also `MemberRole`), optionally a custom `ProjectRoleDefinition`              |
| project level | `ProjectAccessLevel` = `open \| limited \| private \| public`                                          |

`lib/permissions/resolve.ts` merges them per project. A workspace `owner`/`admin` holds every
role-gated key on every project (`isWorkspaceManager`, `lib/projects/roles.ts`). Everyone else gets
their project role's set (or the implicit workspace-member set), and the access level then subtracts
from it. The built-in `viewer` holds exactly `project:browse` and `report:view`
(`lib/permissions/builtinRoles.ts`). That is why a Viewer's Approvals room, which needs
`approval:view_any` to show anyone else's records, is always empty.

So an administrator who wants to know what someone can do has to reason across four layers. A team
that wants to give a contractor one project needs a project role system on top of the workspace
one. The permission CATALOG is sound: every operation already names its key. What this record fixes
is **who holds which keys, and where**.

**Research** (official docs, 2026-09-24):

- **Linear is the closest match.** The TEAM is the people group. It holds membership, privacy, the
  team owner, guest scope and the GitHub sync. PROJECTS are finishable, span teams and carry no
  roles.
- **Jira** is the opposite: the space is the permission silo, and Atlassian Teams grant no access.
- **Plane and monday.com** put roles on both levels.
- What users rely on in a work container is confidential work inside a team, and an outsider scoped
  to one body of work. An ACCESS axis on the project covers both without a second role system.

Motir's workspace ≈ a Linear team, and Motir's project ≈ a Linear project.

## Decision — the shape the owner settled

### 1. The organization keeps three roles

- **Owner:** the root user, exactly one per organization. Holds EVERY permission. They can do
  anything to the organization and act with full rights in every workspace and project in it. They
  are the only person who can delete the organization or transfer its ownership.
- **Admin:** creates and removes workspaces, and holds the org settings, **billing included**.
- **Member:** an ordinary user of the organization. They hold no org-level powers. What they can do
  comes entirely from the workspace roles they are given, and they can hold a different role in each
  workspace.

> **Reading R1: please confirm at the gate.** The settled text gives full rights in every workspace
> to the **Owner** alone. It gives the Admin three powers (create and remove workspaces, org
> settings, billing) and nothing inside a workspace. This record reads that literally: **an org
> Admin's abilities inside a workspace come from the workspace role they hold there**, like anyone
> else's. That narrows `organization-tier.md` §4, where org `owner` AND `admin` are both
> admin-equivalent in every workspace. If the Admin should keep that ceiling raise, say so on the
> approval and §4 stands for them.

### 2. ROLE lives on the WORKSPACE

A workspace is a stable group of people, such as the development team or the sales team. The same
group runs many projects over time. Projects are finishable and not bound to a repository, so a new
project can reuse the same repo.

- Each person holds **ONE role per workspace**: **Manager** (every permission for that workspace),
  **Member**, **Viewer**, or a **custom** role.
- One org user can be Manager of the sales workspace and Viewer in the development workspace.

### 3. ACCESS lives on the PROJECT

- A person has the **same role in every project they can enter**, and **different ACCESS per
  project**.
- A contractor is a workspace **Member** with access to ONE project. Inside it they act as a Member,
  and they cannot enter the others.
- **Projects carry no roles.** The project roles `admin` / `member` / `viewer` and the project-level
  custom roles retire as role grants.

### 4. The Visitor

A Visitor is the same combination of role and access:

- **role:** Visitor, holding every VIEW permission and nothing that writes;
- **access:** PUBLIC projects only.

A Visitor sees items, board, tree, every approval record, every plan and every run. What sits under
an epic made private stays hidden (`epic-privacy.md`, unchanged).

**A Visitor is never assigned.** When a project is public, following its link or pressing its Open
button enters it as a Visitor, automatically. A **Viewer** is an assigned workspace role held by a
user of the same organization. A **Visitor** is whoever arrives at a public project from outside.

### 5. The public pages split (settled 2026-09-24)

- **The READ views move into the real application:** items, boards, the tree, the roadmap and item
  pages, plus two things motir.co never showed: the plans and the agents' runs. People seeing Motir
  build itself in the real product is the better marketing.
- **The ACT features stay on motir.co as they are:** follow and subscribe, the changelog, submitting a
  feature request, voting and commenting. motir.co's project page remains the public landing, with
  a door into the live project.

### 6. The rooms: Plans, Approvals and Runs (settled 2026-09-24)

- **The Viewer and Member roles hold every VIEW-ANY key by default** (approvals, plans, runs), so
  these rooms are open to anyone in the workspace. A team that wants a room closed creates a custom
  role WITHOUT that room's view-any key.
- **Each room has two tabs.** **Project** shows everything in the project, behind the room's view-any
  key. **Mine** shows my plans, my approvals or my runs, and only to someone who can ACT in that
  room.
- **A Viewer or a Visitor** holds view-any keys and nothing that acts, so they get the Project tab
  alone.
- Plans and runs gain **view-only keys**, split from authoring. (Today `ai:view_plan` is, despite its
  name, the AUTHOR key: `lib/permissions/catalog.ts` says so at its declaration.)

## The three open details, and the recommendation for each

### Q1: How is project ACCESS expressed? **Recommended: two small settings**

- **On the project**, one of three modes:
  - `Open to the workspace`;
  - `Members only` (the people added to it);
  - `Public` (open to the workspace AND to Visitors).
- **On the person's workspace membership**, an access scope:
  - `Full` enters every project open to the workspace;
  - `Limited` enters ONLY the projects they were added to.
- The contractor is a Member with `Limited` scope, added to one project.
- This replaces today's four levels: `open` → Open to the workspace; `limited` and `private` →
  Members only; `public` → Public.

Rejected:

- every project being explicit-only, which makes every new project a membership chore;
- project roles that can differ from the workspace role, which the owner ruled out.

### Q2: Where do custom roles live? **Recommended: at the WORKSPACE**

- A custom role is authored from a base of Manager, Member or Viewer, and assigned as someone's
  workspace role.
- Today's project-level custom roles migrate: each is re-created at its workspace.
- A person who held different custom roles in different projects gets the NARROWEST one, and the
  migration report names every such person.

### Q3: Does a Visitor need to sign in? **Recommended: NO**

- Anyone, signed out included, who follows a public project's link enters as a Visitor. That is how
  `public` reads work today: `PUBLIC_PROJECT_PERMISSIONS` is granted to every actor, anonymous
  included (`lib/permissions/resolve.ts` layer 1, and `public-projects.md` §5, _READ is anonymous;
  WRITE requires sign-in_).
- Owed with it:
  - read paths scrub person identities to display names (no email);
  - those paths are rate limited per IP;
  - every write door refuses a Visitor on the server.
- Signing in is still how someone follows, subscribes, requests, votes and comments, on motir.co as
  today.
- Rejected: signed-in Visitors only. It is simpler to secure, but it closes the watching to anyone
  without an account, which is the audience the public project exists for.

### Also recorded: migrating today's roles

- The org roles stay as they are.
- Workspace `owner` → Manager, and org Admin where they are not one already. The org's current Owner
  stays Owner.
- Workspace `admin` → Manager, `member` → Member, `viewer` → Viewer, each with `Full` scope.
- A project role that NARROWED someone becomes a `Limited` scope plus access to those projects. A
  project role that was WIDER than their workspace role is dropped. The migration report lists each
  such case.

## Resulting direction

Written on the recommendations. If the approval overturns Q1, Q2, Q3 or reading R1, the rows that
name it change, and the record is revised before it merges.

### Every role

| role                  | where it is held                 | what it can do                                                                                                                         | who grants it                                                         |
| --------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Org Owner**         | the organization, one            | every permission: anything to the org, full rights in every workspace and project; alone deletes the org or transfers ownership        | nobody: the org's creator, changed only by the Owner's transfer       |
| **Org Admin**         | the organization                 | create and remove workspaces; org settings, billing included; inside a workspace, only what their workspace role there gives them (R1) | the Owner or an Admin                                                 |
| **Org Member**        | the organization                 | no org-level power; everything comes from their workspace roles                                                                        | joining the org, or being added to one of its workspaces              |
| **Workspace Manager** | a workspace, one per person      | every permission for that workspace, in every project in it                                                                            | a Manager of that workspace, or the org Owner                         |
| **Workspace Member**  | a workspace, one per person      | the member's set, plus every view-any key (approvals, plans, runs), in each project they can enter                                     | a Manager of that workspace, or the org Owner                         |
| **Workspace Viewer**  | a workspace, one per person      | every view permission, including every view-any key; nothing that writes; in each project they can enter                               | a Manager of that workspace, or the org Owner                         |
| **Workspace custom**  | a workspace, one per person (Q2) | exactly the keys it lists, authored from a Manager, Member or Viewer base, in each project they can enter                              | a Manager of that workspace, or the org Owner                         |
| **Visitor**           | nowhere: never stored            | every view permission on a PUBLIC project, except anything under a private epic; nothing that writes; no sign-in needed (Q3)           | nobody: entering a public project's link or its Open button grants it |

### Project access modes (Q1)

| mode                      | who can enter                                                        | replaces             |
| ------------------------- | -------------------------------------------------------------------- | -------------------- |
| **Open to the workspace** | every workspace member with `Full` scope, and the people added to it | `open`               |
| **Members only**          | only the people added to it                                          | `limited`, `private` |
| **Public**                | as Open to the workspace, plus any Visitor                           | `public`             |

The org Owner and a workspace Manager enter every project in the workspace, whatever its mode.

### Membership scopes (Q1)

| scope       | enters                                                                                |
| ----------- | ------------------------------------------------------------------------------------- |
| **Full**    | every project Open to the workspace (or Public), plus the projects they were added to |
| **Limited** | only the projects they were added to                                                  |

### The public-pages split

| stays on motir.co                                                                                                                              | moves into the application                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| the project landing (with a door into the live project), follow and subscribe, the changelog, submitting a feature request, voting, commenting | items, boards, the tree, the roadmap, item pages, plans, runs |

### The rooms' tabs

| room      | **Project** tab               | **Mine** tab                            |
| --------- | ----------------------------- | --------------------------------------- |
| Plans     | behind the plans view-any key | only to someone who can act in the room |
| Approvals | behind `approval:view_any`    | only to someone who can act in the room |
| Runs      | behind the runs view-any key  | only to someone who can act in the room |

A Viewer or a Visitor sees the Project tab alone.

## What this amends elsewhere

This record decides. It does not edit the records below. Each clause it makes false is named here,
and the edit rides the card that builds the change.

- **`organization-tier.md` §4:** org `admin` as admin-equivalent in every workspace (narrowed by R1),
  and `owner` as the single billing authority (billing now belongs to the Admins too). Edited by
  MOTIR-6167.
- **`member-facing-permissions.md`, and the project roles in `lib/permissions/builtinRoles.ts`:**
  `admin` / `member` / `viewer` stop being PROJECT role grants and become the Manager, Member and
  Viewer WORKSPACE roles. Edited by MOTIR-6168.
- **`public-projects.md`:** the four `ProjectAccessLevel` values become three modes plus a
  membership scope (Q1). Its §5 (READ anonymous, WRITE signed in) stands, and Q3 relies on it.
  Edited by MOTIR-6169.
- **`public-surface-hosts.md` §2:** the `/p/*` row (`motir.co` renders it, from `motir-marketing`)
  and the sentence _"`motir-core` ships no public rendering at all"_ stop being true for the read
  views. How the move is hosted, including against that record's §4 session-cookie reasoning and
  `public-tenant-addresses.md`'s canonical addresses, is MOTIR-6170's and MOTIR-6171's to settle.

## Consequences

- Every later story in epic MOTIR-6164 cites this record for the model and does not restate it.
- The migration in MOTIR-6168 is the one irreversible step in the epic. It rewrites every workspace
  and project membership, and its report is how a person checks it.
- The resolver loses a layer: a person's key set is decided by their workspace role, and the project
  decides only whether they may enter.
- A Viewer's rooms stop being empty, because Viewer now holds the view-any keys by default.
- Public read traffic lands on the application, not on motir.co, so it needs the Q3 scrubbing and
  rate limits.

## What this does NOT decide

- **Which exact keys** each built-in workspace role holds beyond the rules above, and the names of
  the new view-only keys for plans and runs. Those belong to MOTIR-6168 and MOTIR-6179.
- **Who becomes a new workspace's Manager** when an Admin creates it.
- **The migration's mechanics**: batching, the report's format, rollback. Those belong to MOTIR-6168.
- **How the in-app Visitor view is hosted**: its URL, the host, the cookie, and redirects from
  motir.co. Those belong to MOTIR-6170 and MOTIR-6171.
- **The UI** of any role, access or scope control.
- **Platform operator roles** (`support` / `operator` / `superadmin`), which are Motir staff and
  belong to Epic 10 (MOTIR-726).
- **Seats, prices, SSO / SCIM role mapping, and a separate guest role.** A contractor is covered by
  role plus access.

---

## AMENDMENT 1 (2026-09-26) — reading R1 is overturned: an org Admin is a Manager in every workspace

**Source:** the owner, at the design gate of MOTIR-6456 (the workspace roles design, Story
MOTIR-6168), 2026-09-26: _"I think an org admin should always be a manager in the workspace, or just
carry the org admin role to the workspace. Check how other applications do this."_ The first round of
that gate asked how an org Admin who left a workspace, or stepped down in one, would ever get back —
questions reading R1 could only answer with "ask someone else".

**What changes.** Reading R1 (§1) read the settled text literally — an org Admin holds nothing inside
a workspace beyond the workspace role they are given. **That reading is withdrawn.** An org **Admin**,
like the **Owner**, carries the **Manager** role into EVERY workspace of the organization, member or
not, and that role is decided by their ORG role: a workspace Manager cannot narrow it, and it ends
only when the org role does.

- The _Every role_ table's **Org Admin** row reads: _create and remove workspaces; org settings,
  billing included; **a Manager in every workspace of the organization** (this amendment)._ The
  Workspace Manager / Member / Viewer / custom rows' _who grants it_ column gains **an org Admin**
  beside the org Owner, since a Manager of a workspace grants its roles.
- `organization-tier.md` §4, which R1 narrowed, **stands for Admins again**: org `owner` and `admin`
  are Manager-equivalent in every workspace.
- A plain org **Member** is unchanged: everything they hold comes from the workspace roles they are
  given.

**Checked against the mirror products** (rung 1), as the owner asked. Each carries an org-tier admin's
reach into the units beneath it:

- **GitHub:** organization owners have admin access to every repository the organization owns
  ([Roles in an organization](https://docs.github.com/en/organizations/managing-peoples-access-to-your-organization-with-roles/roles-in-an-organization));
- **Atlassian:** the organization admin is the highest admin role and has automatic product access
  ([What are the different types of admin roles?](https://support.atlassian.com/user-management/docs/what-are-the-different-types-of-admin-roles/));
- **Slack Enterprise:** Org Owners and Admins control workspace policies and add people to any
  workspace, hidden ones included
  ([Manage workspace access in an Enterprise organization](https://slack.com/help/articles/115001915507-Manage-workspace-access-on-Enterprise-Grid)).

**Where it is built** (Story MOTIR-6168): the workspace-access resolver (`organizationsService.resolveWorkspaceAccess`),
the project permission gate's reach (`composeOwnerReach` / `readReachRole`), the workspace switcher and
the active-workspace resolution raise an org Admin exactly as they raise the Owner; the role
migration's never-wider check (MOTIR-6461) admits that raise as a decided widening; and the workspace
roles design (MOTIR-6456) draws an org Admin's row as a Manager set by the organization.

**What this does NOT decide:** whether a workspace may opt OUT of its org Admins' reach (no mirror
product offers it, and nothing asks for it), and anything about the org Owner, who is unchanged.
