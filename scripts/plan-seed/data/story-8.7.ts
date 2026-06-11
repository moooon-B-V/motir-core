import type { PlanStory } from '../types';

/**
 * Story 8.7 — the one-time Prodect → Motir rebrand cutover.
 *
 * **The name is Motir** (Yue, 2026-06-10 — supersedes the 2026-06-08 nifer
 * decision; notes.html mistake #34 records the nifer chapter as history; the
 * registered nifer.co domain and the nifer EUIPO filing belong to the
 * superseded name and are NOT inherited).
 *
 * **The securing prerequisite is DONE (Yue, 2026-06-10): motir.co is
 * registered and the Motir trademark is FILED.** Filing is the gate the
 * rename needs — the filing date establishes priority; the grant itself
 * (examination + opposition window, months) proceeds in the background and
 * blocks nothing here. That flips this story from "starts with an open
 * user-side prerequisite" to "rename work is READY now" — and run-early is
 * the standing call: every week of dogfooding under the old name makes the
 * cutover diff bigger, so 8.7 runs ahead of the rest of Epic 8, gated on
 * nothing else in it.
 *
 * **Scope boundaries (what 8.7 is NOT):**
 * - The Motir wordmark/logomark is story 8.3's design scope. 8.7 is the
 *   TEXTUAL rename only — it must not improvise any visual brand element
 *   (the design gate); where a logo would go, the existing text-brand
 *   treatment simply carries the new string.
 * - Production domain attach + SSL + the transactional-email backend are
 *   story 8.5's scope. 8.7 renames what exists; 8.5 takes motir.co live.
 * - The `PROD` issue key STAYS — rung-1 verified: a project key edit is a
 *   reversible Jira-standard setting, and story 6.8 ships exactly that
 *   (old-key redirects), so a later switch to MOT-N is a setting change,
 *   not a migration. No dogfood-key churn now.
 *
 * **Repo naming decision: `motir-core` / `motir-ai` / `motir-meta`.** The
 * open-core mirror products split on this (gitlab/sentry/plane name the open
 * repo after the bare product; mattermost/posthog keep a suffix). Two
 * Motir-specific reasons pick the suffixed form: (a) the workspace already
 * contains a package NAMED `motir` — the 7.9 CLI, which is the npm-published
 * artifact and owns the bare name — so the root app package cannot also be
 * `motir`, and a repo named `motir` whose root package is `motir-core` is
 * gratuitous skew; (b) the -core/-ai pair IS the open-core architecture
 * signal (GPL substrate vs closed AI backend) the plan leans on everywhere.
 * GitHub auto-redirects renamed repos, so a later move to bare `motir` stays
 * cheap if branding ever prefers it.
 *
 * **Finding #83 (2026-06-11): the bare `motir` npm name is UNPUBLISHABLE** —
 * the registry's typosquat guard 403s it ("too similar to existing package
 * motion"); no ownership of domain/trademark overrides that. The CLI ships
 * scoped as **`@motir/cli`** (bin stays `motir`) under the `@motir` scope,
 * which Yue's npm username (`motir`) owns by construction — the standard
 * branded-CLI shape (@anthropic-ai/claude-code, @openai/codex,
 * @google/gemini-cli). Repo-naming reason (a) above weakens (there is no
 * bare npm name to own); the suffixed-repo decision stands on reason (b).
 *
 * **Rename method: classified sweep, not blind find-replace.** Every subtask
 * works from a case-insensitive `rg -i prodect` inventory of its surface and
 * classifies each hit: user-visible copy / technical identifier / historical
 * record. Historical records (plan-seed prose narrating the Prodect→Motir
 * history, notes.html mistakes, migration SQL — migrations are immutable)
 * KEEP the old name; everything forward-looking moves to Motir.
 */
