import type { PlanStory } from '../types';

/**
 * Story 6.13 (Epic 6) — The Project Square (a SYSTEM-level public-project
 * directory). The cross-org DISCOVERY surface for every project made `public`
 * in 6.12: a FULLY PUBLIC (no sign-in) web page anyone can browse, search,
 * filter by category/tag, and rank (trending / popular / recent-new), then
 * click through to a project's public read-only view (6.12.4). Yue: "a 'project
 * square' where all the public projects are showing on the Motir SYSTEM level."
 *
 * **⚠️ MODEL REVISION (Yue, 2026-06-14).** The square is **FULLY PUBLIC — NO
 * AUTH** (open to anyone, logged-out included; NOT account-required), it is
 * **NOT in the app left-nav / not an app-shell route** (it is a standalone web
 * page reached from the Motir MARKETING SITE — motir.co/explore, wired later),
 * the redundant per-card **"Public" pill is dropped** (every project on the page
 * is public by definition), and the page is **SEO + GEO OPTIMISED** (server-
 * rendered + crawlable: a real <h1> + descriptive lede, semantic HTML, JSON-LD
 * structured data, head meta / OpenGraph / canonical, an XML sitemap of real
 * URLs — each rank / search / topic / page its own indexable URL + per-topic
 * landing pages — and a GEO answer-engine framing). This SUPERSEDES the earlier
 * "account-required (not anonymous)" + "shell entry" framing throughout this
 * story. (Knock-on flagged: 6.12.4's public view, which a card links into, is
 * still account-required under the 6.12 model — that decision likely needs the
 * same anonymous revision; tracked as a finding for the 6.12 re-plan, NOT
 * resolved here.)
 *
 * **Where this sits relative to 6.12 (the story it builds ON).** 6.12 made a
 * single project openable — `public` as the 4th `ProjectAccessLevel` (6.12.3),
 * the per-project public read-only VIEW (6.12.4), the public roadmap (6.12.7),
 * and the upvote / activity demand signals (6.12.6). But 6.12 is PER-PROJECT:
 * you reach a public project only if you already hold its share-link. 6.13 is
 * the missing DISCOVERY half — the system-level place where ALL public projects
 * across EVERY org/workspace surface together so anyone (no sign-in) can FIND
 * them without a link. It is the open-source-gallery layer on top of 6.12's
 * open-project layer. It adds NO new write and NO new cross-org grant: it lists
 * ONLY projects whose access level is already `public` (the single cross-org
 * READ exception 6.12.3 fixed), and every card click lands on the 6.12.4 public
 * view that already enforces the public projection.
 *
 * **The verified mirror (rung 1 — public-project / open-source discovery
 * galleries; checked 2026-06-12, cited not asserted).** Every proven explore
 * surface ships the SAME shape — a card gallery + search + category/tag filters
 * + rank/sort tabs + pagination — so that set is in scope (adopt, not
 * gold-plate):
 *   - **GitHub Trending** (https://github.com/trending) computes trending in
 *     three TIME BUCKETS (daily / weekly / monthly, a dropdown) over a weighted
 *     blend of stars/forks/commits/follows/pageviews, filterable by language;
 *     each trending row shows owner/repo, primary language, description, the
 *     star button, and the top contributors — i.e. project cards with stats +
 *     a recency-windowed rank. **GitHub Explore** (https://github.com/explore)
 *     is the curated-browse half: **Topics** ("explore repositories in a
 *     subject area") and **Collections** (hand-picked themed sets) — the
 *     category/tag browse axis.
 *   - **GitLab Explore Projects** (https://gitlab.com/explore/projects/trending)
 *     ships the rank as TABS — **Trending / Most-starred / All** — with a sort
 *     component (Name / Created / Updated / Stars) and first-pass filters
 *     (Language, Role) + a NAME SEARCH, plus an **Explore Topics** tab that
 *     "shows topics sorted by the number of associated projects", each topic
 *     page itself name-searchable + sortable (the category browse + per-category
 *     listing). (https://docs.gitlab.com/user/project/project_topics/)
 *   - **OpenProject project lists** (https://www.openproject.org/docs/user-guide/projects/project-lists/,
 *     community.openproject.org/projects) — the filterable/sortable public
 *     project directory; its Community instance shows "all work packages in
 *     public projects" to anyone, and project lists are favoritable/shareable
 *     (14.3). **Plane** (https://plane.so/open-source) + the 6.12 portals
 *     (Canny/Productboard) are the public-roadmap/feedback-portal directories
 *     the click-through lands in.
 * Motir's adopted shape: **project cards** (name, org, description, viewer /
 * upvote / activity stats) + **search** + **category/tag filters** +
 * **sort/rank tabs (trending / popular / recent-new)**, paginated at scale.
 *
 * **The rank model (computed from 6.12.6 signals, deterministic + paginatable
 * — finding #57).** Three ranks, the GitHub-Trending / GitLab-Explore-tabs set:
 *   - **Trending** — recent demand: upvotes + project activity inside a RECENCY
 *     WINDOW (the GitHub daily/weekly/monthly bucket), so a freshly-surging
 *     project rises and a stale one fades. NOT a raw lifetime count.
 *   - **Popular** — lifetime demand: total upvotes + total viewers (the
 *     "most-starred" tab).
 *   - **Recent / New** — newly-made-public, ordered by the moment a project
 *     became `public` (the "newest" axis every gallery carries).
 * Each rank is a DETERMINISTIC total order (a stable tiebreak on project id so
 * the cursor never skips/duplicates a row across pages) and CURSOR-PAGINATED —
 * a system-level list of every public project could be thousands, so it is
 * NEVER load-all (finding #57); ranking is computed at the read layer over the
 * 6.12.6 vote rows + project activity, not precomputed into a denormalized
 * column this story has to keep fresh.
 *
 * **The directory EXCLUDES non-public projects (the load-bearing correctness).**
 * The 6.13.2 directory service lists ONLY projects whose access level is
 * `public`; a private/open/limited project NEVER appears in the square, for any
 * viewer, ever — the directory read is filtered on `access_level = 'public'` at
 * the repository layer, and the 6.12.3 404-not-403 posture for non-public
 * projects is untouched (a non-public project is simply not in the result set,
 * never "forbidden"). The square is a thin DISCOVERY index over the 6.12
 * projection; it surfaces only the card-projection fields (name, org,
 * description, the three public stats), never any internal project field.
 *
 * **Categories / tags (the browse axis — the GitHub Topics / GitLab Topics
 * mirror).** A public project carries category/tags so the square is browsable
 * by topic (e.g. "developer-tools", "design", "open-source"). 6.13.5 owns the
 * tag model + the per-project tagging + the tag-facet read; the square filters
 * the gallery to a category and (the GitLab-Topics behaviour) can list the
 * categories themselves sorted by project count. Tags are bounded + searchable;
 * the per-tag listing rides the same cursor-paginated rank reads.
 *
 * **Design gate.** The project square is a NEW user-facing surface — a fully
 * public web page (the marketing-site top bar + footer, the SEO hero, the
 * gallery/cards, the search bar, the category/tag filters, the sort/rank tabs,
 * and the SEO + GEO scaffolding — NO app shell / no left-nav entry). So the
 * FIRST subtask (6.13.1) is a `design` card producing the multi-panel mock +
 * design-notes under `design/project-square/`, composing ONLY shipped
 * `components/ui/*` primitives + `--el-*` colour tokens + `[data-display-style]`
 * shape tokens (NO Tier-0 `--color-*`, no hand-rolled spacing/radius). The
 * single UI code subtask (6.13.6) depends on it and is `blocked`.
 *
 * **Cross-story dep audit (notes.html #32): PASSES — NO forward deps.** Every
 * `dependsOn` id's story number is ≤ 6.13: same-story 6.13.x, or backward to
 * 6.12.x (the public access level 6.12.3, the upvote/activity signals 6.12.6)
 * and the SHIPPED 6.1.1 FilterAST search. 6.1.1 is DONE so its dep is satisfied;
 * 6.12.x is being planned (not done) so anything chained behind a 6.12.x id is
 * `blocked`. 6.13.1 (design, `dependsOn: []`) is `planned`; every other card
 * (each chained behind 6.13.2 or 6.12.x) is `blocked`.
 */
