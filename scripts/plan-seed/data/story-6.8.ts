import type { PlanStory } from '../types';

/**
 * Story 6.8 — Edit project details + change project key (with old-key
 * redirects).
 *
 * Project-admin editing of the project's details — **name, avatar, and the
 * project key** — by growing the **6.5.3 Details landing** (the read-only
 * identity page the 6.5 settings AREA lands on, expanded concurrently on
 * this branch; its card names 6.8 as "the 6.8 seam", and the original
 * 1.3.4 page comment reserved the same: "rename + identifier-change land
 * later") into the editable surface. The load-bearing piece is
 * **changing the key mid-project, Jira-faithfully**: identifiers re-render
 * (PROD-42 → NIF-42, numbers preserved), and the old key keeps working
 * forever via a new `project_key_alias` table.
 *
 * Mirror-product check (decision-ladder rung 1 — VERIFIED against Atlassian
 * sources at plan time, 2026-06-10: the Data Center "Editing a project key"
 * admin doc + the Jira Cloud "Previous project keys" details-page feature):
 *   • **Old keys keep working.** After EXAMPLE→DEMO, links containing
 *     EXAMPLE-100 REDIRECT to the new key; REST calls with the old issue key
 *     still RESOLVE (no redirect — they just work); JQL/filters referencing
 *     the old project key keep working. Link TEXT is not rewritten ("link
 *     aliases will not be updated") — it just resolves.
 *   • **Old keys are reserved.** A new project cannot take a renamed
 *     project's old key; only deleting the project frees its keys. The SAME
 *     project CAN revert to its previous key. Jira Cloud additionally ships
 *     an explicit release: Project settings → Details → "Previous project
 *     keys" → remove, which un-reserves the key (and breaks its old links).
 *   • **Re-index** — Jira starts a background Lucene re-index scoped to the
 *     project's issues. OURS IS STRUCTURALLY CHEAPER: search reads the
 *     denormalized `work_item.identifier` COLUMN directly (no external index),
 *     so the "re-index" IS the in-transaction bulk UPDATE — nothing async.
 *   • **Key format** — Jira's default is ≥2 uppercase letters (configurable).
 *     Ours stays the SHIPPED `normalizeIdentifier` contract: 3–5 uppercase
 *     A–Z/0–9 (rung 2 — the live column constraint outranks the mirror's
 *     default).
 *   • **Details scope (deviations recorded):** Jira's details page also
 *     carries description, category, lead, and default assignee — none of
 *     which exist on the shipped Project model (rung 2), and no shipped
 *     surface renders them; each is a documented extension when a use case
 *     lands (component default-assignees, 5.4, already cover the
 *     default-assignee need). **Avatar shape:** preset icon library + colour
 *     swatch (not image upload) — Jira's own default avatars ARE a preset
 *     library, the 2.3.7 upload primitive is issue-attachment-scoped, and
 *     arbitrary user images as workspace chrome would need crop/moderation
 *     infra; upload is the documented extension. `slug` is a create-time
 *     artifact no URL consumes — rename does NOT regenerate it (recorded).
 *
 * Architecture: a **`project_key_alias`** table (workspaceId, projectId,
 * identifier; unique per workspace; Prisma `@relation` BOTH sides per the
 * FK-drift rule, cascade with the project so deletion frees keys — the
 * mirror rule) + **central alias-aware resolution** in the project-by-key
 * read path, so every consumer (the `/api/projects/[key]` routes, the
 * `/issues/[key]` pages, anything 6.2+ adds) inherits old-key resolution
 * from ONE place. The key change is ONE transaction: FOR-UPDATE lock on the
 * project row (the lock-before-read-derived-update rule), guards, a single
 * bulk `UPDATE work_item SET identifier = ...` (index-maintained, no per-row
 * loop — the finding-#57 at-scale shape), alias insert, project update.
 * 6.2 saved filters are key-change-proof by construction (the FilterAST
 * references project-scoped ids, never key strings).
 *
 * This is the capability the 8.7 rebrand cutover uses — it turns the
 * PROD-vs-NIF question into a reversible setting rather than a migration.
 *
 * ⚠️ Design gate (planning-time). `design/projects/` has NO details-editing /
 * key-change / avatar surface; the 6.5.1 `settings-area.mock.html` draws the
 * Details landing READ-ONLY with an explicit "editing arrives with 6.8"
 * presentation → subtask **6.8.3** is the `type: design` subtask (extending
 * the 6.5.1 asset, so it `dependsOn` 6.5.1 and seeds `'blocked'`); the UI
 * code subtask (6.8.4) carries 6.8.3 + 6.5.3 in `dependsOn` and seeds
 * `'blocked'` (Principle #13).
 *
 * Expanded from its `stubs.ts` entry per `motir plan 6.8`, on the standing
 * `seed/epic-5-plan` branch (Epic-5/6 planning). Matches the canonical style
 * of 5.1–5.6 / 6.1. Cross-epic dependency audit: clean — every dep points at
 * 6.8 siblings, 6.5 (same-epic, backward — 6.5 < 6.8), or shipped substrate
 * (1.3.x, 2.5.x, 6.4 done).
 */
