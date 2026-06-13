import type { PlanStory } from '../types';

/**
 * Story 7.7 — GitHub integration + status sync + review loop + code-graph feed.
 * The LAST infra story of Epic 7: it turns the loop the planner generates
 * (7.3/7.4 trees → 7.6 dispatch → a coding agent → a PR) into a CLOSED loop —
 * a PR merging flips its work item's status, CI feedback flows back to the
 * subtask, and (the load-bearing piece) the repo's CODE GRAPH stays fresh from
 * GitHub instead of a local file-watcher. This is what makes augment/expand/
 * re-plan (7.4) reason over the code that actually shipped.
 *
 * **Ships as a GitHub APP installation, not an OAuth app — and that is two
 * SEPARATE grants (verified against GitHub's docs, not asserted).** A GitHub
 * App separates *who you are* from *what the app may touch*:
 *
 *   1. **OAuth / user authorization = IDENTITY.** The user authorizes the Motir
 *      App to act on their behalf; this is how we learn WHICH GitHub user a
 *      Motir member is (the login → member binding) and get a user access
 *      token whose reach is the INTERSECTION of the app's perms and that user's
 *      own perms. It grants no repo access by itself.
 *   2. **App INSTALLATION = REPO ACCESS.** The org/owner *installs* the App and
 *      picks the repositories it may touch ("only select repositories"). The
 *      installation mints a short-lived INSTALLATION ACCESS TOKEN scoped to
 *      exactly those repos and the app's permissions — and only those. You can
 *      install without authorizing and authorize without installing; they are
 *      independent (GitHub: "Differences between GitHub Apps and OAuth apps").
 *
 *   We model both as DISTINCT entities + token stores (7.7.3): a user-identity
 *   binding from the OAuth grant, and an Installation (with its selected repos
 *   + a per-call-minted installation token) from the install grant. This is the
 *   exact shape CodeRabbit uses — install the App, pick repos, it reads via the
 *   installation token, posts review via its write scopes (verified).
 *
 * **Permission posture (verified).** Selecting `contents: read` auto-grants the
 * mandatory `metadata: read`; we add `pull_requests` + `checks` (read for the
 * status/CI loop, write only where the loop posts back), and subscribe to the
 * `installation`, `push`, `pull_request`, and `check_suite`/`check_run`
 * webhooks. Least privilege: we do NOT take `contents: write` — Motir never
 * pushes code; the AI never writes the repo any more than it writes the plan
 * tree (the Epic-7 one-directional-writes invariant, extended to code).
 *
 * **This story OWNS the code-graph FEED (7.7.5).** Story 7.5.4 stood up the
 * `CodeGraph` interface + embedded `colbymchenry/codegraph` as a library +
 * stored the per-tenant SQLite graph in motir-ai, indexed from a LOCAL FIXTURE
 * for dev/test. codegraph's normal refresh path is a NATIVE OS FILE-WATCHER
 * (FSEvents/inotify, 2s debounce) over a checkout on the developer's disk
 * (verified) — which does not exist for a HOSTED, server-side, per-tenant store
 * where the repo lives on GitHub. 7.7.5 replaces that watcher: on install +
 * every push/PR webhook, motir-core fetches the repo at the event's ref via the
 * INSTALLATION token and drives 7.5.4's indexer to (re)build/refresh that
 * tenant's graph. That inverts codegraph's "100% local, nothing leaves your
 * machine" default into a CodeRabbit-style hosted-AI-reads-your-repo model — so
 * 7.7.5 carries the retention posture explicitly (index, don't durably retain
 * raw source; the privacy line CodeRabbit advertises and Motir matches).
 *
 * **The closed loop (the review + verification half).** 7.7.4 maps PR lifecycle
 * webhooks to work-item `workflow_status` transitions through the SHIPPED
 * `workItemsService` (the AI/integration never writes status raw — same
 * write-authority rule as the plan delta): `pull_request opened` → in-review,
 * `closed` with `merged: true` → done, `closed` unmerged → back to in-progress.
 * 7.7.6 closes the verification side: `check_suite`/`check_run` (CI) results
 * become a comment + a blocked/ready signal on the linked subtask, so a Story's
 * "did the dispatched work actually pass?" lives in Motir, not only on GitHub.
 *
 * **Design gate fires (AREA `design/github/`).** This story adds real
 * user-facing surfaces — the connect/settings flow, repo selection, the
 * per-issue PR/CI status surface — so 7.7.1 produces the design asset FIRST and
 * every UI code subtask (7.7.7) depends on it and is `blocked` until it lands.
 *
 * **Cross-story dep audit (notes.html #32): PASSES.** Backward/sideways only —
 * 7.7 depends on same-story 7.7.x, on 7.5.4 (the codegraph store it feeds), on
 * 7.6 (the dispatch→PR loop it closes), on the 7.1.x boundary, and on the
 * SHIPPED `workItemsService`. No forward-pointing dep (every upstream story
 * number ≤ 7.7). The manual GitHub-App registration (7.7.2) and the design
 * (7.7.1) have empty `dependsOn` → `planned`; everything else chains behind
 * them or behind not-yet-done upstream ids → `blocked`.
 */