export const story_6_13: PlanStory = {
  id: '6.13',
  title: 'The project square (system-level public-project directory)',
  status: 'planned',
  gitBranch: 'feat/PROD-6.13-project-square',
  descriptionMd:
    'The **project square** — a SYSTEM-level directory of every project made ' +
    '**public** in 6.12, as a **fully public (no sign-in) web page** at ' +
    '`motir.co/explore`, reached from the Motir **marketing site** (NOT an ' +
    'app-shell route, NO left-nav entry). A crawlable gallery anyone can ' +
    'browse: **project cards** (name, org, description, viewer / upvote / ' +
    'activity stats — NO redundant “Public” pill), a **search bar**, ' +
    '**category / tag filters**, and **sort / rank tabs** (trending / popular ' +
    '/ recent-new), paginated at scale, **SEO + GEO optimised** (server-' +
    'rendered, JSON-LD, semantic HTML, sitemap’d real URLs + per-topic landing ' +
    'pages, answer-engine framing) — then click any card through to that ' +
    'project’s public read-only view (6.12.4). It is the cross-org DISCOVERY ' +
    'surface that 6.12 was missing: 6.12 made each project openable but ' +
    'reachable only by share-link; 6.13 is the place all public projects ' +
    'surface together so anyone can FIND them without a link.\n\n' +
    '**Model revision (Yue, 2026-06-14):** fully public / no auth; not in the ' +
    'left nav (a marketing-site page); no per-card “Public” pill; SEO + GEO ' +
    'optimised. Supersedes the earlier account-required + shell-entry framing.\n\n' +
    '**The model (locked — see the module header for the full rationale + the ' +
    'verified mirror):**\n\n' +
    '- **A thin DISCOVERY index over 6.12, not a new access system.** The ' +
    'square lists ONLY projects whose access level is already `public` (the ' +
    'single cross-org READ exception 6.12.3 fixed); a private / open / limited ' +
    'project NEVER appears, for any viewer. It adds NO new write, NO new ' +
    'cross-org grant — the page itself is fully public (no sign-in), and every ' +
    'card click lands on the 6.12.4 public view that already enforces the ' +
    'public projection.\n' +
    '- **A public, crawlable web page (SEO + GEO), not an app surface.** ' +
    'Server-rendered with a real `<h1>` + descriptive lede, semantic HTML, ' +
    'JSON-LD (`CollectionPage` › `ItemList`), head meta / OpenGraph / ' +
    'canonical, and a sitemap of real indexable URLs (each rank / search / ' +
    'topic / page) + per-topic landing pages (`/explore/topic/<slug>`); a GEO ' +
    'answer-engine framing (citable lead + FAQ). Reached from the marketing ' +
    'site, NOT the app left-nav.\n' +
    '- **The card projection.** A card shows name, org, description, and the ' +
    'three public demand signals from 6.12.6 (viewers / upvotes / recent ' +
    'activity) — the directory read surfaces ONLY these card-projection ' +
    'fields, never an internal project field.\n' +
    '- **Three ranks (the GitHub-Trending / GitLab-Explore-tabs set), ' +
    'deterministic + cursor-paginated.** **Trending** = recent upvotes + ' +
    'activity in a recency window (a project freshly surging rises); ' +
    '**Popular** = total upvotes + total viewers (lifetime); **Recent / New** ' +
    '= newly-made-public, by the moment it turned `public`. Each is a stable ' +
    'total order (tiebreak on project id) computed at the read layer over the ' +
    '6.12.6 signals — NOT load-all (a system list could be thousands — finding ' +
    '#57).\n' +
    '- **Search + category / tag filters (the GitHub-Topics / GitLab-Topics ' +
    'browse axis).** A name/description search over public projects (riding ' +
    'the shipped 6.1.1 FilterAST where it fits, else a scoped search) + ' +
    'category/tags so the square is browsable by topic, with a categories view ' +
    'sorted by project count.\n\n' +
    '**Scope:** the project-square design (6.13.1); the cross-org public-' +
    'projects directory service, cursor-paginated, card-projection, EXCLUDING ' +
    'non-public projects (6.13.2); search + category/tag filtering (6.13.3); ' +
    'the trending / popular / recent ranking (6.13.4); the public-project ' +
    'categories/tags model + tagging + tag-facet (6.13.5); the project-square ' +
    'UI — the fully-public marketing-site page (top bar + footer), the SEO ' +
    'hero, gallery + cards + search/filter/sort tabs + the SEO/GEO scaffolding ' +
    '(metadata, JSON-LD, semantic HTML, sitemap, topic landing pages), each ' +
    'card linking to the 6.12.4 public view (6.13.6); the directory + ranking ' +
    '+ search/filter + pagination tests (6.13.7); the anonymous browse → ' +
    'search → sort-by-trending → click-into-public-view e2e (6.13.8).\n\n' +
    '**Out of scope (named so they land in their own story, not here):** a ' +
    'curated / editorially-featured "collections" surface ' +
    '(GitHub Collections — a later editorial layer; 6.13 ships the algorithmic ' +
    'ranks + the category browse); per-account personalization / "projects for ' +
    'you" recommendation (a signal-driven enhancement); cross-org GLOBAL search ' +
    'beyond public projects (the shipped FilterAST stays project-scoped — 6.13 ' +
    'searches only the public directory); and AI-assisted discovery / ' +
    'semantic ranking (an Epic-7 enhancement).',
  verificationRecipeMd:
    '- Pull the Story branch; run the migration + `pnpm db:seed` against the ' +
    'local Postgres (`localhost:5433`); `pnpm dev`. Seed a HANDFUL of public ' +
    'projects across MORE THAN ONE org (with varied upvote/viewer/activity + ' +
    'made-public timestamps) plus at least one NON-public project per org.\n' +
    '- **The square shows only public projects, cross-org — fully public, no ' +
    'sign-in.** Open `/explore` while LOGGED OUT (no session) → the gallery ' +
    'renders project CARDS (name, org, description, viewer / upvote / activity ' +
    'stats — NO “Public” pill) for the public projects across ALL orgs. ' +
    'Confirm the page is reached as a standalone web page (NOT from the app ' +
    'left-nav — there is no left-nav entry), and view-source shows a real ' +
    '`<h1>`, `<meta>`/OpenGraph tags, and a JSON-LD `CollectionPage` block ' +
    '(SEO/GEO). Confirm the seeded NON-public projects are ' +
    'ABSENT from the square for everyone (a private/open/limited project never ' +
    'appears), and that the 404-not-403 posture for those projects is ' +
    'unchanged when hit directly.\n' +
    '- **Sort / rank tabs.** Switch the tabs: **Trending** orders by recent ' +
    'upvotes + activity (a project given a fresh burst of upvotes rises above ' +
    'a higher-lifetime-but-stale one); **Popular** orders by total upvotes / ' +
    'viewers; **Recent / New** orders by made-public time (the newest public ' +
    'project first). Each ordering is stable on reload (deterministic ' +
    'tiebreak) and paginates (no load-all) — scroll/next past the first page ' +
    'and confirm no row is skipped or duplicated at the page boundary.\n' +
    '- **Search + category / tag filter.** Type a query in the search bar → ' +
    'the gallery narrows to public projects matching name/description; pick a ' +
    'category/tag → the gallery narrows to that topic; the categories view ' +
    'lists topics with their project counts. Clearing returns to the full ' +
    'ranked gallery. Confirm search/filter compose with the active rank tab + ' +
    'the cursor pagination.\n' +
    '- **Click-through to the public view.** Click a card → it lands on that ' +
    'project’s 6.12.4 public read-only view (the board / issues / public ' +
    'roadmap), which still enforces the public projection (internal fields ' +
    'absent) — proving the square is a discovery index over the 6.12 surface, ' +
    'not a second view path.\n' +
    '- `pnpm test` (6.13.7) covers: the directory lists ONLY public projects ' +
    'cross-org (non-public excluded); each rank’s ordering correctness + ' +
    'determinism + cursor pagination (no skip/dupe); search + category/tag ' +
    'filter correctness; the card projection surfaces no internal field — all ' +
    'on a real Postgres respecting the per-file coverage gate.\n' +
    '- **4-layer + token review.** No raw Prisma in any route; the directory / ' +
    'ranking / search reads go through the service → repository layer with the ' +
    'card projection (the `access_level = public` filter lives in the ' +
    'repository read, not a route); the square surfaces reference only ' +
    '`--el-*` / `[data-display-style]` tokens + shipped `components/ui/*`.\n' +
    '- **Dep audit.** Confirm no 6.13 subtask references any id > 6.13 (deps ' +
    'are 6.13.x / 6.12.x / 6.1.1 only).\n' +
    '- If every step holds, approve and merge the Story PR. If anything fails, ' +
    'comment with what didn’t work and Motir will produce a follow-up Subtask ' +
    'under the same Story.',
  items: [
    {
      id: '6.13.1',
      title:
        'Design — the project square: the fully-public marketing-site page (hero + cards), search, category/tag filters, sort/rank tabs, the SEO/GEO scaffolding',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        '**Type:** design (THE design gate — produced FIRST; the UI code ' +
        'subtask here — 6.13.6 — depends on this card and is `blocked` until ' +
        'it lands). Produce the surface design assets under ' +
        '`motir-core/design/project-square/`, composing ONLY shipped ' +
        '`components/ui/*` primitives + `--el-*` colour tokens + ' +
        '`[data-display-style]` shape tokens (NO Tier-0 `--color-*`, no ' +
        'hand-rolled spacing/radius), mirroring 7.0.1’s multi-panel design-card ' +
        'shape.\n\n' +
        'The surfaces to draw (every panel — the multi-panel rule, mistake ' +
        '#31):\n\n' +
        '- **Panel 1 — the public page (marketing-site chrome + hero + ' +
        'gallery).** A standalone, fully-public web page: the **marketing-site ' +
        'top bar** (Motir logo + minimal nav + sign-in/CTA) and **footer** (an ' +
        'SEO link surface with topic landing links) — NOT the app shell. The ' +
        '**SEO hero**: a real `<h1>`, a descriptive lede (human + crawler), the ' +
        'search, and a "no sign-up required" trust line. Then the grid of ' +
        '**project cards**: each card draws the project name, its **org** (the ' +
        'cross-org context — the owning org is shown), the description ' +
        '(truncated), and the three public stat signals from 6.12.6 (**viewers ' +
        '/ upvotes / recent activity**) with their glyphs. **NO per-card ' +
        '"Public" pill** (every project here is public by definition). Draw the ' +
        'card hover/focus state and the whole-card click affordance (a real ' +
        '`<a href>` to the 6.12.4 public view). The grid is paginated / lazy ' +
        '(the at-scale rule — NOT load-all; draw the "load more" / next-page ' +
        'affordance + the page-boundary skeleton). Mirror the GitHub-Trending / ' +
        'GitLab-Explore card row.\n' +
        '- **Panel 2 — the sort / rank tabs.** The **Trending / Popular / ' +
        'Recent (New)** tab control (the GitLab-Explore-tabs shape), with ' +
        'one-line copy for each ("Trending = surging now", "Popular = ' +
        'most-upvoted overall", "New = recently made public"). For Trending, ' +
        'draw the recency-window selector (the GitHub daily / weekly / monthly ' +
        'bucket) if shown. Draw which rank is the DEFAULT landing tab.\n' +
        '- **Panel 3 — the search bar + the category / tag filters.** The ' +
        'search input (placeholder copy: search public projects by name / ' +
        'description) and the **category / tag filter** (a chip/facet row or a ' +
        'picker) — the GitHub-Topics / GitLab-Topics browse axis. Draw the ' +
        'active-filter state (selected tag chip + clear), and how ' +
        'search + tag + the rank tab COMPOSE (all three active at once). Draw ' +
        'the categories-browse view (topics listed with their project ' +
        'counts).\n' +
        '- **Panel 4 — the SEO + GEO scaffolding.** The page is fully public + ' +
        'server-rendered + crawlable. Draw the head `<title>` / `<meta ' +
        'description>` / canonical / OpenGraph / Twitter, the JSON-LD ' +
        'structured data (`CollectionPage` › `ItemList` of `SoftwareApplication` ' +
        '+ `BreadcrumbList`), the semantic HTML outline (one `<h1>`, `<h2>` ' +
        'sections, each card an `<article>` with an `<h3>`, topic browse in a ' +
        '`<nav>`), the real indexable URLs / sitemap (each rank / search / ' +
        'topic / page) + per-topic landing pages (`/explore/topic/<slug>`), and ' +
        'the GEO answer-engine framing (a citable lead + FAQ). State it is ' +
        'reached from the marketing site, NOT the app left-nav.\n' +
        '- **Panel 5 — empty / loading / error / no-results states.** The ' +
        'empty square (no public projects yet), the paginated loading ' +
        'skeleton, the fetch-error state, and the no-search-results / ' +
        'no-projects-in-this-category state (each with the right recovery ' +
        'copy — "clear filters", "browse all").\n\n' +
        'Write **`design/project-square/design-notes.md`** naming every ' +
        'primitive composed (e.g. the card surface, `Pill` for the stat / tag ' +
        'tone, the tab control, the search `Combobox`/input, the ' +
        'EmptyState/ErrorState family, the skeleton/loader), the EXACT copy ' +
        'for each tab + each stat label + each search/filter placeholder + ' +
        'each empty/error state, the per-`--el-*` colour role for every ' +
        'element (use the palette, not grey-only — finding #54; e.g. the ' +
        'upvote accent, the per-rank tab tone, the tag-chip tints), and a ' +
        '"primitives composed (no hand-rolling)" checklist. It MUST state, in ' +
        'writing, that the square shows ONLY public projects, that the org is ' +
        'shown on each card (the cross-org context), and that each card links ' +
        'to the 6.12.4 public view.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `design/project-square/*.mock.html` renders the five panels above, ' +
        'referencing ONLY `--el-*` + `[data-display-style]` tokens (no Tier-0 ' +
        '`--color-*`, no hand-rolled spacing/radius) + shipped ' +
        '`components/ui/*`.\n' +
        '- The card draws name + ORG + description + the three 6.12.6 stats ' +
        '(viewers / upvotes / activity) with NO "Public" pill, and a ' +
        'whole-card `<a href>` to the 6.12.4 view; the gallery is drawn ' +
        'paginated / lazy (not load-all).\n' +
        '- The Trending / Popular / Recent tabs are drawn (with the default ' +
        'tab + any recency-window selector), the search bar + category/tag ' +
        'filter are drawn composing with the active tab, and the ' +
        'categories-by-count browse view is drawn.\n' +
        '- The page is drawn as a standalone fully-public marketing-site page ' +
        '(top bar + footer, SEO hero), NOT an app-shell route / no left-nav ' +
        'entry; the SEO + GEO scaffolding (head meta/OpenGraph, JSON-LD, ' +
        'semantic outline, sitemap/topic landing pages, GEO framing) is drawn.\n' +
        '- `design-notes.md` names every primitive + copy + per-element ' +
        '`--el-*` role, and states the fully-public (no-auth) + public-only + ' +
        'org-on-card + no-"Public"-pill + links-to-6.12.4 invariants; AA ' +
        'contrast holds for the stat / tab / tag-chip tints.\n\n' +
        '## Context refs\n\n' +
        '- `scripts/plan-seed/data/story-7.0.ts` § 7.0.1 — the multi-panel ' +
        'design-card shape to mirror.\n' +
        '- `scripts/plan-seed/data/story-6.12.ts` § 6.12.1 — the public-view + ' +
        'public-roadmap design the cards link INTO (the projection to stay ' +
        'consistent with; NB the square itself is now ANONYMOUS, while 6.12.4 ' +
        'is still account-required — see the header revision + the 6.12 ' +
        'finding).\n' +
        '- GitHub Trending (https://github.com/trending) + Explore ' +
        '(https://github.com/explore) — the card row (owner/repo, language, ' +
        'description, stats) + the Topics/Collections browse being mirrored.\n' +
        '- GitLab Explore Projects ' +
        '(https://gitlab.com/explore/projects/trending) — the Trending / ' +
        'Most-starred / All TABS + sort + Topic filter + name search shape.\n' +
        '- `motir-core/components/ui/*`, `app/globals.css` (the `--el-*` + ' +
        '`[data-display-style]` token layers), `motir-core/CLAUDE.md` § colour ' +
        '+ shape tokens; `Pill` (the stat/tag tone primitive).',
      dependsOn: [],
    },
    {
      id: '6.13.2',
      title:
        'Public-projects directory service — list ALL `public` projects cross-org, cursor-paginated, card projection; EXCLUDES non-public',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'The backend foundation of the square: the cross-org directory read ' +
        'that lists EVERY `public` project and EXCLUDES every non-public one. ' +
        'This is the load-bearing correctness work the whole story rides — it ' +
        'must surface only the card-projection fields and never an internal ' +
        'project field.\n\n' +
        '- **The directory read (the single auditable filter):** a service + ' +
        'route returning public projects ACROSS every org/workspace, with the ' +
        "repository read filtered on `access_level = 'public'` (the 6.12.3 " +
        'enum value) — the public-only filter lives in ONE repository read, so ' +
        'no non-public project can leak through any code path. A private / ' +
        'open / limited project NEVER appears, for any viewer; the 6.12.3 ' +
        '404-not-403 posture for non-public projects is untouched (a ' +
        'non-public project is simply absent from the set, never "forbidden"). ' +
        '**Anonymous-readable: the directory read requires NO session** (the ' +
        'page is fully public — model revision 2026-06-14); it must run on the ' +
        'server with no `getSession()` gate so crawlers / logged-out visitors ' +
        'get the full list.\n' +
        '- **The card projection (a dedicated read shape / DTO):** the read ' +
        'returns ONLY the card fields — project name, the owning ORG (name / ' +
        'slug — the cross-org context the square shows), description, and the ' +
        'three 6.12.6 public stats (viewer count, upvote total, a recent-' +
        'activity signal) — NEVER an internal project field. The stats are ' +
        'read from the 6.12.6 vote / activity signals (this card surfaces the ' +
        'projection; 6.13.4 owns the ranking ORDER over them).\n' +
        '- **Cursor pagination (finding #57):** a system-level list of public ' +
        'projects could be thousands, so the read is CURSOR-paginated (a ' +
        'stable keyset cursor, never `OFFSET`-the-world, never load-all) with ' +
        'a bounded page size. The default ordering is a deterministic total ' +
        'order (a stable tiebreak on project id) so the cursor never ' +
        'skips/duplicates a row — 6.13.4 swaps in the trending/popular/recent ' +
        'sort keys over this same cursored read.\n\n' +
        'Stay 4-layer: the route parses + calls ONE service method returning ' +
        'the card-projection page; the `access_level = public` filter + the ' +
        'projection live in the service/repository read layer so no future ' +
        'read can leak a non-public project or an internal field; no raw ' +
        'Prisma in the route.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The directory service returns public projects ACROSS orgs ' +
        '(including orgs the requesting account has no membership in) and ' +
        'EXCLUDES every non-public project — asserted with a mixed seed ' +
        '(public + private/open/limited across multiple orgs); the public-only ' +
        'filter is a single repository read.\n' +
        '- The card projection returns ONLY name + org + description + the ' +
        'three 6.12.6 stats; no internal project field is present in the ' +
        'payload (verified at the payload level, not the DOM).\n' +
        '- The read is cursor-paginated with a bounded page size and a ' +
        'deterministic total order (stable id tiebreak) — paging past a ' +
        'boundary skips/duplicates no row; it is NOT load-all / not ' +
        'OFFSET-the-world.\n' +
        '- Anonymous-readable (NO session required — the route has no ' +
        '`getSession()` gate); 4-layer respected (the filter + projection in ' +
        'the service/repository, no raw Prisma in the route).\n\n' +
        '## Context refs\n\n' +
        '- `scripts/plan-seed/data/story-6.12.ts` § 6.12.3 (the `public` ' +
        '`ProjectAccessLevel` value + the cross-org read exception) + § 6.12.6 ' +
        '(the upvote / activity signals the stats read from) + § 6.12.4 (the ' +
        'public projection posture to mirror).\n' +
        '- `motir-core/lib/repositories/` + `lib/services/` — the project ' +
        'read layer the directory threads into; `projectAccessService` (6.4 / ' +
        '6.12.3) — the `public` level the filter keys off.\n' +
        '- finding #57 (cursor pagination, no load-all); ' +
        '`motir-core/CLAUDE.md` § 4-layer.',
      dependsOn: ['6.12.3'],
    },
    {
      id: '6.13.3',
      title:
        'Search + category/tag filter over the public-projects directory (ride the shipped 6.1.1 FilterAST where it fits, else a scoped search)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'The search + category/tag narrowing over the 6.13.2 directory — the ' +
        'GitLab-Explore name-search + the GitHub-Topics / GitLab-Topics ' +
        'category filter. It NARROWS the same cursored directory read; it does ' +
        'NOT open a second query path.\n\n' +
        '- **Search:** a name/description contains-match over the public ' +
        'projects in the directory. Ride the SHIPPED 6.1.1 FilterAST / its ' +
        'safe parameterized compiler + the trgm text index where it fits (the ' +
        'contains-match over project name/description is exactly its shape); ' +
        'where the project-level directory search does not map onto the 6.1.1 ' +
        'work-item search, a SCOPED parameterized search (no string-built SQL — ' +
        'the 6.1.1 injection-safety posture) over the public-project set. The ' +
        'search composes with the active rank tab (6.13.4) + the cursor ' +
        'pagination, and is bounded (no load-all of the result).\n' +
        '- **Category / tag filter:** narrow the directory to a category/tag ' +
        '(the 6.13.5 tag model) — an EXISTS-over-the-tag-join predicate that ' +
        'composes with search + the rank under the cursor. (6.13.5 owns the ' +
        'tag model + the tag-facet read; this card consumes them as a filter ' +
        'predicate over the directory.) The tag filter + search are both ' +
        'parameterized, both respect the `access_level = public` directory ' +
        'filter (you can only ever search/filter public projects).\n\n' +
        'Stay 4-layer: the route parses the query/tag params + calls ONE ' +
        'service method that threads the search/tag predicate into the 6.13.2 ' +
        'cursored read; the predicate compilation lives in the ' +
        'service/repository (no raw Prisma in the route); no user string ' +
        'reaches SQL unparameterized.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A name/description query narrows the directory to matching public ' +
        'projects; it rides the 6.1.1 FilterAST/compiler where it fits, else a ' +
        'scoped parameterized search — no string-built SQL on the path ' +
        '(injection-safe, the 6.1.1 posture).\n' +
        '- A category/tag selection narrows the directory to that topic (an ' +
        'EXISTS over the 6.13.5 tag join); search + tag + the rank tab COMPOSE ' +
        'under one cursored read.\n' +
        '- Both predicates respect the `access_level = public` directory ' +
        'filter (no non-public project is ever searchable/filterable) and the ' +
        'cursor pagination (no load-all of the result set).\n' +
        '- 4-layer respected; no raw Prisma in the route; the search/filter ' +
        'compose with 6.13.2’s deterministic order + cursor.\n\n' +
        '## Context refs\n\n' +
        '- 6.13.2 (the cursored directory read this narrows) + 6.13.5 (the ' +
        'tag model the category filter consumes) + 6.13.4 (the rank the search ' +
        'composes with).\n' +
        '- `scripts/plan-seed/data/story-6.1.ts` § 6.1.1 (the SHIPPED ' +
        'FilterAST + the safe parameterized compiler + the trgm text index ' +
        'this rides where it fits) — `lib/filters/ast.ts` / ' +
        '`lib/filters/registry.ts`.\n' +
        '- GitLab Explore name search + Topic filter ' +
        '(https://gitlab.com/explore/projects/trending, ' +
        'https://docs.gitlab.com/user/project/project_topics/) — the ' +
        'search + category browse mirrored.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + the repo-owns-`$queryRaw` rule.',
      dependsOn: ['6.13.2'],
    },
    {
      id: '6.13.4',
      title:
        'Ranking — trending (recent upvotes/activity) / popular (total upvotes/viewers) / recent-new, deterministic + paginatable',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'The three ranks over the 6.13.2 directory, computed from the 6.12.6 ' +
        'votes + project activity — the GitHub-Trending / GitLab-Explore-tabs ' +
        'set. Each rank is a DETERMINISTIC total order and rides the 6.13.2 ' +
        'cursor (so the tab is paginatable, never load-all).\n\n' +
        '- **Trending** — RECENT demand: upvotes + project activity inside a ' +
        'recency WINDOW (the GitHub daily / weekly / monthly bucket — decide ' +
        'the window / whether the bucket is selectable), so a freshly-surging ' +
        'public project rises above a higher-lifetime-but-stale one. Computed ' +
        'over the 6.12.6 vote rows’ timestamps + the project activity signal, ' +
        'NOT a raw lifetime count.\n' +
        '- **Popular** — LIFETIME demand: total upvotes + total viewers (the ' +
        '"most-starred" tab). A stable order over the lifetime 6.12.6 totals.\n' +
        '- **Recent / New** — newly-made-public: ordered by the moment the ' +
        'project became `public` (the made-public timestamp — the "newest" ' +
        'axis). (If no made-public timestamp exists yet, this card adds it as ' +
        'part of the 6.12.3 access foundation’s data — a `madePublicAt` set ' +
        'when access flips to `public`.)\n' +
        '- **Deterministic + paginatable (finding #57):** each rank is a ' +
        'stable TOTAL order — the rank key with a stable tiebreak on project ' +
        'id — so the 6.13.2 keyset cursor never skips/duplicates a row across ' +
        'pages. Ranking is computed at the READ layer over the 6.12.6 signals ' +
        '(an aggregate / window over the vote + activity rows), NOT precomputed ' +
        'into a denormalized column this story must keep fresh; if the ' +
        'aggregate is too costly at scale, a bounded materialized read is the ' +
        'documented durable shape (still deterministic + cursored), not a ' +
        'load-all-then-sort-in-memory shortcut.\n\n' +
        'Stay 4-layer: the route parses the `rank` (+ window) param + calls ' +
        'ONE service method selecting the rank’s sort key over the 6.13.2 ' +
        'cursored read; the aggregate/window lives in the service/repository ' +
        'read; no raw Prisma in the route.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Trending orders by recent (windowed) upvotes + activity (a project ' +
        'given a fresh upvote burst rises above a higher-lifetime-but-stale ' +
        'one — asserted with timestamped seed votes); Popular orders by total ' +
        'upvotes / viewers; Recent orders by the made-public timestamp ' +
        '(newest first).\n' +
        '- Each rank is a deterministic total order (stable id tiebreak) and ' +
        'rides the 6.13.2 cursor — paging a rank skips/duplicates no row; no ' +
        'rank loads-all-then-sorts in memory.\n' +
        '- Ranking is computed at the read layer over the 6.12.6 vote/activity ' +
        'signals (no denormalized rank column this story must keep fresh; if a ' +
        'bounded materialized read is used it stays deterministic + cursored).\n' +
        '- 4-layer respected (the aggregate/window in the service/repository, ' +
        'no raw Prisma in the route); composes with the 6.13.3 search/tag ' +
        'filter.\n\n' +
        '## Context refs\n\n' +
        '- 6.13.2 (the cursored directory read the ranks order) + 6.12.6 (the ' +
        'upvote / viewer / activity signals the ranks compute from).\n' +
        '- `scripts/plan-seed/data/story-6.12.ts` § 6.12.6 (the ' +
        '`PublicRequestVote` + activity demand signals) + § 6.12.3 (the access ' +
        'foundation the `madePublicAt` lands with).\n' +
        '- GitHub Trending ' +
        '(https://github.com/trending) — the daily/weekly/monthly recency ' +
        'bucket + weighted-recent-signal trending; GitLab Explore ' +
        '(https://gitlab.com/explore/projects/trending) — the ' +
        'Trending / Most-starred / Newest tabs mirrored.\n' +
        '- finding #57 (deterministic + cursor-paginated, no load-all); ' +
        '`motir-core/CLAUDE.md` § 4-layer.',
      dependsOn: ['6.13.2', '6.12.6'],
    },
    {
      id: '6.13.5',
      title:
        'Public-project categories / tags — the tag model + per-project tagging + the tag-facet read (browsable by topic)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'The category / tag model that makes the square browsable by topic — ' +
        'the GitHub-Topics / GitLab-Topics axis. A public project carries ' +
        'tags; the square filters to a tag (6.13.3) and lists the categories ' +
        'sorted by project count.\n\n' +
        '- **The tag model + join:** a `ProjectTag` (a normalized tag — ' +
        '`{ id, slug, label }`, bounded set) + a `ProjectTagAssignment` join ' +
        'to `project`, BOTH FKs modelled as Prisma `@relation` on both sides ' +
        '(the CLAUDE.md FK-as-`@relation` rule — no raw-SQL-only FK), unique on ' +
        '`(projectId, tagId)`. Tags are reusable across projects (a shared ' +
        'topic vocabulary, the GitHub-Topics shape), not free-text per project ' +
        'duplicated.\n' +
        '- **Per-project tagging:** the project admin assigns tags (a service ' +
        '+ route, project-admin-gated — reuse the 6.4 project-admin check); ' +
        'bounded (a sane cap on tags per project) + the tags are validated ' +
        'against the bounded vocabulary. (Whether the admin can MINT a new tag ' +
        'vs only pick from a curated set is decided here — default to a ' +
        'curated/normalized vocabulary so the categories stay a clean browse ' +
        'axis, not a long tail of near-dupes.)\n' +
        '- **The tag-facet read:** a read returning the categories with their ' +
        'PUBLIC-project counts (the GitLab "topics sorted by number of ' +
        'associated projects" view) — counting ONLY public projects (it ' +
        'respects the 6.13.2 `access_level = public` filter, so a tag’s count ' +
        'is its public-project count, and a tag with only non-public projects ' +
        'does not inflate the square). This read feeds the 6.13.3 category ' +
        'filter + the categories-browse panel.\n\n' +
        'Stay 4-layer: the tag model + assignment in `prisma/schema.prisma` + ' +
        'a single-op repository; the tagging service (admin-gated) + the ' +
        'tag-facet read service own their logic; no raw Prisma in routes.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The migration adds `ProjectTag` + the `ProjectTagAssignment` join ' +
        '(every FK an `@relation` on both sides, unique on ' +
        '`(projectId, tagId)`); `prisma migrate dev` reports no drift.\n' +
        '- A project admin assigns tags from the bounded vocabulary ' +
        '(project-admin-gated, capped per project); tags are reusable across ' +
        'projects (a shared topic, not per-project free-text dupes).\n' +
        '- The tag-facet read returns categories with their PUBLIC-project ' +
        'counts (respecting the 6.13.2 public-only filter); it feeds the ' +
        '6.13.3 category filter + the categories-browse view.\n' +
        '- 4-layer respected (the tag model in a single-op repository, the ' +
        'tagging + facet logic in services, no raw Prisma in routes).\n\n' +
        '## Context refs\n\n' +
        '- 6.13.2 (the `access_level = public` filter the tag counts respect) ' +
        '+ 6.13.3 (the category filter this model feeds).\n' +
        '- `scripts/plan-seed/data/story-6.4.ts` — the project-admin check the ' +
        'tagging gate reuses.\n' +
        '- GitHub Topics (https://github.com/explore) + GitLab project topics ' +
        '(https://docs.gitlab.com/user/project/project_topics/) — the reusable ' +
        'topic vocabulary + the topics-sorted-by-project-count view mirrored.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + § migration FK-as-`@relation` ' +
        'rule.',
      dependsOn: ['6.13.2'],
    },
    {
      id: '6.13.6',
      title:
        'The project-square UI — the fully-public, SEO/GEO-optimised marketing-site page (hero + cards + search/filter/sort), each card linking to the 6.12.4 public view',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 75,
      descriptionMd:
        'Build the project-square surface per the 6.13.1 design, over the ' +
        '6.13.3 search/filter + the 6.13.4 ranking. A **fully public (no ' +
        'sign-in), server-rendered, SEO + GEO-optimised web page** at ' +
        '`/explore`, reached from the Motir marketing site — NOT an app-shell ' +
        'route, NO left-nav entry. It renders for logged-out visitors and ' +
        'crawlers with no `getSession()` gate.\n\n' +
        '- **The gallery + cards:** render the grid of project cards (name, ' +
        'org, description, the three 6.12.6 stats) from the 6.13.2 card ' +
        'projection; each card is a whole-card LINK to that project’s 6.12.4 ' +
        'public read-only view (the discovery → view handoff — no second view ' +
        'path here). Paginated / lazy (the at-scale rule — the "load more" / ' +
        'next-page affordance over the 6.13.2 cursor; never load-all).\n' +
        '- **The sort / rank tabs:** the Trending / Popular / Recent tabs ' +
        '(+ the recency-window selector if designed) driving the 6.13.4 rank; ' +
        'the rank is carried in a URL param (shareable / reloadable, composing ' +
        'with the search + tag params, Suspense-keyed like the shipped ' +
        'list params).\n' +
        '- **The search bar + category / tag filter:** the search input + the ' +
        'category/tag filter driving 6.13.3; both carried in URL params that ' +
        'COMPOSE with the rank tab + the cursor; the categories-browse view ' +
        '(topics by count) from the 6.13.5 facet read; the active-filter + ' +
        'clear states.\n' +
        '- **The page chrome (marketing-site, NOT app shell):** the public top ' +
        'bar (logo + minimal nav + sign-in/CTA) and footer (an SEO link ' +
        'surface with the per-topic landing links). There is NO app sidebar / ' +
        'NO left-nav entry — the page is reached from the marketing site. The ' +
        'SEO hero leads with a real `<h1>` + descriptive lede + the search.\n' +
        '- **SEO + GEO (the build contract):** server-render the page (no ' +
        'client-only gate) so it is fully crawlable. Emit head metadata ' +
        '(`title`, `description`, canonical, OpenGraph + a generated ' +
        '`/explore/opengraph-image`, Twitter), JSON-LD structured data ' +
        '(`CollectionPage` › `ItemList` of `SoftwareApplication` + a ' +
        '`BreadcrumbList` on topic pages), semantic HTML (one `<h1>`, `<h2>` ' +
        'sections, each card an `<article>`/`<h3>`, topic browse in a `<nav>`), ' +
        'and an XML sitemap of the real indexable URLs (`/explore`, each rank / ' +
        '`?q=` / `?tag=` / `?page=`, and the `/explore/topic/<slug>` landing ' +
        'pages). Cards are real `<a href>` (crawlable without JS). Add a ' +
        'concise citable lead + an FAQ block for GEO (answer-engine framing).\n' +
        '- **States:** the empty square, the paginated loading skeleton, the ' +
        'fetch-error, and the no-results / no-projects-in-category states per ' +
        'the 6.13.1 design.\n\n' +
        'Use ONLY shipped `components/ui/*` + `--el-*` / `[data-display-style]` ' +
        'tokens (palette tones for the stats / tabs / tag chips, not ' +
        'grey-only); strings via next-intl. Cards carry NO "Public" pill. Stay ' +
        '4-layer: the page/route reads through the 6.13.2/6.13.3/6.13.4 ' +
        'services (no view-specific query code, no raw Prisma in the route).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The square renders the card gallery (name / org / description / the ' +
        'three stats) per the 6.13.1 design; each card links to the project’s ' +
        '6.12.4 public view; the gallery is paginated / lazy over the 6.13.2 ' +
        'cursor (not load-all).\n' +
        '- The Trending / Popular / Recent tabs drive the 6.13.4 rank; the ' +
        'search bar + category/tag filter drive 6.13.3; rank + search + tag are ' +
        'carried in composable URL params (reload/share restores state).\n' +
        '- The page renders as a fully-public, server-rendered marketing-site ' +
        'page (top bar + footer, SEO hero) for a LOGGED-OUT visitor — NOT an ' +
        'app-shell route, no left-nav entry; it emits the head metadata + ' +
        'JSON-LD + semantic HTML + sitemap/topic landing pages (SEO/GEO); cards ' +
        'carry NO "Public" pill; the empty / loading / error / no-results ' +
        'states render.\n' +
        '- Only `--el-*` + `[data-display-style]` tokens + shipped ' +
        '`components/ui/*`; matches the 6.13.1 design; next-intl; 4-layer ' +
        'respected (reads through the services, no raw Prisma in the route).\n\n' +
        '## Context refs\n\n' +
        '- 6.13.1 (the design asset — required), 6.13.3 (search + category/tag ' +
        'filter), 6.13.4 (the rank tabs).\n' +
        '- `scripts/plan-seed/data/story-6.12.ts` § 6.12.4 — the public ' +
        'read-only view each card links INTO.\n' +
        '- `motir-core/components/ui/*` + `app/globals.css` token layers; the ' +
        'URL-driven list-param conventions (`?view/?sort/?page`) the ' +
        'rank/search/tag params compose with; Next.js Metadata API + ' +
        '`opengraph-image` + `sitemap.ts` (the SEO/GEO surface).\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + § colour/shape tokens; the i18n ' +
        'threading pattern.',
      dependsOn: ['6.13.1', '6.13.3', '6.13.4'],
    },
    {
      id: '6.13.7',
      title:
        'Tests (vitest) — directory lists ONLY public projects cross-org; ranking + search/filter correctness; cursor pagination',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        'Lock the load-bearing guarantees: (1) the directory lists ONLY ' +
        'public projects cross-org (non-public excluded), (2) each rank orders ' +
        'correctly + deterministically, (3) search + category/tag filter are ' +
        'correct, and (4) pagination skips/duplicates no row. On a real ' +
        'Postgres (the standing rule), covering:\n\n' +
        '- **Public-only, cross-org.** Seed public + non-public ' +
        '(private/open/limited) projects across MULTIPLE orgs. Assert the ' +
        'directory returns every PUBLIC project (including from orgs the ' +
        'requesting account has no membership in) and EXCLUDES every ' +
        'non-public project for every viewer; assert the card projection ' +
        'payload contains ONLY name + org + the three stats + description and ' +
        'NO internal project field. Assert an UNAUTHENTICATED (no-session) ' +
        'request SUCCEEDS and returns the same public list (the page is fully ' +
        'public — there is no account gate to reject it).\n' +
        '- **Ranking.** With timestamped seed votes/activity: Trending orders ' +
        'by recent (windowed) signal (a fresh upvote burst lifts a project ' +
        'above a higher-lifetime-but-stale one); Popular orders by lifetime ' +
        'totals; Recent orders by made-public time. Assert each rank is a ' +
        'DETERMINISTIC total order (stable id tiebreak — the same input yields ' +
        'the same order twice).\n' +
        '- **Search + category/tag.** A name/description query returns only ' +
        'matching public projects; a category/tag filter returns only public ' +
        'projects with that tag; search + tag + the rank tab COMPOSE; the ' +
        'tag-facet counts only public projects. No user string reaches SQL ' +
        'unparameterized (the 6.1.1 injection posture, extended to the ' +
        'directory search).\n' +
        '- **Cursor pagination.** Paging each rank past a page boundary ' +
        'returns every row exactly once (no skip, no duplicate) over the ' +
        'keyset cursor; the read is bounded (not load-all).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The public-only-cross-org guarantee is asserted (every public ' +
        'project listed, every non-public excluded, the projection leaks no ' +
        'internal field, an unauthenticated request succeeds — fully public).\n' +
        '- Each rank’s ordering + determinism, the search + category/tag ' +
        'filter correctness + composition, the tag-facet public-only count, ' +
        'and the cursor no-skip/no-dupe pagination are each asserted.\n' +
        '- New service/repository code respects the per-file coverage gate ' +
        '(CLAUDE.md § coverage); the empty-directory / empty-search / ' +
        'empty-category guards each have a direct test; tests use the real ' +
        'Postgres helper.\n\n' +
        '## Context refs\n\n' +
        '- 6.13.2 (the directory + projection + cursor), 6.13.3 (search + ' +
        'category/tag), 6.13.4 (the ranks), 6.13.5 (the tag-facet count).\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + the per-file ' +
        'coverage gate.\n' +
        '- `motir-core/tests/helpers/db.ts` — the per-test truncation ' +
        'harness.',
      dependsOn: ['6.13.2', '6.13.4'],
    },
    {
      id: '6.13.8',
      title:
        'E2E (playwright) — browse the public project square LOGGED OUT, search + sort by trending, click a card → its public read-only view',
      status: 'blocked',
      type: 'e2e',
      executor: 'coding_agent',
      estimateMinutes: 50,
      descriptionMd:
        '**Type:** e2e (playwright) — the full discovery loop in a browser, ' +
        '**logged out**: browse the public square, search + sort by trending, ' +
        'and click a card through to its public read-only view, proving the ' +
        'discovery → view handoff end to end without a session.\n\n' +
        'The flow:\n\n' +
        '1. Seed several public projects across MORE THAN ONE org (varied ' +
        'upvotes / viewers / activity + made-public times) and at least one ' +
        'non-public project. Do NOT sign in — visit as an anonymous ' +
        '(logged-out) visitor.\n' +
        '2. Navigate directly to `/explore` (the public page — there is NO ' +
        'app left-nav entry) → the gallery of project CARDS renders (name / ' +
        'org / description / the three stats, NO "Public" pill) for the public ' +
        'projects across orgs; assert a seeded non-public project is ABSENT, ' +
        'and assert the page exposes the SEO surface (a single `<h1>`, a ' +
        'JSON-LD `application/ld+json` script).\n' +
        '3. Switch to the **Trending** sort tab → assert the order reflects ' +
        'recent demand (the project given the fresh upvote burst is near the ' +
        'top); then type a **search** query → the gallery narrows to matching ' +
        'public projects; pick a **category/tag** → it narrows to that topic. ' +
        'Confirm the URL carries the rank + search + tag (reload restores the ' +
        'state).\n' +
        '4. **Click a card** → it lands on that project’s 6.12.4 public ' +
        'read-only view (the board / issues / public roadmap); assert there ' +
        'are NO edit affordances and that internal fields (assignee / estimate ' +
        '/ internal comments) are absent — the 6.12 projection still holds ' +
        'through the discovery entry. **NB (knock-on):** under the current 6.12 ' +
        'model the 6.12.4 view is still account-required, so the logged-out ' +
        'click-through would hit a sign-in redirect — this step assumes the ' +
        '6.12-side anonymous revision flagged in the header lands first; until ' +
        'then assert the redirect, not the view.\n\n' +
        'Mind the prodect e2e selector + harness gotchas (combobox option = ' +
        'label + secondary; exact/level on heading selectors; the empty-state ' +
        'headings; run the dev server yourself + reuse it). Drive the real UI, ' +
        'not API shortcuts.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The square opens at `/explore` for a LOGGED-OUT visitor (no app ' +
        'left-nav entry) and renders the cross-org card gallery (no "Public" ' +
        'pill); a seeded non-public project is absent; the SEO surface (single ' +
        '`<h1>` + JSON-LD) is present.\n' +
        '- Sorting by Trending reflects recent demand; a search query + a ' +
        'category/tag each narrow the gallery; the rank + search + tag are in ' +
        'the URL (reload restores state).\n' +
        '- Clicking a card lands on the project’s 6.12.4 public view with no ' +
        'edit affordances + internal fields absent (the projection holds ' +
        'through discovery).\n' +
        '- The test drives the real UI (no API-only shortcuts) and follows the ' +
        'prodect E2E selector + run-harness conventions.\n\n' +
        '## Context refs\n\n' +
        '- 6.13.6 (the square UI driven) — the gallery + tabs + search/filter ' +
        '+ the card link; 6.13.2/6.13.3/6.13.4 exercised through it.\n' +
        '- `scripts/plan-seed/data/story-6.12.ts` § 6.12.10 — the public-view ' +
        'e2e whose harness + selectors this builds on (the card click lands in ' +
        'the 6.12.4 view it drives).\n' +
        '- `motir-core/e2e/` — the existing Playwright specs + the ' +
        'run-harness + selector conventions to mirror.',
      dependsOn: ['6.13.6'],
    },
  ],
};