export const story_6_8: PlanStory = {
  id: '6.8',
  title: 'Edit project details + change project key (with old-key redirects)',
  status: 'planned',
  descriptionMd:
    'Project-admin editing of project details — **name, avatar, key** — by growing the ' +
    '**6.5.3 Details landing** (the read-only identity page the 6.5 settings area lands on; ' +
    'its card names this story as the seam) into the editable surface. The load-bearing piece ' +
    'is **changing the project ' +
    'key mid-project, Jira-faithfully** (verified against the Atlassian "Editing a project key" ' +
    'doc + the Jira Cloud "Previous project keys" feature): on PROD → NIF, every issue ' +
    'identifier re-renders with its number preserved (PROD-42 → NIF-42), and **the old key ' +
    'keeps working permanently** — old issue links redirect, API calls on the old key resolve, ' +
    'and the old key stays reserved against other projects.\n\n' +
    '**The alias table + central resolution (the durable shape).** A new `project_key_alias` ' +
    'row records each retired key (workspace-unique; cascades with the project, so deletion ' +
    'frees its keys — the mirror rule). Resolution is alias-aware in ONE place — the ' +
    'project-by-key read path — so every key-addressed surface inherits it: the ' +
    '`/api/projects/[key]` routes resolve old keys and serve (the verified REST behaviour — no ' +
    'redirect), while the `/issues/[key]` pages parse the identifier prefix, resolve the alias, ' +
    'and **308-redirect to the canonical identifier** (the verified link behaviour). Link TEXT ' +
    'is never rewritten (Jira parity: "link aliases will not be updated" — they resolve, not ' +
    'mutate). 6.2 saved filters need nothing: the FilterAST references project-scoped ids, ' +
    'never key strings.\n\n' +
    '**The rename transaction.** One tx: FOR-UPDATE lock on the project row; format guard (the ' +
    "shipped `normalizeIdentifier` contract — 3–5 uppercase A–Z/0–9; rung 2 over Jira's " +
    'configurable ≥2-letters default); collision guard against BOTH live identifiers and OTHER ' +
    "projects' aliases (reclaiming the project's OWN previous key deletes that alias row — the " +
    "verified revert path); a SINGLE bulk `UPDATE work_item SET identifier = <new> || '-' || " +
    'key` (index-maintained, no per-row loop, no revision-row spam — the identifier is derived ' +
    'data; the `key` number never changes); alias insert; project update. Jira runs a ' +
    'background Lucene re-index here; ours is structurally cheaper — search reads the ' +
    'denormalized column, so the bulk UPDATE **is** the re-index, synchronous and atomic. The ' +
    "create-project path's identifier-suffix loop also grows alias-awareness (a new project " +
    'must not take a reserved key).\n\n' +
    '**Details editing.** Name: a plain rename (breadcrumb/switcher update via the existing ' +
    'DTO; `slug` is a create-time artifact no URL consumes — NOT regenerated, recorded). ' +
    '**Avatar:** preset icon library + colour swatch rendered as the project chip in the ' +
    'switcher and details card; null = the shipped mono-identifier rendering (zero-migration ' +
    "backfill). Deviation recorded: no image upload (Jira's defaults are themselves a preset " +
    'library; the 2.3.7 upload primitive is attachment-scoped; upload = documented extension). ' +
    '**Previous keys:** the details card lists the alias history with an explicit ' +
    'release-with-confirm control (the Jira Cloud "Previous project keys" remove — releasing ' +
    'un-reserves the key and breaks its old links, so it gets its own consequence confirm).\n\n' +
    '**Real-product states (finding #57 + the sweep):** admin-gated (the 6.4.3 capability — ' +
    'non-admins see the card read-only); validation, collision (live + alias), and unchanged-key ' +
    'states; an in-flight state while the bulk rewrite commits; success feedback naming the ' +
    'consequence ("old links keep working"); concurrency guards (a rename racing issue creation ' +
    'must never mint a stale-prefix identifier — both orderings asserted against the ' +
    'FOR-UPDATE lock).\n\n' +
    '**Out of scope (documented extension slots, each justified):** project description / ' +
    'category / lead / default-assignee fields (absent from the shipped model, rung 2; ' +
    'component default-assignees (5.4) cover the default-assignee use case); avatar image ' +
    'upload (above); changing the issue-key NUMBERING (Jira reserves numbers too — out ' +
    'entirely); a workspace-level "release on delete" admin view (deletion already cascades ' +
    'the aliases). This story is the capability **8.7 (Prodect → Motir rebrand)** consumes. ' +
    'Relationship to 6.5: the backend (6.8.1/6.8.2) is independent; the UI grows the 6.5.3 ' +
    'Details landing and its design extends the 6.5.1 area asset (backward same-epic deps).',
  verificationRecipeMd:
    '- Pull the Story branch, `pnpm install`, `pnpm prisma migrate dev` (the ' +
    '`project_key_alias` + avatar-columns migration applies cleanly; re-run reports "No ' +
    'difference detected" — the FK-drift rule), `pnpm db:seed`, `pnpm dev`.\n' +
    '- `pnpm test:coverage` — Vitest (real Postgres) over the rename tx (atomicity, lock ' +
    'ordering, collision matrix incl. aliases, reclaim + release) ≥90% per-file ' +
    'branch/fn/line.\n' +
    '- **Details page:** sign in as `zhuyue@motir.co` / `!QAZ1qaz` → Settings → Project — ' +
    'the 6.5 area lands on Details, now editable, matching ' +
    '`design/projects/details.mock.html` panel-for-panel. Rename the project → the ' +
    'breadcrumb + switcher update. Pick an avatar icon + colour → the chip renders on the ' +
    'page and in the project switcher (closed + open states); clearing it restores the ' +
    'shipped mono-identifier rendering.\n' +
    '- **Key change:** Change key PROD → NIF via the consequence modal (copy names the ' +
    'effects: identifiers re-render, old links keep working). After confirm: every issue ' +
    'shows NIF-<n> with its number preserved (board, list, detail, links); the Details ' +
    'card\'s "Previous keys" row lists PROD.\n' +
    '- **Old-key resolution:** an old bookmark `/issues/PROD-7` 308-redirects to ' +
    '`/issues/NIF-7` (assert the permanent redirect + the canonical URL in the bar); ' +
    '`/api/projects/PROD/members` still serves (no redirect — the verified REST shape).\n' +
    '- **Reservation + revert:** creating a new project with identifier PROD fails with the ' +
    'collision error (alias-reserved); changing the key back to PROD reclaims it (NIF ' +
    'becomes the alias). Releasing an alias via its confirm un-reserves it and its old ' +
    'links now 404.\n' +
    '- **Concurrency:** the Vitest race specs pass — a rename concurrent with issue ' +
    'creation yields only canonical-prefix identifiers in both interleavings.\n' +
    '- **Gating:** a `viewer`/`member` (non-admin) sees the card read-only; the PATCH ' +
    'rejects them with the typed 403.\n' +
    '- `pnpm test:e2e --grep project-details` — Playwright over the rename → redirect → ' +
    'revert journey.\n' +
    '- **a11y check:** the Details page, avatar picker, and both confirm modals pass the ' +
    'strict axe sweep; fully keyboard-operable; colour via `--el-*`, shape via element ' +
    'tokens.',
  items: [
    {
      id: '6.8.1',
      title:
        'Schema (project_key_alias + avatar columns) + the details/rename service core (locked atomic key-change tx, alias reservation, release) + admin-gated PATCH',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 33,
      dependsOn: [],
      descriptionMd:
        'The data model and the whole write path — no UI.\n\n' +
        '**Migration:** `project_key_alias` (id, workspaceId, projectId, identifier, ' +
        'createdAt; `@@unique([workspaceId, identifier])`, indexed by projectId) modelled ' +
        'as a Prisma `@relation` on BOTH sides with `onDelete: Cascade` from Project ' +
        '(deletion frees the keys — the verified mirror rule; the FK-drift rule applies). ' +
        '`Project.avatarIcon` + `Project.avatarColor` (nullable Strings — null = the ' +
        'shipped mono-identifier rendering, so existing rows need no backfill).\n\n' +
        '**Service (`projectsService`):** `updateDetails` — name (trimmed, non-empty; ' +
        '`slug` NOT regenerated — recorded decision) + avatar (icon key validated against ' +
        'the preset registry; colour against the swatch set). `changeKey` — ONE ' +
        '`$transaction`: FOR-UPDATE lock on the project row (the ' +
        'lock-before-read-derived-update rule); `normalizeIdentifier` format guard (3–5 ' +
        'uppercase A–Z/0–9 — rung 2); no-op guard (new == current → typed error); ' +
        "collision guard against live identifiers AND other projects' aliases " +
        '(workspace-scoped); reclaiming the OWN previous key deletes that alias row; a ' +
        "SINGLE bulk `UPDATE work_item SET identifier = <new> || '-' || key WHERE " +
        '\"projectId\" = …` via a repository `$queryRaw` method (one statement, ' +
        'index-maintained, NO per-row loop and NO revision rows — identifier is derived ' +
        'data, the `key` number is untouched); insert the alias for the old key; update ' +
        '`project.identifier`. `releaseAlias` — admin-gated delete of one alias row (the ' +
        'Jira Cloud "Previous project keys" remove). **Create-path guard:** the ' +
        'create-project identifier suffix loop ALSO checks the alias table inside its tx ' +
        '(a new project must not take a reserved key).\n\n' +
        '**Route:** PATCH `/api/projects/[key]` accepting `{ name?, avatarIcon?, ' +
        'avatarColor?, identifier? }` + DELETE `/api/projects/[key]/aliases/[alias]`, both ' +
        'project-admin-gated (the 6.4.3 capability, the `/api/projects/[key]/access` PATCH ' +
        'pattern); typed errors → 400/403/409. DTO growth: `avatarIcon`/`avatarColor` + ' +
        '`previousKeys` on the project DTO (the details card + switcher consumers).\n\n' +
        '## Acceptance criteria\n\n' +
        '- Migration applies cleanly; re-run reports "No difference detected" (no FK ' +
        'drift); existing rows read back with null avatar.\n' +
        '- `changeKey` is atomic: after PROD→NIF on the large seed, EVERY work_item ' +
        'identifier is NIF-<key> with numbers preserved, the alias row exists, and a ' +
        'mid-tx failure (fault-injected) leaves NO partial state. The rewrite is one SQL ' +
        'statement (asserted via query log), bounded on the 10k-issue seed.\n' +
        '- Collision matrix: live identifier of another project → 409; alias of another ' +
        'project → 409; own alias → reclaim (alias row swapped); format violations → 400; ' +
        'unchanged key → typed no-op error. Create-project can no longer mint a reserved ' +
        'key (suffix loop skips aliases).\n' +
        '- Concurrency: a rename racing `allocateWorkItemNumber`-backed issue creation ' +
        'never produces a stale-prefix identifier (both interleavings asserted against ' +
        'the FOR-UPDATE lock).\n' +
        '- Non-admin PATCH/DELETE → typed 403; `releaseAlias` deletes exactly one row; ' +
        '`pnpm test:coverage` ≥90% on the touched files.\n\n' +
        '## Context refs\n\n' +
        '- `lib/services/projectsService.ts` (`normalizeIdentifier`, the create suffix ' +
        'loop, `allocateWorkItemNumber`) + `lib/repositories/projectRepository.ts` ' +
        '(`findByIdentifier`)\n' +
        '- `prisma/schema.prisma` — `Project` (`@@unique([workspaceId, identifier])`), ' +
        '`WorkItem.identifier` (denormalized "PROD-42", `@@unique([projectId, ' +
        'identifier])`)\n' +
        '- The 6.4.3 project-admin gate + the `/api/projects/[key]/access` route pattern\n' +
        '- `motir-core/CLAUDE.md` (4-layer, required-tx, FK-as-@relation); the ' +
        'lock-before-read-derived-update rule; the verified mirror behaviour in the ' +
        'Story 6.8 description',
    },
    {
      id: '6.8.2',
      title:
        'Alias-aware resolution everywhere the key is addressed — central project-by-key fallback, /issues/[key] 308 redirects, API old-key serving',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 25,
      dependsOn: ['6.8.1'],
      descriptionMd:
        'The read half: every key-addressed surface resolves old keys, from ONE central ' +
        'path.\n\n' +
        '**Central resolution:** `projectsService.resolveByKey` — live identifier first, ' +
        'then the alias table; returns the project + a `viaAlias` flag (callers decide ' +
        'serve-vs-redirect). The `/api/projects/[key]` route family switches to it and ' +
        '**serves** on an alias hit (the verified REST behaviour — REST calls on the old ' +
        'key just work; the response DTO carries the canonical identifier).\n\n' +
        '**Issue pages:** `/issues/[key]` + `/issues/[key]/edit` — on a lookup miss, ' +
        'parse the identifier prefix (split on the first hyphen; keys are 3–5 alnum, ' +
        'never hyphenated), resolve via alias, recompose the canonical identifier, and ' +
        '**`redirect()` with 308** to the canonical URL (the verified link behaviour: ' +
        'old links redirect, their text is never rewritten). Neither live nor alias → ' +
        'the existing 404. Active-project pinning is id-based and unaffected (note + ' +
        'assert).\n\n' +
        '## Acceptance criteria\n\n' +
        '- After PROD→NIF: `/issues/PROD-7` and `/issues/PROD-7/edit` 308-redirect to ' +
        'their NIF-7 canonicals; an identifier that was NEVER live 404s; a RELEASED ' +
        "alias's URLs 404 (release breaks old links — the mirror rule).\n" +
        '- Every `/api/projects/PROD/...` route serves identically to its NIF twin ' +
        '(spot-assert access, members, estimation-config), with the canonical key in ' +
        'the DTO.\n' +
        '- Resolution is alias-aware in exactly ONE service path (no per-route alias ' +
        'queries — asserted by review + a unit test on `resolveByKey`); chained renames ' +
        'PROD→NIF→ZAP resolve BOTH old keys flat (no chain-walking: each alias row maps ' +
        'directly to the project).\n' +
        '- Integration tests over the redirect/serve/404 matrix; coverage ≥90%.\n\n' +
        '## Context refs\n\n' +
        '- 6.8.1 (the alias table + `resolveByKey` substrate)\n' +
        '- `app/(authed)/issues/[key]/page.tsx` + `edit/page.tsx` (the lookup-miss ' +
        'seam); `lib/projects/index.ts` (`getActiveProject` — id-pinned, unaffected)\n' +
        '- The `/api/projects/[key]` route family (access / members / ' +
        'estimation-config)\n' +
        '- The verified Jira redirect-vs-serve split in the Story 6.8 description',
    },
    {
      id: '6.8.3',
      title:
        'Design — the editable Details page (`design/projects/details.mock.html`: name, avatar picker, key change + consequence modal, previous keys, gated states)',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 35,
      dependsOn: ['6.5.1'],
      descriptionMd:
        'The design asset for the editable details surface. The 6.5.1 ' +
        '`settings-area.mock.html` draws the Details landing READ-ONLY with the ' +
        '"editing arrives with 6.8" presentation — the editing states, avatar picker, ' +
        'key-change flow, and previous-keys row are undesigned (the design-gate ' +
        'NONE-exists case). Output: **`design/projects/details.mock.html`** + PNG + a ' +
        'design-notes section, EXTENDING the 6.5.1 asset (same area chrome — reference ' +
        'it, do not redraw it). Render checklist + AA + dark parity. Mirrors: the Jira ' +
        'Cloud project-details page (name / key / avatar / previous-keys vocabulary); ' +
        'the shipped archive-confirm grammar for consequence modals.\n\n' +
        '**Specify, panel by panel:**\n\n' +
        '- **The editable Details page** — the 6.5.1 identity rows grown editable: ' +
        'name `Input`, the key as a `font-mono` read-only value + "Change key" ' +
        'affordance (the key is NOT a free-typing input — changing it is a guarded ' +
        'flow, the mirror shape), the avatar control, Save state (dirty/saving/saved); ' +
        'the re-homed Archive danger zone stays exactly as 6.5.1 drew it.\n' +
        '- **The avatar picker** — preset icon library + colour swatches (`Popover` ' +
        'vocabulary), live preview chip, "None" restoring the shipped mono-identifier ' +
        'rendering; the chip as rendered in the PROJECT SWITCHER (closed + open ' +
        'states — redraw the 1.3.3 switcher frames with the chip).\n' +
        '- **The change-key modal** — new-key input with live format validation ' +
        '(3–5 A–Z/0–9) + collision error states (live key vs reserved alias get ' +
        'distinct copy); the consequence copy verbatim ("Every issue identifier ' +
        'becomes NIF-<n>. Old links keep working."); the in-flight state while the ' +
        'rewrite commits; the success toast.\n' +
        '- **Previous keys** — the alias list row inside the card (key + since-date), ' +
        'each with a release control → its OWN consequence confirm ("Releasing PROD ' +
        'frees it for other projects and breaks old PROD links."), the verified Jira ' +
        'Cloud shape.\n' +
        '- **Gated + empty states** — the non-admin read-only rendering (values ' +
        'visible, controls absent — the 6.4.6 gating grammar); zero-aliases (row ' +
        'hidden).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The mockup + PNG + notes exist, composed from shipped primitives (`Card`, ' +
        '`Input`, `Modal`, `Popover`, `Button`, the settings-card grammar) + token ' +
        'tiers; render checklist + AA + dark parity pass.\n' +
        '- Panels cover: the card (dirty/saving/saved), the avatar picker + switcher ' +
        'render, the change-key modal (validation, both collision states, in-flight, ' +
        'success), previous-keys + release confirm, and the non-admin read-only ' +
        'state.\n' +
        '- `design-notes.md` names the preset icon/colour registry (the 6.8.1 ' +
        'validation contract), the consequence copy strings verbatim, and records the ' +
        'no-upload avatar deviation + the read-only-key decision.\n' +
        '- No improvised primitive; token needs recorded.\n\n' +
        '## Context refs\n\n' +
        '- `design/projects/settings-area.mock.html` + notes (6.5.1) — the area chrome ' +
        'and the read-only Details landing this makes editable\n' +
        '- `design/projects/` (create-modal / switcher / archive-confirm frames) + ' +
        '`design/projects/design-notes.md`; the 6.4.5 access-members surface (the ' +
        'gated-state grammar)\n' +
        '- The verified Jira details-page + previous-keys shape in the Story 6.8 ' +
        'description\n' +
        '- Findings #35/#54; the design-mockup render checklist',
    },
    {
      id: '6.8.4',
      title:
        'Editable Details page — name/avatar editing on the 6.5.3 landing, the change-key flow, previous keys + release, switcher chip, admin gating',
      status: 'in_progress',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 32,
      dependsOn: ['6.8.1', '6.8.3', '6.5.3'],
      descriptionMd:
        'The surface, per the 6.8.3 design, on the 6.8.1 service — growing the 6.5.3 ' +
        'read-only Details landing into the editable page (the seam its card ' +
        'reserves).\n\n' +
        '**Build** (server component + client islands; mutations via the existing ' +
        'Server-Action convention in `_project-actions.ts`): name editing with ' +
        'dirty/saving/saved states; the ' +
        'avatar picker (preset registry from 6.8.1, live preview, None) and the chip ' +
        'rendered in the **project switcher** (closed + open — extending the 1.3.4 ' +
        'switcher, null falls back to the shipped mono-identifier rendering); the ' +
        'read-only key + "Change key" modal flow (live format validation, the two ' +
        'collision error states, consequence copy, in-flight while the tx commits, ' +
        'success toast, then the UI reflects the new identifiers without a manual ' +
        'reload); the Previous-keys rows + release-with-confirm. **Gating:** ' +
        'non-admins get the designed read-only rendering (the 6.4.6 grammar); all ' +
        'strings via next-intl (the threading pattern).\n\n' +
        '**A11y:** the page sections are labelled regions; the picker and both modals ' +
        'keyboard-complete; validation errors announced; extends the settings strict ' +
        'sweep.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The page matches the design panel-for-panel (edit states, picker, modal ' +
        'states, previous-keys, read-only); the switcher renders the avatar chip in ' +
        'both states and falls back correctly on null.\n' +
        '- The full key-change journey works end-to-end in the browser: validate → ' +
        'collision copy per cause → confirm → in-flight → success → every visible ' +
        'identifier re-rendered; reclaim-own-key and release flows work with their ' +
        'confirms.\n' +
        '- Non-admin sees read-only (and the actions reject server-side — asserted, ' +
        'not just hidden); axe-clean; token tiers only (`--el-*`, element shape ' +
        'tokens); next-intl threaded.\n' +
        '- Integration tests over the card states + action wiring; coverage ≥90%.\n\n' +
        '## Context refs\n\n' +
        '- `design/projects/details.mock.html` + notes (6.8.3) — THE authority\n' +
        '- 6.8.1 (service/DTO contract); 6.5.3 (the read-only Details landing this ' +
        'grows) + 6.5.2 (the area chrome it renders inside); `_project-actions.ts` ' +
        '(the Server-Action convention)\n' +
        '- `app/(authed)/_components/ProjectSwitcher.tsx` (the chip surface)\n' +
        '- The i18n threading pattern; the 6.4.6 gating grammar',
    },
    {
      id: '6.8.5',
      title:
        'Story tests — rename-tx matrix (atomicity, collisions, races, reclaim/release) + redirect/serve matrix + the rename E2E journey + a11y sweep',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['6.8.2', '6.8.4'],
      descriptionMd:
        'The story-closing verification (Principle #18; the epic-wide journey stays ' +
        'Story 6.7 — do not duplicate).\n\n' +
        '**Vitest (integration, real Postgres):** the **rename matrix** — atomic ' +
        'rewrite over the large seed (every identifier canonical, numbers preserved, ' +
        'one-statement assert via query log, fault-injected rollback leaves zero ' +
        'partial state); the **collision matrix** (live / other-alias / own-alias ' +
        'reclaim / format / no-op / create-path reservation); **race specs** (rename ' +
        '∥ issue-create in both interleavings → only canonical-prefix identifiers; ' +
        'rename ∥ rename → one wins, one gets the typed conflict); the ' +
        '**resolution matrix** (live / alias-serve / alias-redirect / released-404 / ' +
        'never-existed-404 / chained renames flat-resolve); release semantics ' +
        '(un-reserved + links broken).\n\n' +
        '**Playwright E2E (`tests/e2e/project-details.spec.ts`):** the recipe journey ' +
        '— edit name + avatar (switcher chip updates), change PROD→NIF through the ' +
        'modal (consequence copy asserted), old `/issues/PROD-<n>` URL lands on ' +
        'NIF-<n> with the canonical URL in the bar, previous-keys shows PROD, revert ' +
        'to PROD reclaims, non-admin sees read-only. **a11y:** the strict axe sweep ' +
        'over the Details page, the open picker, and both confirm modals.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Every matrix above is covered and green; the race specs actually ' +
        'interleave (no sequential fakes — the shared-PG harness conventions).\n' +
        "- The E2E journey passes green in CI's Playwright lane; the sweep reports " +
        'zero violations.\n' +
        '- The Story 6.8 verification recipe runs clean top to bottom; ' +
        '`pnpm test:coverage` keeps all 6.8 files ≥90%.\n\n' +
        '## Context refs\n\n' +
        '- The Story 6.8 verification recipe — the checklist this automates\n' +
        "- 6.8.1/6.8.2 (the matrices' contracts); 6.8.4 (the surface under test)\n" +
        '- `tests/integration/` + `tests/e2e/` conventions; the harness/selector ' +
        'memories; the motir-core coverage gate\n' +
        '- Story 6.7 (the epic-wide remainder — do not duplicate)',
    },
  ],
};