export const story_8_7: PlanStory = {
  id: '8.7',
  title: 'Rebrand cutover: Prodect → Motir',
  status: 'in_progress',
  gitBranch: 'story/PROD-8.7-motir-rebrand',
  descriptionMd:
    'The one-time cross-repo rename to the decided name (**Motir** — Yue, 2026-06-10). The ' +
    'securing prerequisite is DONE: **motir.co is registered and the Motir trademark is filed** ' +
    '(8.7.1, confirmed 2026-06-10), so the rename work is ready now and runs EARLY — cheapest ' +
    'before launch/traction, gated on nothing else in Epic 8. Scope: prodect-core user-facing ' +
    'copy (messages/metadata/auth/email strings), the technical surface (package names, README, ' +
    'docs, comments, repo names `motir-core`/`motir-ai`/`motir-meta`), the plan-seed tenant ' +
    '(@motir.co users, project naming — the PROD key STAYS per the 6.8-verified decision), ' +
    'prodect-ai, the prodect-meta runbook (PRODECT.md → MOTIR.md), GitHub/Vercel infra renames, ' +
    'and publishing the `@motir/cli` npm package (the 7.9 CLI — name claimed 2026-06-11; the ' +
    'bare `motir` name is registry-blocked, finding #83; real publish once the CLI ships). NOT here: the wordmark/logomark (8.3 design scope) and the ' +
    'production domain attach/SSL/email backend (8.5). Method: classified `rg -i prodect` ' +
    'sweeps — historical records keep the old name; everything forward-looking moves.',
  verificationRecipeMd:
    '- After the rename PRs merge (+ the 8.7.5 [reseed]): sign in as `zhuyue@motir.co` — the ' +
    'auth screens, sidebar/top-nav, settings, command palette, empty states and toasts all say ' +
    'Motir; the browser tab title + OG metadata carry Motir; the language-settings helper and ' +
    'zh locale show Motir (Latin script).\n' +
    '- Trigger an invite email + a password-reset email (dev transport) — subjects, previews ' +
    'and body lede all say Motir.\n' +
    '- The dogfood board still shows PROD-N keys (unchanged), and the project is named motir.\n' +
    '- `rg -i prodect` across all three repos returns only sanctioned historical mentions ' +
    '(plan-seed history prose, notes.html, migration SQL) — the 8.7.10 sweep report lists them.\n' +
    '- Old GitHub URLs (github.com/…/prodect-core) redirect to motir-core; `git pull` in an ' +
    'un-updated local checkout still works; the Vercel project is renamed and deploys green.\n' +
    '- `npm install -g @motir/cli` installs the CLI and `motir --version` runs (after 8.7.9).',
  items: [
    {
      id: '8.7.1',
      title: 'Secure the Motir name — register motir.co + file the Motir trademark',
      status: 'done',
      type: 'manual',
      executor: 'human',
      estimateMinutes: 120,
      descriptionMd:
        'The user-side securing work the rename gates on — DONE, confirmed by Yue ' +
        '2026-06-10: **motir.co is registered** and **the Motir trademark is filed** (the ' +
        'EUTM filing per the 8.7 stub decision — Nice classes 9 & 42 — with USPTO per the ' +
        'US-launch call). The FILING date is what matters here (priority); the grant ' +
        '(examination + opposition window) proceeds in the background over the coming ' +
        'months and blocks no rename work. The previously-registered nifer.co domain and ' +
        'nifer EUIPO filing belong to the superseded name (notes.html #34) and are not ' +
        'part of this — let them lapse or keep them as defensive holdings at the ' +
        "user's discretion.\n\n" +
        '## Acceptance criteria\n\n' +
        "- motir.co registered under the user's registrar account. ✓\n" +
        '- Motir trademark application filed; filing receipt retained. ✓\n' +
        '- User confirmation received (2026-06-10) — the manual-subtask done gate. ✓\n\n' +
        '## Context refs\n\n' +
        '- The 8.7 stub decision record (name = Motir; securing scope) — now this story\n' +
        '- notes.html mistake #34 (the nifer chapter)\n\n' +
        "No PR — `type: manual`, marked done on the user's confirmation (the 1.6.7 " +
        'convention).',
    },
    {
      id: '8.7.2',
      title: 'Claim the `@motir/cli` npm name + provision the NPM_TOKEN publish secret',
      status: 'done',
      type: 'manual',
      executor: 'human',
      estimateMinutes: 20,
      descriptionMd:
        'npm has no reserve-without-publish, and the name went public (domain + filing) — ' +
        'claimed 2026-06-11. The bare `motir` name turned out to be UNPUBLISHABLE: the ' +
        "registry's typosquat guard 403s it as too similar to `motion` (finding #83). " +
        'Pivot (the standard branded-CLI shape — @anthropic-ai/claude-code, ' +
        '@openai/codex): the placeholder published as **`@motir/cli`** `0.0.1` ' +
        "(`--access=public`) under the `@motir` scope, which Yue's npm username " +
        '(`motir`) owns by construction — no org creation needed, and the scope fences ' +
        'the brand namespace on npm. The bin name stays `motir`. A granular automation ' +
        'token (read/write on the `@motir` scope) is set as the `NPM_TOKEN` Actions ' +
        'secret — the 8.7.9 release workflow consumes it. The real 0.1.0 publish ' +
        '(8.7.9) supersedes the placeholder.\n\n' +
        '## Acceptance criteria\n\n' +
        "- `npm view @motir/cli` resolves to the placeholder owned by the user's " +
        'account; 2FA (passkey) is on. ✓\n' +
        '- The `NPM_TOKEN` automation-token secret exists on the repo (Actions scope). ✓\n' +
        '- User confirmation received (2026-06-11) — the manual-subtask done gate. ✓\n\n' +
        '## Context refs\n\n' +
        '- `packages/cli` / story 7.9 (the package that will own the name)\n' +
        '- 8.7.9 (the release workflow consuming the secret)\n' +
        '- PRODECT_FINDINGS.md #83 (the bare-name block + the scoped pivot)\n\n' +
        'No PR — `type: manual`, dashboard/secret work (the 1.6.7 convention).',
      dependsOn: ['8.7.1'],
    },
    {
      id: '8.7.3',
      title: 'prodect-core user-facing rename — messages, metadata, auth + email copy',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        'Every USER-VISIBLE "Prodect" in the app becomes "Motir". Work from a classified ' +
        '`rg -i prodect` inventory over `app/`, `components/`, `messages/`, `lib/`:\n\n' +
        '- **Locale messages** — `messages/en.json` + `messages/zh.json`: auth screens ' +
        '(sign-in/sign-up subheads), the welcome copy (rename brand-carrying KEYS too, ' +
        'e.g. `welcomeToProdect` → `welcomeToMotir`, with their usages), settings helper ' +
        'text, board/issue callouts, and the EMAIL strings (invite + password-reset ' +
        'subject/preview/lede). Per the locked zh glossary the brand stays **Latin-script ' +
        '"Motir"** in zh; en/zh stay key-parallel.\n' +
        '- **App/SEO metadata** — `app/layout.tsx` (+ any route-level `metadata`): title, ' +
        'description, OG/Twitter fields, manifest/app name.\n' +
        '- **Hardcoded UI strings** outside messages (tokens pages, test-only chrome) — ' +
        "move or rename per the surface's existing convention.\n\n" +
        'NOT in scope: the logo/wordmark (8.3 design scope — no visual element is ' +
        'improvised here; the existing text-brand treatment carries the new string), ' +
        'package/repo names + comments/docs (8.7.4), the plan seed (8.7.5). Update the ' +
        'unit/E2E assertions that pin the old strings — the existing suites are the ' +
        'verification; no new test surface.\n\n' +
        '## Acceptance criteria\n\n' +
        '- No user-visible "Prodect" remains: `rg -i prodect app components messages` ' +
        'hits only comments/identifiers deferred to 8.7.4 (listed in the PR body).\n' +
        '- en.json and zh.json carry identical key sets; zh shows Latin "Motir".\n' +
        '- Tab title/OG metadata, both auth screens, and both email templates say Motir ' +
        '(asserted in the updated tests).\n' +
        '- Lint / typecheck / build green; the touched test files pass.\n\n' +
        '## Context refs\n\n' +
        '- `messages/en.json`, `messages/zh.json` (the brand strings + email copy)\n' +
        '- `app/layout.tsx`, `app/(auth)/sign-in/page.tsx`, `app/(auth)/sign-up/page.tsx`\n' +
        '- The zh translation-style glossary (brand stays Latin)\n\n' +
        '**Branch.** `subtask/PROD-8.7.3-core-user-facing-rename`.',
      dependsOn: ['8.7.1'],
    },
    {
      id: '8.7.4',
      title: 'prodect-core technical rename — package name, README, docs, comments, notices',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 45,
      descriptionMd:
        'The non-UI surface of the core repo, from the same classified inventory:\n\n' +
        '- `package.json` `name`: `prodect-core` → `motir-core` (the CLI package owns the ' +
        'npm presence as `@motir/cli` — finding #83 + the story-header repo-naming ' +
        'decision); `description` ' +
        'reworded to Motir.\n' +
        '- `README.md` — title, pitch, clone URLs (the new `motir-core` repo path; GitHub ' +
        'redirects cover the interim), badges.\n' +
        '- `docs/*.md`, `CLAUDE.md`, `.env.example`, `scripts/` — forward-looking mentions ' +
        'move to Motir ("each Motir-planned project", etc.); GPL/license notice lines ' +
        'naming the program.\n' +
        '- Code comments naming the product — rename; **migration SQL is immutable** ' +
        '(historical record, keep as-is).\n' +
        '- Env var NAMES stay stable (none carry the brand today; if one is found, flag ' +
        'it in the PR rather than renaming — a name change needs the 8.7.8 dashboard ' +
        'pass).\n\n' +
        'Coordination: 8.7.3 owns `app/`/`components/`/`messages/` hits; this subtask ' +
        'owns everything else in the repo except `scripts/plan-seed/` (8.7.5). The two ' +
        'can run in parallel — disjoint files.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm install && pnpm build` green with the renamed root package; the ' +
        '`pnpm --filter` invocations in CI/docs still resolve.\n' +
        '- `rg -i prodect` outside `app/ components/ messages/ scripts/plan-seed/` hits ' +
        'only migration SQL (PR body lists the residue).\n' +
        '- README installs/clone instructions work against the post-8.7.8 repo name and ' +
        'note the redirect interim.\n\n' +
        '## Context refs\n\n' +
        '- `package.json`, `README.md`, `CLAUDE.md`, `docs/`, `.env.example`\n' +
        '- Story header (repo-naming decision + sweep-classification method)\n\n' +
        '**Branch.** `subtask/PROD-8.7.4-core-technical-rename`.',
      dependsOn: ['8.7.1'],
    },
    {
      id: '8.7.5',
      title: 'Plan-seed tenant rename — @motir.co users, project naming; history stays',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 30,
      descriptionMd:
        'The dogfood tenant moves to the real, now-registered domain:\n\n' +
        '- Seed users `*@prodect.co` → `*@motir.co` (all six, incl. the PM ' +
        '`zhuyue@motir.co`) in `seed.ts`.\n' +
        '- The `prodect` project → name/slug `motir`; the `moooon` workspace name is ' +
        "Yue's company and stays. **The PROD issue key STAYS** (the story-header / " +
        '6.8-verified decision — do not churn dogfood keys).\n' +
        '- Plan-data prose: FORWARD-LOOKING mentions ("the Prodect MCP server", "every ' +
        'Prodect user") move to Motir; HISTORICAL/decision prose narrating the ' +
        "Prodect→Motir story (this story's cards, the 8.3/8.5 stubs' decision records, " +
        'mistake-number references) keeps the old name — the classification is the point, ' +
        'not a blind replace.\n' +
        '- `types.ts`/`seed.ts` comments follow the same rule.\n\n' +
        'The diff is seed-only, so the branch rides the `seed/*` prefix (E2E + Vercel ' +
        'preview skip) — and this is a TENANT-DATA change, so unlike a status flip the PR ' +
        '**carries `[reseed]` in BOTH title and commit body**: the merge must regenerate ' +
        'the live tenant for the new emails/naming to exist.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm db:seed` against the dev DB lands the six @motir.co users + the motir ' +
        'project with PROD-N keys intact; sign-in as `zhuyue@motir.co` works.\n' +
        '- `rg -i prodect scripts/plan-seed` hits only the classified historical prose ' +
        '(PR body lists it).\n' +
        '- Typecheck + prettier green.\n\n' +
        '## Context refs\n\n' +
        '- `scripts/plan-seed/seed.ts` (users, workspace/project naming)\n' +
        '- `scripts/plan-seed/data/` (the prose sweep)\n' +
        '- Plan seed § Workflow step 4 (the [reseed] marker rules)\n\n' +
        '**Branch.** `seed/PROD-8.7.5-tenant-rename` (seed-only diff; carries [reseed]).',
      dependsOn: ['8.7.1'],
    },
    {
      id: '8.7.6',
      title: 'prodect-ai rename — package, README, comments',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 20,
      descriptionMd:
        'The closed AI-backend repo gets the same classified sweep, sized to its small ' +
        'surface: `package.json` name `prodect-ai` → `motir-ai`, README title/pitch/clone ' +
        'URL, code comments and any service-name strings naming the product. Same rules ' +
        'as 8.7.4 (env var names stable; historical records keep the old name).\n\n' +
        '## Acceptance criteria\n\n' +
        '- Build/typecheck green under the renamed package.\n' +
        '- `rg -i prodect` in the repo hits only classified history (PR body lists it).\n\n' +
        '## Context refs\n\n' +
        '- `prodect-ai/package.json`, `prodect-ai/README.md`, `prodect-ai/CLAUDE.md`\n\n' +
        '**Branch.** `subtask/PROD-8.7.6-ai-rename` (in the prodect-ai repo).',
      dependsOn: ['8.7.1'],
    },
    {
      id: '8.7.7',
      title: 'prodect-meta runbook — PRODECT.md → MOTIR.md + the `motir <command>` vocabulary',
      status: 'done',
      type: 'content',
      executor: 'coding_agent',
      estimateMinutes: 30,
      descriptionMd:
        "The planner's own bootstrap follows the product: rename `PRODECT.md` → " +
        '`MOTIR.md` (git mv, history preserved), rewrite the command vocabulary ' +
        '(`prodect plan|run|next|status|mark|verify` → `motir …`) with a one-line compat ' +
        'note that the old `prodect <command>` spelling stays recognized, and sweep the ' +
        'runbook prose by the standard classification (forward-looking → Motir; the ' +
        'mistakes/notes history keeps Prodect). Update intra-repo cross-references ' +
        '(vision.html/notes.html mentions of "PRODECT.md") and the worktree/branch ' +
        'examples that spell out repo paths (post-8.7.8 names, with a redirect note).\n\n' +
        'Repo mechanics: prodect-meta is the ONE SHARED planner checkout (no PR flow, no ' +
        'CI) — commit defensively: specific `git add` of only the renamed/touched files, ' +
        'verify the staged set immediately before committing (sibling sessions share the ' +
        'index), and leave pushing to the user.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `MOTIR.md` exists with the rewritten vocabulary + compat note; `PRODECT.md` is ' +
        'gone (git mv).\n' +
        '- A future session given `motir status` finds and follows the runbook ' +
        'unambiguously.\n' +
        '- `rg -i prodect` in prodect-meta hits only the classified history (notes.html ' +
        'mistakes, decision records).\n\n' +
        '## Context refs\n\n' +
        '- `prodect-meta/PRODECT.md` (the file being renamed)\n' +
        '- The shared-checkout commit-discipline memory (defensive staging)\n\n' +
        '**Branch.** Direct commit in the shared prodect-meta checkout (no PR flow).',
      dependsOn: ['8.7.1'],
    },
    {
      id: '8.7.8',
      title: 'Infra renames — GitHub repos, Vercel project, local remotes',
      status: 'blocked',
      type: 'manual',
      executor: 'human',
      estimateMinutes: 30,
      descriptionMd:
        'The dashboard half of the cutover, run AFTER the rename PRs merge so the landed ' +
        'READMEs/clone URLs match reality:\n\n' +
        '- GitHub: rename `prodect-core` → `motir-core`, `prodect-ai` → `motir-ai`, ' +
        '`prodect-meta` → `motir-meta` (Settings → General). GitHub auto-redirects the ' +
        'old URLs — in-flight PRs, existing remotes and the Vercel git integration keep ' +
        'working through the redirect.\n' +
        '- Vercel: rename the project to motir-core (or re-confirm the git link picked up ' +
        'the repo rename); verify the next deploy goes green. Domain ATTACH stays 8.5 ' +
        'scope.\n' +
        '- Local checkouts: `git remote set-url origin …` in each checkout/worktree ' +
        '(folder renames at leisure — nothing depends on the directory names).\n\n' +
        '## Acceptance criteria\n\n' +
        '- All three repos renamed; an old-URL `git fetch` still succeeds (redirect).\n' +
        '- The Vercel project deploys green post-rename.\n' +
        '- User confirmation — the manual-subtask done gate.\n\n' +
        '## Context refs\n\n' +
        '- 8.7.4 / 8.7.6 / 8.7.7 (the landed renames this makes true)\n\n' +
        'No PR — `type: manual`, dashboard work (the 1.6.7 convention).',
      dependsOn: ['8.7.3', '8.7.4', '8.7.5', '8.7.6', '8.7.7'],
    },
    {
      id: '8.7.9',
      title: 'Publish the `@motir/cli` npm package — release prep + tagged release workflow',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 30,
      descriptionMd:
        'The real npm release of the 7.9 CLI, superseding the 8.7.2 placeholder. In ' +
        '`packages/cli`:\n\n' +
        '- Publish metadata: `version 0.1.0`, `files`/`bin`/`exports` covering only the ' +
        'built artifacts, `repository`/`homepage`/`bugs` at the renamed repo, license ' +
        'matching the repo (GPL-3.0 — the CLI lives in the open core), `engines.node ' +
        '>= 22`, `publishConfig.provenance: true`.\n' +
        '- `.github/workflows/release.yml`: on a `cli-v*` tag — build, run the CLI test ' +
        'lane, `npm publish --provenance` with the `NPM_TOKEN` secret (8.7.2). No ' +
        'publish-from-laptop path.\n' +
        '- README install section: `npm install -g @motir/cli` replaces the in-repo ' +
        '`pnpm --filter @motir/cli` instruction as the primary path (in-repo stays documented ' +
        'for contributors); cross-update `docs/cli.md` (7.9.6).\n\n' +
        '## Acceptance criteria\n\n' +
        '- A dry-run pack (`npm pack`) contains the binary + README and nothing stray.\n' +
        '- The release workflow is green on a test tag in CI (publish step skipped or ' +
        'dry-run without the secret) and publishes 0.1.0 on the real tag.\n' +
        '- `npm install -g @motir/cli && motir --version` works against the published ' +
        'package.\n\n' +
        '## Context refs\n\n' +
        '- `packages/cli/package.json` (7.9.1 scaffold), `docs/cli.md` (7.9.6)\n' +
        '- 8.7.2 (the name claim + NPM_TOKEN secret this consumes)\n\n' +
        '**Branch.** `subtask/PROD-8.7.9-npm-release`.',
      dependsOn: ['7.9.5', '8.7.2', '8.7.4'],
    },
    {
      id: '8.7.10',
      title: 'Post-rename sweep — cross-repo residue audit + live smoke',
      status: 'blocked',
      type: 'review',
      executor: 'coding_agent',
      estimateMinutes: 20,
      descriptionMd:
        "The cutover's safety net, after every rename subtask lands: run the full " +
        '`rg -i prodect` inventory across all three repos and produce the residue report ' +
        '— every remaining hit classified as sanctioned history (plan-seed narrative, ' +
        'notes.html, migration SQL) or as a MISS, with a fix PR for any misses (same ' +
        'branch rules as the owning subtask). Then the live smoke: auth screens, ' +
        'tab title/OG, settings, an invite + reset email, the renamed tenant login, and ' +
        'the GitHub redirect + Vercel deploy state from 8.7.8.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The residue report (PR body or a `docs/` note per repo convention) lists every ' +
        'surviving "prodect" hit with its sanction; zero unclassified hits.\n' +
        '- The live smoke passes on every surface above.\n\n' +
        '## Context refs\n\n' +
        '- 8.7.3–8.7.8 (the work being audited)\n' +
        '- Story verificationRecipeMd (the user-facing acceptance this previews)\n\n' +
        '**Branch.** `subtask/PROD-8.7.10-rename-sweep` (only if fixes are needed).',
      dependsOn: ['8.7.3', '8.7.4', '8.7.5', '8.7.6', '8.7.7', '8.7.8'],
    },
  ],
};