export const story_7_7: PlanStory = {
  id: '7.7',
  title: 'GitHub integration + status sync + review loop + code-graph feed',
  status: 'planned',
  gitBranch: 'feat/PROD-7.7-github-integration',
  descriptionMd:
    'Connect a project to GitHub as a **GitHub App installation** and close ' +
    'the Epic-7 loop: a dispatched coding agent opens a PR → the linked work ' +
    "item's status syncs → CI results flow back to the subtask → and the " +
    "repo's CODE GRAPH refreshes from GitHub so the planner reasons over the " +
    'code that actually shipped. This is the last infra story; it makes the ' +
    'generate → dispatch (7.6) → PR → verify cycle a real closed loop instead ' +
    'of a one-way hand-off.\n\n' +
    '**Ships as a GitHub App, and that is TWO separate grants** (verified ' +
    'against GitHub docs — see the module header):\n\n' +
    '- **OAuth (user authorization) = IDENTITY.** Binds a Motir member to ' +
    'their GitHub user (who opened/merged a PR) and yields a user access ' +
    "token scoped to the intersection of the app's and the user's perms. No " +
    'repo access on its own.\n' +
    '- **App INSTALLATION = REPO ACCESS.** The owner installs the Motir App ' +
    'and picks the repositories ("only select repositories"); the install ' +
    'mints a short-lived **installation access token** scoped to exactly ' +
    'those repos + the app permissions. This is the credential every repo ' +
    'read (PR metadata, the code-graph fetch) runs under — never the ' +
    "user's.\n\n" +
    '**Permissions (least privilege, verified).** `contents: read` (auto-' +
    'grants the mandatory `metadata: read`) + `pull_requests` + `checks`; ' +
    'webhooks `installation`, `push`, `pull_request`, `check_suite`/' +
    '`check_run`. **No `contents: write`** — Motir never pushes code; the AI ' +
    'never writes the repo, the same one-directional-writes invariant the ' +
    'plan-delta obeys.\n\n' +
    '**This story OWNS the code-graph FEED.** 7.5.4 built the `CodeGraph` ' +
    'interface + embedded `colbymchenry/codegraph` + stored the per-tenant ' +
    'SQLite graph in motir-ai, indexed from a LOCAL FIXTURE. codegraph ' +
    'normally refreshes via a native OS FILE-WATCHER over a local checkout ' +
    '(verified) — which does not exist for a hosted, server-side store. ' +
    '**7.7.5 replaces that watcher**: on install + every push/PR webhook, ' +
    'fetch the repo at the event ref via the installation token and drive ' +
    "7.5.4's indexer to (re)build/refresh that tenant's graph — the " +
    'CodeRabbit-style hosted-AI-reads-your-repo model, with an explicit ' +
    'index-not-retain retention posture.\n\n' +
    '**Scope:** the design asset for the GitHub surfaces (7.7.1); the manual ' +
    'GitHub-App registration + secrets (7.7.2); the OAuth-identity + ' +
    'App-installation model with repo/branch/PR entities + installation-token ' +
    'storage (7.7.3); webhooks → status sync (7.7.4); the code-graph feed ' +
    '(7.7.5); the Story-level verification + CI feedback loop (7.7.6); the ' +
    'connect/settings + repo-selection UI (7.7.7); the test suite (7.7.8); ' +
    'and the connect→PR→sync E2E (7.7.9).\n\n' +
    '**Out of scope (named so they land elsewhere, not here):** the ' +
    'code-graph STORE + interface + query tools themselves (7.5.4 / 7.5.5 — ' +
    '7.7 feeds them, it does not build them); prompt generation + dispatch ' +
    '(7.6 — 7.7 closes the loop dispatch opens); GitLab/Bitbucket providers ' +
    '(a future provider-interface extension — 7.7 ships GitHub, but 7.7.3 ' +
    'models the entities so a second provider is additive, not a re-shape); ' +
    'and pushing code / opening PRs FROM Motir (deliberately excluded — Motir ' +
    'reads, the agent writes).',
  verificationRecipeMd:
    '- **Provisioning (7.7.2) first.** The Motir GitHub App is registered ' +
    '(App id, the `contents:read`+`metadata`+`pull_requests`+`checks` perms, ' +
    'the `installation`/`push`/`pull_request`/`check_suite` webhook ' +
    'subscriptions, the webhook secret, the private key) and its credentials ' +
    'are wired into both deployments — Yue confirms (no PR).\n' +
    '- Pull the Story branch, `pnpm install`, `pnpm prisma generate`, ' +
    '`pnpm migrate`, `pnpm dev` (motir-core) + the motir-ai dev server.\n' +
    '- **Connect flow (the two grants).** Sign in as `zhuyue@motir.co`, open ' +
    'Settings → GitHub. Authorize (OAuth → your GitHub identity is bound) ' +
    'AND install the App on a test repo with "only select repositories". ' +
    'Confirm the settings surface shows the bound identity, the installation, ' +
    'and the selected repo list; an installation token is minted on demand ' +
    '(never stored long-lived) and scoped to ONLY the selected repos.\n' +
    '- **Status sync (the loop).** Link a work item to the test repo. Open a ' +
    'PR that references the item key → the item moves to in-review. Merge the ' +
    'PR → the item moves to done. Open + close-without-merge another PR → the ' +
    'item returns to in-progress. Each transition went through ' +
    '`workItemsService` (status was never written raw) and is reflected in ' +
    'the issue activity log.\n' +
    '- **CI feedback (verification half).** Let CI run on the PR → the ' +
    'linked subtask shows the check result (a comment + a ready/blocked ' +
    'signal); a failed check surfaces on the subtask, not only on GitHub.\n' +
    '- **Code-graph feed.** Push a commit to a connected repo (or install ' +
    'fresh) → a push/installation webhook drives a code-graph (re)index in ' +
    'motir-ai; query a code-graph tool (7.5.5) and confirm the new symbol is ' +
    'present. Confirm raw source is NOT durably retained after indexing (the ' +
    'retention posture).\n' +
    '- `pnpm test` (both repos) — 7.7.8 covers the installation model, ' +
    'webhook signature verification, the PR→status state machine, and the ' +
    'feed refresh.\n' +
    '- `pnpm test:e2e github` — 7.7.9 drives connect → open a PR → the linked ' +
    "issue's status syncs, from a user's seat.\n" +
    "- **Open-core boundary review (this Epic's recurring posture).** The " +
    'GitHub OAuth + installation + webhook + status-sync code lives in ' +
    '**motir-core** (it writes the plan-tree status through `workItemsService` ' +
    '— core is the write authority); the code-graph INDEX lives in ' +
    '**motir-ai** (its store). motir-core hands the fetched repo bytes to ' +
    'motir-ai over the 7.1 boundary; motir-ai holds no GitHub credential and ' +
    'no connection to core’s DB. Browsers never call motir-ai.\n' +
    '- If every step holds, approve and merge the Story PR. If anything ' +
    "fails, comment with what didn't work and Motir will produce a follow-up " +
    'Subtask under the same Story.',
  items: [
    {
      id: '7.7.1',
      title: 'Design — GitHub connect/settings + repo selection + PR/CI status surfaces',
      status: 'planned',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 40,
      descriptionMd:
        '**Type:** design (planning-time design gate, Principle #13 + the ' +
        'design-reference rule). Every UI-touching subtask in this Story ' +
        '(7.7.7 — the connect/settings UI) depends on this one; without it the ' +
        'GitHub surfaces would be improvised, which is forbidden (notes.html ' +
        '#31).\n\n' +
        'Produce the design asset for the **GitHub** surfaces under ' +
        '`motir-core/design/github/`. Author it as a **`*.mock.html` mockup** ' +
        'built from the real design system (the `components/ui/*` primitives + ' +
        'the `--el-*` colour tokens + the `[data-display-style]` shape tokens) ' +
        '— NOT a `.pen`. The HTML route is preferred when a coding agent ' +
        'produces the design (no Pencil→code translation gap; the reviewer ' +
        'sees the actual tokens). The `.mock.html` is the source of truth ' +
        '(MOTIR.md § Design-reference rule).\n\n' +
        '**Surfaces to draw** (multi-panel board, EVERY panel — the ' +
        'multi-panel rule, mistake #31):\n\n' +
        '- **Panel 1 — Settings → GitHub, NOT yet connected.** Explains the ' +
        'TWO grants in plain language (authorize Motir to know your GitHub ' +
        'identity; install the Motir App to pick which repos it may read) ' +
        'with the primary "Connect GitHub" CTA. Make the distinction legible ' +
        '— a first-time user must understand identity-vs-repo-access (the ' +
        'verified GitHub-App model). Reuse the shipped `Button` + a `Card` ' +
        'callout.\n' +
        '- **Panel 2 — connected, the repo-selection list.** Shows the bound ' +
        'GitHub identity (avatar + login), the installation, and the list of ' +
        'repositories the App may access ("only select repositories"), each ' +
        'with a connect/disconnect toggle and its sync state. A "Manage on ' +
        'GitHub" link out (repo selection is ultimately changed on GitHub’s ' +
        'install screen — mirror that honestly rather than faking in-app repo ' +
        'granting). Rows use the small-affordance shape tokens ' +
        '(`--radius-control`).\n' +
        '- **Panel 3 — a work item’s PR/CI status surface.** On the issue ' +
        'detail (peek), a section showing the linked PR(s): PR title + number, ' +
        'a `Pill` for PR state (open / merged / closed) in the right ' +
        '`--el-*` tone family, and the CI check summary (passing / failing / ' +
        'running) as a second `Pill`. This is where the closed loop becomes ' +
        'visible to a human.\n' +
        '- **Panel 4 — empty / no-repo-linked + error states.** The issue ' +
        'with no linked PR (quiet empty copy), and the settings error state ' +
        'when an installation was revoked on GitHub (the App was uninstalled ' +
        'out-of-band) — reuse the shipped `EmptyState` + a danger callout via ' +
        '`--el-danger`.\n\n' +
        'Also write **`design/github/design-notes.md`** naming the exact ' +
        'primitives used per surface, the exact copy strings (especially the ' +
        'two-grants explanation), the placement decisions, the per-`--el-*` ' +
        'colour role for each element (PR-state pill tones; the danger ' +
        'callout), and a "primitives composed (no hand-rolling)" checklist ' +
        '(the `design-notes.md` convention 1.3.3 / 1.5.1 established).\n\n' +
        '**Branch.** `design/PROD-7.7.1-github-surfaces`. The `design/*` ' +
        'prefix gate skips CI E2E + the Vercel preview deploy (per MOTIR.md ' +
        '§ Plan seed Workflow) — this PR only edits `design/github/**`, no ' +
        'app code.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `motir-core/design/github/github.mock.html` exists, renders the ' +
        'four panels above side-by-side, references ONLY `--el-*` colour ' +
        'tokens + `[data-display-style]` shape tokens (no Tier-0 `--color-*`, ' +
        'no hand-rolled spacing — the `motir-core/CLAUDE.md` § colour / shape ' +
        'rules).\n' +
        '- `motir-core/design/github/design-notes.md` exists, names every ' +
        'primitive composed + every copy string (incl. the two-grants ' +
        'explanation) + the per-element `--el-*` role.\n' +
        '- The mockup composes ONLY shipped primitives (`Card`, `Pill`, ' +
        '`Button`, `EmptyState`, the avatar primitive, the settings-section ' +
        'layout) — no new design-system entries invented inside this Story ' +
        '(if one would be needed, that is a NEW `design/` subtask, not a code ' +
        'workaround).\n\n' +
        '## Context refs\n\n' +
        '- `motir-core/design/projects/` (or the closest settings-area ' +
        'mockup) — mirror its layout + `design-notes.md` shape.\n' +
        '- `motir-core/components/ui/Pill.tsx` — the PR-state + CI-state ' +
        'pills.\n' +
        '- `motir-core/components/ui/EmptyState.tsx` — Panel 4.\n' +
        '- `motir-core/app/globals.css` — `--el-*` colour tokens + ' +
        '`[data-display-style]` shape tokens (the swap layer the mockup must ' +
        'reference).\n' +
        '- GitHub docs "Differences between GitHub Apps and OAuth apps" — the ' +
        'two-grants model the connect copy must explain correctly.',
      dependsOn: [],
    },
    {
      id: '7.7.2',
      title: 'Register the Motir GitHub App + secrets (manual)',
      status: 'planned',
      type: 'manual',
      executor: 'human',
      estimateMinutes: 35,
      descriptionMd:
        '**Type:** manual/human (no PR — GitHub dashboard / secret work, ' +
        'mirror 1.6.7 + the 7.1.2 provisioning shape; marked done on Yue’s ' +
        'confirmation). A coding agent cannot register a GitHub App, generate ' +
        'its private key, or set a webhook secret. Wired here via `dependsOn` ' +
        'so the prerequisite is visible at PLAN time (notes.html #30), not ' +
        'discovered at run time — and it has NO dependency itself, so it is ' +
        '`planned` and can be done immediately, in parallel with the design.\n\n' +
        'Create the **Motir GitHub App** (GitHub → Settings → Developer ' +
        'settings → GitHub Apps → New). It MUST be a GitHub App (not a classic ' +
        'OAuth app) so the two-grants model holds (verified: only a GitHub App ' +
        'gives per-repo installation selection + installation tokens):\n\n' +
        '1. **Identity / OAuth.** Enable "Request user authorization (OAuth) ' +
        'during installation" so the user-identity grant is available; set the ' +
        'callback URL to motir-core’s `GET /api/github/oauth/callback`.\n' +
        '2. **Permissions (least privilege, verified).** Repository ' +
        'permissions: `Contents: Read-only` (this auto-adds the mandatory ' +
        '`Metadata: Read-only`), `Pull requests: Read & write` (read PRs for ' +
        'the loop; write only to post the verification comment), `Checks: ' +
        'Read-only`. Do NOT request `Contents: Read & write` — Motir never ' +
        'pushes code.\n' +
        '3. **Webhooks.** Subscribe to `installation` / ' +
        '`installation_repositories` (track which repos are selected), `push` ' +
        '+ `pull_request` (status sync + code-graph feed triggers), and ' +
        '`check_suite` / `check_run` (CI feedback). Set the webhook URL to ' +
        'motir-core’s `POST /api/github/webhook` and generate a strong ' +
        '**webhook secret** (for the `X-Hub-Signature-256` HMAC check 7.7.4 ' +
        'enforces).\n' +
        '4. **Private key.** Generate the App private key (used to mint ' +
        'installation tokens) and the App id / client id+secret.\n' +
        '5. **Wire env** on motir-core: `GITHUB_APP_ID`, ' +
        '`GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_ID`, ' +
        '`GITHUB_APP_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET` (the exact key ' +
        'names are fixed by 7.7.3 and listed in its `.env.example`).\n\n' +
        '## Acceptance criteria\n\n' +
        '- The Motir GitHub App exists with EXACTLY the permissions above ' +
        '(contents:read + the auto metadata:read, pull_requests:read/write, ' +
        'checks:read) and the four webhook subscriptions, pointed at ' +
        'motir-core’s callback + webhook URLs.\n' +
        '- The webhook secret + private key + client credentials are minted ' +
        'and set on the motir-core deployment (and the local `.env` for dev) ' +
        'under the key names 7.7.3 fixes.\n' +
        '- The OAuth callback + webhook URLs match the routes 7.7.3 / 7.7.4 ' +
        'register.\n' +
        '- Yue confirms; Motir marks the subtask done (no PR).\n\n' +
        '## Context refs\n\n' +
        '- 7.7.3’s `.env.example` (the canonical env-key names this sets).\n' +
        '- `motir-core` Vercel/Neon provisioning (1.6.7) + 7.1.2 — the ' +
        'precedent shape for dashboard + secret wiring.\n' +
        '- GitHub docs "Choosing permissions for a GitHub App" (contents:read ' +
        'auto-grants metadata:read) + "Registering a GitHub App".',
      dependsOn: [],
    },
    {
      id: '7.7.3',
      title:
        'GitHub OAuth identity + App installation model — repo/branch/PR entities + installation-token store',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 75,
      descriptionMd:
        'Build the motir-core side of the connection: the TWO grants as ' +
        'distinct entities + the data model the rest of the Story hangs off. ' +
        'This is the foundation — 7.7.4 (status sync), 7.7.5 (feed), 7.7.6 ' +
        '(CI), 7.7.7 (UI) all read it. 4-layer throughout ' +
        '(Route→Service→Repository→Prisma, `motir-core/CLAUDE.md`).\n\n' +
        '**Grant 1 — OAuth user identity.** `GET /api/github/oauth/start` ' +
        '→ GitHub authorize redirect; `GET /api/github/oauth/callback` ' +
        'exchanges the code for a user access token, reads the GitHub user, ' +
        'and binds it to the Motir member: a `GithubIdentity` ' +
        '`{ id, userId (motir user), githubUserId, githubLogin, ' +
        'avatarUrl, accessToken (encrypted), createdAt }`. This grant is ' +
        'IDENTITY only — it grants no repo access (verified GitHub-App model).\n\n' +
        '**Grant 2 — App installation.** The owner installs the App on ' +
        'GitHub and picks repos; the `installation` webhook (handled in ' +
        '7.7.4) creates a `GithubInstallation` ' +
        '`{ id, installationId, workspaceId, accountLogin, accountType, ' +
        'createdAt }` and its selected `GithubRepo` rows ' +
        '`{ id, installationId, repoId, owner, name, defaultBranch }`. The ' +
        'installation token is **minted on demand** from the App private key ' +
        '(short-lived, scoped to the installation’s repos) — NEVER stored ' +
        'long-lived; cache in-memory until just-before expiry and re-mint ' +
        '(verified: installation tokens are short-lived and repo-scoped). A ' +
        '`lib/github/appAuth.ts` leaf primitive mints + caches them (like ' +
        '`lib/email.ts`; services import it, routes never do).\n\n' +
        '**Link entities (for the loop).** `GithubPullRequest` ' +
        '`{ id, repoId, number, state, merged, headRef, workItemId?, ' +
        'updatedAt }` — the PR→work-item link the status sync (7.7.4) + CI ' +
        'loop (7.7.6) drive; nullable `workItemId` until a PR references an ' +
        'item key. Model the repo→installation→PR FKs as Prisma ' +
        '`@relation`s on BOTH sides (the `motir-core/CLAUDE.md` migration rule ' +
        '— never raw-SQL-only FKs, or `migrate dev` drifts).\n\n' +
        '**Provider seam (durable shape, no shortcut).** Name the entities ' +
        '`Github*` but route reads through a thin `gitProvider` service ' +
        'abstraction so a future GitLab/Bitbucket provider is ADDITIVE, not a ' +
        're-shape (the no-single-FK-shortcut / durable-shape rule). Scope ' +
        'this story to GitHub; just don’t paint a second provider into a ' +
        'corner.\n\n' +
        'Add `.env.example` keys `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, ' +
        '`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, ' +
        '`GITHUB_WEBHOOK_SECRET` (the inventory 7.7.2 provisions). Tokens at ' +
        'rest (the OAuth user token) are encrypted, not plaintext.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The OAuth start/callback routes complete the user-identity grant ' +
        'and persist a `GithubIdentity` bound to the Motir member; the user ' +
        'token is stored encrypted.\n' +
        '- The installation + selected-repo entities + the ' +
        '`GithubPullRequest` link entity exist with Prisma `@relation`s on ' +
        'both sides; `pnpm migrate` runs clean and `migrate dev` reports "No ' +
        'difference detected" (no FK drift).\n' +
        '- An installation token is minted on demand from the private key, ' +
        'scoped to the installation’s repos, cached until near-expiry, and ' +
        'NEVER persisted long-lived.\n' +
        '- The two grants are independent: a member can have an identity with ' +
        'no installation and an installation with no bound identity (no ' +
        'crash, the UI shows each state).\n' +
        '- 4-layer respected: routes call one service method; ' +
        '`appAuth.ts` is a leaf primitive; repositories are single-op; writes ' +
        'take `tx`. `.env.example` lists the five GitHub keys.\n\n' +
        '## Context refs\n\n' +
        '- 7.7.1 (the surfaces this backs), 7.7.2 (the App + the env keys).\n' +
        '- `motir-core/lib/email.ts` — the leaf-primitive pattern for ' +
        '`appAuth.ts`.\n' +
        '- `motir-core/lib/auth/index.ts` — the existing OAuth/session ' +
        'wiring to stay consistent with.\n' +
        '- `motir-core/CLAUDE.md` § 4-layer + § migrations (FK = @relation ' +
        'both sides).\n' +
        '- GitHub docs "Generating an installation access token" + ' +
        '"Authenticating as a GitHub App installation" (short-lived, ' +
        'repo-scoped) + "Differences between GitHub Apps and OAuth apps" (the ' +
        'two grants).',
      dependsOn: ['7.7.1', '7.7.2'],
    },
    {
      id: '7.7.4',
      title: 'Webhooks → issue status sync (PR opened/merged/closed → workflow_status)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 65,
      descriptionMd:
        'The inbound webhook endpoint + the PR→status state machine — the ' +
        'first half of the closed loop. `POST /api/github/webhook` (4-layer: ' +
        'route verifies + dispatches; a `githubWebhookService` owns the ' +
        'logic; all writes go through the SHIPPED `workItemsService` — the ' +
        'integration NEVER writes `workflow_status` raw, the same write-' +
        'authority rule the plan delta obeys).\n\n' +
        '**Signature verification FIRST.** Every delivery carries an ' +
        '`X-Hub-Signature-256` HMAC (verified) computed with the ' +
        '`GITHUB_WEBHOOK_SECRET`; reject any request whose signature does not ' +
        'match (401) BEFORE parsing the body. The event type is in the ' +
        '`X-GitHub-Event` header; the sub-action is in the payload `action` ' +
        'field.\n\n' +
        '**`installation` / `installation_repositories`** → create/update/' +
        'remove the `GithubInstallation` + selected `GithubRepo` rows from ' +
        '7.7.3 (the install grant’s server-side landing; the UI never grants ' +
        'repos itself — GitHub does, we mirror it).\n\n' +
        '**`pull_request`** → the status sync state machine. Resolve the ' +
        'PR’s linked work item (parse the PR title/body for a `PROD-<n>` ' +
        'key, or an explicit link from 7.7.7); upsert the `GithubPullRequest` ' +
        'row; then map the lifecycle to a `workflow_status` transition via ' +
        '`workItemsService` (verified payload shapes — `action: opened`, and ' +
        '`action: closed` with the boolean `merged` distinguishing merge from ' +
        'plain close):\n\n' +
        '- `opened` / `reopened` → the item’s status → **in-review**.\n' +
        '- `closed` with `merged: true` → **done** (a merge is the strongest ' +
        'completion signal).\n' +
        '- `closed` with `merged: false` → back to **in-progress** (the work ' +
        'was abandoned, not finished).\n\n' +
        'Each transition respects the project’s configured workflow ' +
        '(`lib/workflows`) — map to the right status KEY by category, never a ' +
        'hard-coded id, and skip the transition (logging a no-op) when the ' +
        'target workflow has no matching status, so a custom workflow ' +
        'doesn’t crash the webhook. The transition is recorded in the issue ' +
        'activity log AS the bound GitHub identity’s Motir user where known ' +
        '(else a system actor).\n\n' +
        '**Idempotency + delivery.** GitHub may redeliver; the handler is ' +
        'idempotent (re-applying a transition that already holds is a no-op). ' +
        'Return `2xx` fast (verify + enqueue/handle); a slow handler makes ' +
        'GitHub retry.\n\n' +
        '## Acceptance criteria\n\n' +
        '- A delivery with a bad/missing `X-Hub-Signature-256` is rejected ' +
        '401 before body parsing; a valid one is processed.\n' +
        '- `pull_request opened` on a PR referencing `PROD-<n>` moves that ' +
        'item to in-review (via `workItemsService`, recorded in the activity ' +
        'log); `closed`+`merged:true` → done; `closed`+`merged:false` → ' +
        'in-progress.\n' +
        '- `installation` / `installation_repositories` events keep the ' +
        'installation + selected-repo rows in sync (add on install, remove on ' +
        'uninstall).\n' +
        '- A custom project workflow with no matching status key logs a no-op ' +
        'instead of crashing; the transition uses the status KEY by category, ' +
        'never a hard-coded id.\n' +
        '- The handler is idempotent under redelivery and no status is ever ' +
        'written outside `workItemsService` (verified: no raw Prisma status ' +
        'write in the webhook path).\n\n' +
        '## Context refs\n\n' +
        '- 7.7.3 (the installation + PR-link entities + the env secret).\n' +
        '- `motir-core/lib/services/workItemsService.ts` — the status-' +
        'transition authority every sync goes through.\n' +
        '- `motir-core/lib/workflows/defaultWorkflow.ts` — the status KEYs / ' +
        'categories to map onto (in-review / done / in-progress).\n' +
        '- GitHub docs "Webhook events and payloads" (`pull_request` action + ' +
        'the `merged` boolean) + "Validating webhook deliveries" ' +
        '(`X-Hub-Signature-256`).',
      dependsOn: ['7.7.3'],
    },
    {
      id: '7.7.5',
      title:
        'Code-graph FEED — fetch repo via installation token on install/push/PR → drive 7.5.4 indexer',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 80,
      descriptionMd:
        '**The piece this story OWNS** (motir-core + motir-ai). 7.5.4 built ' +
        'the `CodeGraph` interface, embedded `colbymchenry/codegraph` as a ' +
        'library, and stored the per-tenant SQLite graph in motir-ai — but ' +
        'indexed from a LOCAL FIXTURE. codegraph’s normal refresh is a ' +
        'native OS FILE-WATCHER (FSEvents/inotify, 2s debounce) over a local ' +
        'checkout (verified) — which **does not exist** for a hosted, ' +
        'server-side, per-tenant store whose repo lives on GitHub. This ' +
        'subtask replaces that watcher with a GITHUB-DRIVEN feed.\n\n' +
        '**The feed (the replacement watcher).** Triggered from 7.7.4’s ' +
        'webhook dispatch on:\n\n' +
        '- `installation` / `installation_repositories` added → INITIAL ' +
        'index of each newly-selected repo (the code graph "activates once ' +
        'code exists": migrate-project on connect; start-fresh after the first ' +
        'dispatch produces code).\n' +
        '- `push` to a connected repo’s default branch → incremental ' +
        'REFRESH at the pushed ref.\n' +
        '- `pull_request` (synchronize/merged) where useful → refresh so the ' +
        'planner reasons over what shipped.\n\n' +
        '**Mechanics.** motir-core fetches the repo at the event’s ref via ' +
        'the INSTALLATION token from 7.7.3 (a tarball/archive download or a ' +
        'shallow fetch — pick the cheapest the API allows; scope to the ' +
        'pushed paths for the incremental case where codegraph’s ' +
        'incremental-sync supports it), then hands the bytes to motir-ai over ' +
        'the 7.1 boundary, which drives 7.5.4’s indexer to (re)build/refresh ' +
        'that tenant’s SQLite graph. **The credential + fetch stay in ' +
        'motir-core** (it holds the GitHub grant); **the index + store stay ' +
        'in motir-ai** (its code-graph store) — the open-core boundary holds ' +
        '(motir-ai gets bytes, not a GitHub token).\n\n' +
        '**Retention posture (the CodeRabbit-style inversion, called out ' +
        'explicitly).** codegraph defaults to "100% local, nothing leaves ' +
        'your machine" (verified); a hosted feed inverts that into ' +
        'hosted-AI-reads-your-repo. So: index, do NOT durably retain raw ' +
        'source — the persistent artifact is the codegraph SQLite graph ' +
        '(symbols/edges/FTS), and any fetched checkout is transient (deleted ' +
        'after indexing). This matches CodeRabbit’s advertised "does not ' +
        'retain source after review" line (verified) and is the ' +
        'privacy/open-core posture for the hosted store.\n\n' +
        '**Scale + durability (no shortcut).** Re-indexing a large repo on ' +
        'every push must not block the webhook: the feed ENQUEUES a refresh ' +
        'job (debounce/coalesce rapid pushes, mirroring codegraph’s own ' +
        'debounce intent) and returns `2xx` fast; the index runs async in ' +
        'motir-ai (rides the 7.1.4 job substrate). Per-tenant isolation: one ' +
        'repo’s refresh never touches another tenant’s graph.\n\n' +
        '## Acceptance criteria\n\n' +
        '- On install of a repo, an initial code-graph index is built for ' +
        'that tenant from the installation-token fetch (no local fixture ' +
        'path); querying a 7.5.5 code-graph tool returns real symbols from ' +
        'that repo.\n' +
        '- A `push` to the default branch enqueues an incremental refresh; a ' +
        'newly-added symbol appears in the graph after the refresh completes.\n' +
        '- The fetch uses the INSTALLATION token (not the user token), scoped ' +
        'to the selected repo; motir-ai never receives a GitHub credential.\n' +
        '- Raw source is NOT durably retained — the only persisted artifact ' +
        'is the codegraph SQLite graph; the transient checkout is removed ' +
        'after indexing (verified in the test).\n' +
        '- Re-index runs async (enqueued, not inline in the webhook); rapid ' +
        'pushes are debounced/coalesced; the webhook returns `2xx` fast.\n' +
        '- Open-core boundary: the GitHub fetch + token live in motir-core; ' +
        'the index + store live in motir-ai; bytes cross the 7.1 boundary, ' +
        'not credentials.\n\n' +
        '## Context refs\n\n' +
        '- Story 7.5.4 — the `CodeGraph` interface + embedded codegraph + the ' +
        'per-tenant SQLite store this feed drives (replacing its fixture/' +
        'watcher path).\n' +
        '- Story 7.5.5 — the code-graph query tools used to verify a refresh.\n' +
        '- 7.7.3 (the installation token), 7.7.4 (the webhook dispatch this ' +
        'hangs off), 7.1.4 (the job substrate the async index rides).\n' +
        '- `colbymchenry/codegraph` docs — tree-sitter → SQLite+FTS5, the ' +
        'native file-watcher + 2s debounce this feed replaces, "100% local" ' +
        'default this inverts.\n' +
        '- GitHub docs "Generating an installation access token" + the repo ' +
        'archive/contents API (the fetch).',
      dependsOn: ['7.7.3', '7.5.4'],
    },
    {
      id: '7.7.6',
      title: 'Story-level verification + subtask CI feedback loop (check results → issue)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'The verification half of the closed loop: a dispatched subtask’s ' +
        'PR runs CI, and the result flows BACK to the linked work item so ' +
        '"did the dispatched work actually pass?" lives in Motir, not only on ' +
        'GitHub. Builds directly on 7.7.4 (the webhook endpoint + the ' +
        'PR→item link). 4-layer; writes (the feedback comment, the ' +
        'ready/blocked signal) go through `workItemsService`.\n\n' +
        '**CI events.** Handle `check_suite` / `check_run` deliveries (the ' +
        'webhook subscriptions 7.7.2 added): resolve the PR (head sha → ' +
        '`GithubPullRequest`) → the linked work item, then on a terminal ' +
        'conclusion:\n\n' +
        '- **CI passing** → post a "checks passing" note on the subtask + ' +
        'leave/advance the item toward done (the merge itself is the done ' +
        'transition from 7.7.4; this confirms the work is verifiable, not ' +
        'just merged).\n' +
        '- **CI failing** → post the failure summary (which checks failed + ' +
        'a link) as a comment on the subtask AND flip a "verification failed" ' +
        'signal so the item is visibly not-ready — the dispatched agent (or a ' +
        'human) sees the work needs another pass WITHOUT leaving Motir.\n\n' +
        '**Story-level rollup.** A Story’s verification state is the rollup ' +
        'of its subtasks’ CI signals — surface "N of M subtasks verified" on ' +
        'the Story (reuse the existing parent/child rollup the tree already ' +
        'computes; don’t invent a parallel aggregation). This is the ' +
        '"Story-level verification" the title names: a Story is done when its ' +
        'children merged AND their checks passed, not merely when they ' +
        'merged.\n\n' +
        '**Comment authorship + idempotency.** CI feedback comments are ' +
        'posted via `workItemsService` (a system/integration actor); ' +
        'redelivery or a re-run updates the existing feedback rather than ' +
        'piling duplicate comments (idempotent on (prSha, checkName)).\n\n' +
        '## Acceptance criteria\n\n' +
        '- A `check_suite` completed=success on a linked PR posts a passing ' +
        'note on the subtask; a failure posts the failed-checks summary + ' +
        'flips the subtask’s verification signal to not-ready.\n' +
        '- The Story shows a verified rollup ("N of M verified") computed from ' +
        'its subtasks’ CI signals via the EXISTING rollup, not a new ' +
        'aggregation path.\n' +
        '- Feedback comments are idempotent under redelivery / re-run (no ' +
        'duplicate spam) and go through `workItemsService`.\n' +
        '- A check event for a PR with no linked work item is a clean no-op.\n' +
        '- 4-layer respected; no raw status/comment write outside the ' +
        'service.\n\n' +
        '## Context refs\n\n' +
        '- 7.7.4 (the webhook endpoint + PR→item link this extends).\n' +
        '- `motir-core/lib/services/workItemsService.ts` — comments + ' +
        'status + the parent/child rollup the Story-level verification reuses.\n' +
        '- GitHub docs "Webhook events and payloads" (`check_suite` / ' +
        '`check_run` conclusion).\n' +
        '- Story 7.6 — the dispatch this verifies the result of (the loop’s ' +
        'other end).',
      dependsOn: ['7.7.4'],
    },
    {
      id: '7.7.7',
      title: 'GitHub connect/settings UI + repo selection',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 60,
      descriptionMd:
        'Build the user-facing GitHub surfaces EXACTLY as 7.7.1 specifies. ' +
        'This is the UI subtask the design gate guards — it depends on 7.7.1 ' +
        '(design) + 7.7.3 (the entities it renders) and is `blocked` until ' +
        'both land.\n\n' +
        '**Settings → GitHub** (`app/(authed)/settings/github/page.tsx`, ' +
        'Server Component reading the connection via a service): the ' +
        'not-connected panel with the two-grants explanation + "Connect ' +
        'GitHub" (kicks off the 7.7.3 OAuth start AND links to the App ' +
        'install), and the connected panel showing the bound identity, the ' +
        'installation, and the selected-repo list with per-repo connect/sync ' +
        'state + a "Manage on GitHub" link out (repo selection is changed on ' +
        'GitHub’s install screen — mirror that honestly, don’t fake in-app ' +
        'granting). The revoked-installation error state from 7.7.1 panel 4.\n\n' +
        '**Per-issue PR/CI surface** — on the issue detail (peek), the linked ' +
        'PR(s) section: PR title/number, a `Pill` for PR state (open/merged/' +
        'closed) and a `Pill` for CI state (passing/failing/running), reading ' +
        'the `GithubPullRequest` + CI signal. An item-to-PR explicit-link ' +
        'affordance (so a PR that doesn’t name the key in its title can be ' +
        'linked by hand) feeding 7.7.4’s resolver.\n\n' +
        '**Tokens + i18n.** References ONLY `--el-*` colour tokens + ' +
        '`[data-display-style]` shape tokens — no Tier-0 utilities (the ' +
        '`motir-core/CLAUDE.md` colour/shape rules). The PR/CI pills take ' +
        'their tones from the `Pill` grammar (merged = a success-family tone, ' +
        'failing = `--el-danger` family, AA on a tint). Add a `github` i18n ' +
        'namespace for all strings (connect copy, repo-list labels, PR/CI ' +
        'states, errors) across the locale set the app ships.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Settings → GitHub renders the not-connected + connected panels per ' +
        'the 7.7.1 mockup, composed of the named primitives, ONLY `--el-*` + ' +
        'shape tokens (no Tier-0 utilities).\n' +
        '- "Connect GitHub" completes the OAuth identity grant and surfaces ' +
        'the App-install link; after install, the selected-repo list renders ' +
        'with sync state + a "Manage on GitHub" link out.\n' +
        '- A work item’s detail shows its linked PR(s) with a PR-state pill ' +
        'and a CI-state pill in the correct `--el-*` tone; the explicit-link ' +
        'affordance links a PR to the item.\n' +
        '- The revoked-installation error state renders (the App was ' +
        'uninstalled out-of-band).\n' +
        '- A client component never touches the service layer directly; the ' +
        'page is a Server Component reading via a service (4-layer).\n' +
        '- Mobile + a11y parity with the rest of settings (no separate ' +
        'config); strings are in the `github` i18n namespace.\n\n' +
        '## Context refs\n\n' +
        '- 7.7.1 (the design asset this implements), 7.7.3 (the entities), ' +
        '7.7.4 (the PR-link resolver the explicit-link feeds), 7.7.6 (the CI ' +
        'signal the pill reflects).\n' +
        '- `motir-core/components/ui/Pill.tsx` — the PR/CI state pills.\n' +
        '- `motir-core/app/(authed)/settings/` — the existing settings-area ' +
        'layout to mirror.\n' +
        '- `motir-core/app/globals.css` — `--el-*` + `[data-display-style]` ' +
        'tokens.',
      dependsOn: ['7.7.1', '7.7.3'],
    },
    {
      id: '7.7.8',
      title: 'Vitest — installation model + webhook status sync + code-graph feed refresh',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 55,
      descriptionMd:
        'Vitest suite over real Postgres (the test convention — ' +
        '`tests/helpers/db.ts` truncates between tests; mirror it in motir-ai ' +
        'for the feed test). Covers the installation model, the webhook ' +
        'status-sync state machine, and the code-graph feed refresh at the ' +
        'unit/integration level (browser E2E is 7.7.9). GitHub is stubbed at ' +
        'the HTTP boundary (recorded payload fixtures + a fake archive ' +
        'response) — the App/installation calls are external, but the ' +
        'webhook-handling + indexing logic runs the real path.\n\n' +
        '**Installation model** (`7.7.3`): an `installation` webhook creates ' +
        'the installation + selected-repo rows; `installation_repositories` ' +
        'add/remove updates them; an installation token is minted (mocked ' +
        'GitHub) and NOT persisted long-lived; the two grants are independent ' +
        '(identity-only, install-only states both render without crashing). ' +
        'FK `@relation`s hold (`migrate dev` no-drift smoke).\n\n' +
        '**Webhook signature + status sync** (`7.7.4`): a bad ' +
        '`X-Hub-Signature-256` → 401 before parse; a valid `pull_request ' +
        'opened` referencing `PROD-<n>` → in-review; `closed`+`merged:true` ' +
        '→ done; `closed`+`merged:false` → in-progress; every transition ' +
        'went through `workItemsService` (assert via repository read, the ' +
        'allowed cross-layer test reach) and is in the activity log; a custom ' +
        'workflow with no matching status → no-op not crash; redelivery is ' +
        'idempotent.\n\n' +
        '**CI feedback** (`7.7.6`): `check_suite` success → passing note; ' +
        'failure → failure summary + not-ready signal; the Story rollup ' +
        'counts verified subtasks; redelivery doesn’t duplicate comments; a ' +
        'check for an unlinked PR is a no-op.\n\n' +
        '**Code-graph feed** (`7.7.5`): an install/push event drives an index ' +
        'over a fixture repo ARCHIVE (not the local-fixture path — the ' +
        'fetch-from-GitHub path); a newly-added symbol appears after refresh; ' +
        'the transient checkout is removed after indexing (no raw-source ' +
        'retention); refresh is enqueued async (the webhook returns fast); ' +
        'per-tenant isolation holds.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test` runs the new specs green over a real Postgres ' +
        '(motir-core) + the motir-ai suite (the feed test).\n' +
        '- The only mocks are the GitHub HTTP boundary (token mint, archive ' +
        'fetch) + the standing `getSession()` exception; every DB/internal ' +
        'call goes the real path (`motir-core/CLAUDE.md`).\n' +
        '- A deliberately wrong webhook signature FAILS the 401 test (proves ' +
        'the check guards).\n' +
        '- New service/repo code respects the per-file coverage gate ' +
        '(`motir-core/CLAUDE.md` § coverage) — no untested branch in the ' +
        'webhook state machine or the feed dispatch.\n\n' +
        '## Context refs\n\n' +
        '- 7.7.3 / 7.7.4 / 7.7.5 / 7.7.6 (everything under test).\n' +
        '- `motir-core/CLAUDE.md` § tests-use-real-Postgres + coverage gate.\n' +
        '- `motir-core/tests/helpers/db.ts` — the truncate-between-tests ' +
        'harness.',
      dependsOn: ['7.7.4', '7.7.5'],
    },
    {
      id: '7.7.9',
      title: 'Playwright E2E — connect a repo → open a PR → the linked issue’s status syncs',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 35,
      descriptionMd:
        'End-to-end browser test (`tests/e2e/github.spec.ts`) over the seeded ' +
        '`moooon`/`motir` tenant — closes the integration promise from a ' +
        'user’s seat. Because driving a REAL GitHub App install + a real PR ' +
        'in CI is impractical, the spec drives the UI for the connect flow and ' +
        'simulates GitHub by POSTing SIGNED webhook fixtures to ' +
        '`/api/github/webhook` (the same signed-delivery path 7.7.4 verifies) ' +
        '— so the assertion is on Motir’s observable behavior, not on ' +
        'GitHub.\n\n' +
        '**The spec.**\n\n' +
        '1. Sign in as `zhuyue@motir.co`. Open Settings → GitHub; assert the ' +
        'not-connected panel renders with the two-grants explanation + the ' +
        '"Connect GitHub" CTA.\n' +
        '2. Simulate the connection: complete the OAuth callback (stubbed ' +
        'GitHub identity) + POST a signed `installation` webhook selecting a ' +
        'test repo. Reload settings; assert the connected panel shows the ' +
        'bound identity + the selected repo with sync state.\n' +
        '3. Pick a seeded work item, note its key. POST a signed ' +
        '`pull_request opened` fixture whose title references that key. Open ' +
        'the item’s detail; assert its status is now in-review AND the linked ' +
        'PR section shows the PR with an open-state pill.\n' +
        '4. POST a signed `pull_request closed` (`merged: true`) fixture for ' +
        'the same PR. Reload the item; assert its status is now done and the ' +
        'PR pill reads merged.\n' +
        '5. POST a signed `check_suite` failure fixture for a second item’s ' +
        'PR; assert the CI pill reads failing and the verification-failed ' +
        'signal shows on the subtask.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm test:e2e github` passes locally + in CI.\n' +
        '- The webhook POSTs are signed with the test `GITHUB_WEBHOOK_SECRET` ' +
        '(the real 7.7.4 verification path runs — an unsigned POST would 401).\n' +
        '- The spec uses the existing `signIn(page, email, password)` helper; ' +
        'no new auth plumbing invented.\n' +
        '- Not flake-prone: explicit waits on the status pill / activity-log ' +
        'text changes (poll up to 5s), not fixed sleeps.\n\n' +
        '## Context refs\n\n' +
        '- 7.7.7 (the UI under test), 7.7.4 (the signed-webhook path), 7.7.6 ' +
        '(the CI signal).\n' +
        '- `motir-core/tests/e2e/` — the existing E2E helpers + the ' +
        '`signIn` helper to reuse.\n' +
        '- 7.7.8 — the webhook payload fixtures this reuses for the signed ' +
        'POSTs.',
      dependsOn: ['7.7.7'],
    },
  ],
};
