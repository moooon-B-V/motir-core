import type { PlanStory } from '../types';

/**
 * Story 1.1 — Auth & user accounts.
 * Faithful transcription of prodect_plan/story-1.1-auth.html (frozen archive).
 */
export const story_1_1: PlanStory = {
  id: '1.1',
  title: 'Auth & user accounts',
  status: 'done',
  gitBranch: 'story/PROD-1.1-auth',
  descriptionMd:
    'Email + password sign-up, sign-in, sign-out, plus Google OAuth as a peer sign-in ' +
    'method. Password reset and session management. Foundation for everything else — ' +
    'until this works, no user can save anything in Prodect. The Story closes by ' +
    'snapshotting the working auth code into both starter templates ' +
    '(`nextjs-prisma-vercel-starter` and `nextjs-prisma-vercel-starter-with-design`), ' +
    'making auth a baseline feature of every future Prodect-planned project.\n\n' +
    '**Prerequisites:** [Story 1.0 (Project bootstrap)](story-1.0-project-bootstrap.html) ' +
    'must be complete — repo scaffold, Prisma, Postgres connection must exist before auth ' +
    'tables can be added. [Story 1.0.5 (Design system & brand)](story-1.0.5-design-system.html) ' +
    'must be complete before Subtask 1.1.5 (sign-up / sign-in pages) — those pages must use ' +
    'the canonical `Button`, `Input`, and `Card` primitives, not new components. The two ' +
    'backport Subtasks (1.1.8, 1.1.9) at the end of the Story snapshot the working auth code ' +
    'into both starter templates, so all future Prodect-planned projects start with auth ' +
    'wired in.',
  verificationRecipeMd:
    '- Pull the Story branch, run `git checkout story/PROD-1.1-auth` then `./scripts/db-up.sh`. ' +
    'First-time only: set `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` in `.env` from your ' +
    'Google Cloud Console OAuth 2.0 client. See the comment in `.env.example` for the redirect ' +
    'URI to register. Then run `pnpm dev`.\n' +
    '- Open http://localhost:3000. You should be redirected to `/sign-in` (since not logged in). ' +
    'You should see both the email/password form AND a "Continue with Google" button.\n' +
    '- **EMAIL/PASSWORD SIGN-UP FLOW:** Click "Create account" (or visit `/sign-up`). Try ' +
    'submitting with a bad password ("123") — you should see an inline error. Submit with a ' +
    'valid email + password (≥8 chars) — you should be redirected to the home page, signed in. ' +
    'Check the browser cookies — there should be a session cookie set.\n' +
    '- **SIGN-OUT FLOW:** Click "Sign out" (or visit `/sign-out`). You should be redirected ' +
    'back to `/sign-in`.\n' +
    '- **EMAIL/PASSWORD SIGN-IN FLOW:** From `/sign-in`, enter the email + password you just ' +
    'created — you should be signed in. Sign out, then try a wrong password — you should see ' +
    'an inline error ("Email or password is wrong") that does NOT reveal whether the email exists.\n' +
    '- **GOOGLE OAUTH SIGN-IN FLOW:** Sign out. From `/sign-in`, click "Continue with Google." ' +
    "Complete Google's consent screen — you should be redirected back and signed in. Check the " +
    'database: there should be a new google Account row linked to your User.\n' +
    '- **ACCOUNT-LINKING ASSERTION (email-first → google direction; the supported direction):** ' +
    'Repeat the sign-up with a NEW email to create a fresh email-first user, sign out, then ' +
    "click “Continue with Google” with the SAME email at Google's consent screen. You should " +
    'land on `/dashboard` signed in as the existing User row (no duplicate created). The DB ' +
    'will show ONE User with that email AND two Account rows (credential + google) both tied to ' +
    'it. `user.emailVerified` will have flipped from false to true on the linking sign-in ' +
    "(Better-Auth's auto-promotion). REVERSE direction (Google-first user trying email/password) " +
    'is NOT supported by current wiring — OAuth-only users have no credential Account row with ' +
    "a password hash. Documented in PR #19's body as a future enhancement.\n" +
    '- **PASSWORD RESET FLOW:** From `/sign-in`, click "Forgot password." Enter your email — ' +
    'you should see a confirmation screen. In your terminal where `pnpm dev` is running, look ' +
    'for a logged reset link (the dev console email provider prints it to stdout with a `[EMAIL]` ' +
    'marker). Open that link. Set a new password (≥8 chars) — you should be signed in with the ' +
    'new password. Sign out and sign back in with the new password to confirm.\n' +
    '- **STARTER-SNAPSHOT VERIFICATION (Subtasks 1.1.8 + 1.1.9):** Visit ' +
    'https://github.com/moooon-B-V/nextjs-prisma-vercel-starter and confirm the latest commit ' +
    'on main is the auth snapshot; CI is green; "Use this template" button still works. Same ' +
    'for https://github.com/moooon-B-V/nextjs-prisma-vercel-starter-with-design. Spot-check ' +
    'the auth files in each starter — no "Prodect" string left behind in any code or README.\n' +
    '- Confirm CI is green on the Story PR (lint + typecheck + build + both E2E tests from 1.1.7).',
  items: [
    {
      id: '1.1.1',
      title: 'Mockup of sign-up / sign-in / reset-password screens',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 25,
      dependsOn: ['1.0.5.2'],
      descriptionMd:
        'Produce a viewable mockup of the three auth screens — sign-up, sign-in, and password ' +
        'reset — *before* any production React is written. The user reviews the mockup; ' +
        'Subtask 1.1.5 implements the React using this mockup as its source of truth.\n\n' +
        '**Why this exists:** Design-first ordering is a load-bearing product principle ' +
        '(see vision.html §13). Without a mockup subtask, visual decisions get made implicitly ' +
        "while writing React — by the time the user sees the rendered page, they're reviewing " +
        'both the look and the code at once, which is much harder than reviewing the look first ' +
        'and the code second. This subtask creates the artifact that 1.1.5 reads.\n\n' +
        "**What you'll do:** Open Pencil (or another visual prototyping tool the coding agent " +
        'can drive) and lay out the three screens using *only* the primitive components produced ' +
        'in 1.0.5.2 (`Button`, `Input`, `Card`). Both sign-up and sign-in screens must include ' +
        'a **"Continue with Google"** button as a peer sign-in method (visual placement ' +
        'convention: above the email field with an "or" divider between the two methods). ' +
        'Reference the [awesome-design-md](https://github.com/VoltAgent/awesome-design-md) ' +
        'corpus for layout patterns common in auth screens. Save the result to ' +
        '`/design/auth-screens.pen` and export `/design/auth-screens.png` so reviewers without ' +
        'Pencil can still see what you drew.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Three screens drafted: sign-up form, sign-in form, reset-password request form ' +
        '(+ the confirmation screen that follows it).\n' +
        '- Sign-up and sign-in screens include a "Continue with Google" button (above the email ' +
        'field, separated by an "or" divider). Visual style follows Google\'s brand guidelines ' +
        'for sign-in buttons (white background, Google "G" logo, "Continue with Google" label).\n' +
        '- Each screen uses primitives from `/docs/design-system.md` exclusively — does NOT ' +
        'introduce new component patterns. The Google button composes `Button variant="secondary"` ' +
        'with the Google logo as `leftIcon`.\n' +
        '- Error states drawn for each form (invalid email, password too short, account not ' +
        'found, OAuth failure).\n' +
        '- Loading state drawn (button shows spinner during submit, including the Google button ' +
        'during OAuth redirect).\n' +
        '- Mobile breakpoint considered: at <640px, the card fills the width with reasonable ' +
        'padding.\n' +
        '- Output saved to `/design/auth-screens.pen` and `/design/auth-screens.png`.\n' +
        '- Reviewer can view the mockup and react before any React is written.\n\n' +
        '## Context refs\n\n' +
        '- `/docs/design-system.md` — canonical visual reference\n' +
        '- `/components/ui/Button.tsx, Input.tsx, Card.tsx` — the primitives to compose from\n' +
        '- `README.md` — stack reference (Next.js + Tailwind)\n' +
        '- [awesome-design-md](https://github.com/VoltAgent/awesome-design-md) — external ' +
        'pattern library, fetched at prompt-gen time',
    },
    {
      id: '1.1.2',
      title: 'Better-Auth setup with email/password — framework wiring',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 18,
      dependsOn: ['1.0.2'],
      descriptionMd:
        'Install and configure [Better-Auth](https://better-auth.com) with the email/password ' +
        "method enabled. This subtask wires the framework's plumbing — handler mount, " +
        'server-side `auth` helper, session cookies, route-protection middleware — but does ' +
        "NOT yet add Google OAuth (that's 1.1.4), the user/account schema (that's 1.1.3), " +
        "or the UI screens (that's 1.1.5).\n\n" +
        '**Why Better-Auth, not NextAuth:** Better-Auth ships email/password as a first-class ' +
        'primitive (NextAuth treats it as the awkward custom-credentials path) and ' +
        'account-linking semantics are first-class as well, which Subtask 1.1.4 will rely on. ' +
        'OAuth providers are a one-line config-block add — equivalent ergonomics to NextAuth on ' +
        'the OAuth side. Decision recorded in PRODECT.md "Current state".\n\n' +
        '**Why split this from 1.1.3 and 1.1.5:** Better-Auth wiring is mostly framework setup ' +
        'with little product surface. It can run in parallel with 1.1.1 (design mockup) and ' +
        "1.1.3 (user table), shaving a day off the Story's wall-clock time.\n\n" +
        "**What you'll do:** `pnpm add better-auth`, create `/lib/auth/index.ts` exporting a " +
        'configured `auth` instance, mount the handler at ' +
        '`/app/api/auth/[...all]/route.ts`, configure the session strategy (signed-cookie ' +
        "session — Better-Auth's default for Next.js), add a `middleware.ts` that protects " +
        'everything under `/app/(authed)/*`, and document the new env vars in `.env.example`. ' +
        'Email/password is enabled but verification is off in this subtask (verification UX ' +
        'lands in 1.1.6 alongside the email abstraction).\n\n' +
        '## Acceptance criteria\n\n' +
        '- Better-Auth installed; `/lib/auth/index.ts` exports a configured `auth` instance ' +
        'with the email/password method enabled.\n' +
        '- Handler mounted at `/app/api/auth/[...all]/route.ts`; `auth.api` reachable from ' +
        'server components.\n' +
        '- Cookies are `httpOnly` + `sameSite=lax` + `secure` in production.\n' +
        '- `middleware.ts` protects routes under `/app/(authed)/*`; unauthenticated requests ' +
        'redirect to `/sign-in`.\n' +
        '- Server-side `getSession()` helper available to server components for reading the ' +
        'current user.\n' +
        '- `.env.example` updated with: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (commented for ' +
        'production scope).\n' +
        "- Smoke test: a placeholder sign-in form (not styled — that's 1.1.5) successfully " +
        'creates a session cookie and the protected route renders.\n\n' +
        '## Context refs\n\n' +
        '- `README.md` — Next.js App Router conventions, env-var pattern\n' +
        '- `.env.example` — existing env vars to extend\n' +
        '- Better-Auth docs (fetched at prompt-gen time): Next.js integration, email/password ' +
        'method, middleware patterns\n' +
        '- PRODECT.md — Better-Auth decision rationale',
    },
    {
      id: '1.1.3',
      title: 'User + OAuthAccount schema + password hashing',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 15,
      dependsOn: ['1.0.2', '1.1.2'],
      descriptionMd:
        'Add the `user` table and the `oauth_account` account-linking table to the Prisma ' +
        'schema, wire up the password-hashing helper, and create a clean repository layer so ' +
        'the rest of the codebase never touches password hashing or OAuth account state ' +
        'directly. Better-Auth (configured in 1.1.2) consumes this schema as its persistence ' +
        'layer.\n\n' +
        '**Why two tables and not one:** a single user can have *both* an email/password ' +
        'credential *and* linked OAuth accounts (via auto-linking on matching email). Storing ' +
        'OAuth account state as rows in a separate `oauth_account` table — keyed by ' +
        "`(provider, providerAccountId)` — is Better-Auth's recommended shape and keeps the " +
        "user table free of provider-specific fields. The User's `passwordHash` is nullable: " +
        'Google-only signups never set one.\n\n' +
        '**Why hashing helper is its own concern:** Password handling is a security footgun. ' +
        'By centralizing it in one file (`/lib/auth/passwords.ts`) with both `hash()` and ' +
        '`verify()`, the rest of the codebase can never accidentally compare a plaintext ' +
        "password — there's only one way to do it.\n\n" +
        "**What you'll do:** Edit `/prisma/schema.prisma` to add the `User` and `OAuthAccount` " +
        "models (using Better-Auth's expected field names so the Prisma adapter just works), " +
        'generate and apply a migration, write `/lib/auth/passwords.ts` using `argon2` ' +
        "(preferred) or `bcrypt` (fallback if argon2 isn't viable), and provide " +
        '`/lib/users/repo.ts` with `createUser`, `findUserByEmail`, `verifyPassword`, ' +
        '`findOrCreateOAuthUser` (used by 1.1.4 for Google sign-in auto-link), and ' +
        '`linkOAuthAccount`. Wire the Better-Auth instance from 1.1.2 to the Prisma adapter ' +
        'pointing at this schema.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `User` table: `id` (uuid), `email` (unique, case-insensitive), `passwordHash` ' +
        '(nullable — null for Google-only signups), `emailVerifiedAt` (nullable; set ' +
        'automatically for Google signups since Google has already verified), `name`, `image` ' +
        '(nullable; populated from Google profile when available), `createdAt`, `updatedAt`.\n' +
        '- `OAuthAccount` table: `id`, `userId` (FK → User), `provider` (e.g. `"google"`), ' +
        '`providerAccountId` (the Google user ID), `accessToken` (nullable), `refreshToken` ' +
        '(nullable), `expiresAt` (nullable), `createdAt`, `updatedAt`. Composite unique on ' +
        "`(provider, providerAccountId)`. Field names match Better-Auth's Prisma-adapter " +
        'conventions so no custom mapping is required.\n' +
        '- Migration created and applies cleanly on a fresh database.\n' +
        '- `/lib/auth/passwords.ts` exposes `hash(plain) → string` and ' +
        '`verify(plain, hash) → boolean`. Uses argon2id with sensible parameters ' +
        '(memoryCost: 19MB, timeCost: 2, parallelism: 1) or bcrypt cost 12 if argon2 ' +
        "isn't viable.\n" +
        '- `/lib/users/repo.ts` exposes `createUser({ email, password, name? })`, ' +
        '`findUserByEmail(email)`, `verifyPassword(email, plain)`, ' +
        '`findOrCreateOAuthUser({ provider, providerAccountId, email, name?, image? })` ' +
        '(auto-link semantics: if an existing user matches on email, link the OAuth account ' +
        'to them; otherwise create a new user with `passwordHash: null` and link), ' +
        '`linkOAuthAccount({ userId, provider, providerAccountId, ... })`. Email lookups are ' +
        'case-insensitive.\n' +
        "- Better-Auth's Prisma adapter is wired in `/lib/auth/index.ts` (from 1.1.2) to " +
        'point at the new schema.\n' +
        '- No raw `bcrypt`/`argon2` imports anywhere else in the codebase (lint rule or just ' +
        'convention; spot-check).\n' +
        '- Tests: hash-and-verify roundtrip; invalid password returns false; duplicate-email ' +
        'password creation fails with a typed error; `findOrCreateOAuthUser` with matching ' +
        'email links to existing user; `findOrCreateOAuthUser` with no matching email creates ' +
        'a new user with null `passwordHash`.\n\n' +
        '## Context refs\n\n' +
        '- `README.md` — Prisma conventions in this repo\n' +
        '- `/prisma/schema.prisma` — existing schema (placeholder from 1.0.2)\n' +
        '- OWASP password-storage cheat-sheet (URL, fetched at prompt-gen)',
    },
    {
      id: '1.1.4',
      title: 'Google OAuth provider — Better-Auth config, auto-link semantics',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 15,
      dependsOn: ['1.1.2', '1.1.3'],
      descriptionMd:
        'Add Google OAuth as a peer sign-in method to the Better-Auth instance configured in ' +
        "1.1.2. Wires the provider's config block, the OAuth callback handler (Better-Auth " +
        'mounts it automatically once the provider is registered), and the auto-link semantics ' +
        'so that a Google sign-in with an email matching an existing password account links ' +
        'into the same User row. No UI work in this subtask — the "Continue with Google" button ' +
        'on the sign-in/sign-up pages lands in 1.1.5, which depends on this.\n\n' +
        '**Why auto-link, not require-verification:** Decided in Story-1.1 planning conversation ' +
        '(recorded in PRODECT.md). Same email → same user; both methods work afterward. ' +
        'Lowest-friction UX; the security trade-off (Google-account compromise → full account ' +
        'takeover) is acceptable for v1 because Google already verified the email and most ' +
        'users use Google with 2FA on. If a future Story needs require-verification semantics ' +
        'for compliance reasons, swap the `accountLinking` Better-Auth option there.\n\n' +
        '**Why env-var-driven with no shipped defaults:** Per the planner-as-consumer principle ' +
        '(PRODECT.md "Current state" + notes.html mistake #22), each Prodect-planned project ' +
        'owns its own Google Cloud OAuth app. The starters ship `GOOGLE_CLIENT_ID` / ' +
        '`GOOGLE_CLIENT_SECRET` as required env vars with no defaults; the planner adds a ' +
        '"Set up Google Cloud OAuth credentials" Story in pre-plan for each project, parallel ' +
        'to the email-provider Story. In dev, missing creds make the Google button render but ' +
        'error visibly when clicked — no silent fallback.\n\n' +
        "**What you'll do:** Extend `/lib/auth/index.ts` (from 1.1.2) to register the Google " +
        'social provider with `clientId` / `clientSecret` read from env, and enable ' +
        '`accountLinking` with the `trustedProviders: ["google"]` option so matching emails ' +
        'auto-link. Wire the OAuth callback to use `findOrCreateOAuthUser` from ' +
        '`/lib/users/repo.ts` (from 1.1.3). Document `GOOGLE_CLIENT_ID` + ' +
        '`GOOGLE_CLIENT_SECRET` in `.env.example` with a comment explaining where to obtain ' +
        'them (Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID, ' +
        'web application, authorized redirect URI ' +
        '`{BETTER_AUTH_URL}/api/auth/callback/google`).\n\n' +
        '## Acceptance criteria\n\n' +
        "- Better-Auth's Google social provider registered in `/lib/auth/index.ts`; reads " +
        '`GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` from env.\n' +
        '- `accountLinking.trustedProviders` includes `"google"`; auto-link by matching email ' +
        'is enabled.\n' +
        '- OAuth callback handler at `/app/api/auth/[...all]/route.ts` (mounted by 1.1.2) ' +
        "handles Google's callback round-trip; on success the user is created or linked via " +
        '`findOrCreateOAuthUser` from 1.1.3.\n' +
        '- OAuth-created users have `passwordHash: null` and `emailVerifiedAt` set to the ' +
        'OAuth callback time (Google has already verified the email).\n' +
        '- If a user already exists with the Google email (created via email/password) and ' +
        'signs in with Google for the first time, a new `OAuthAccount` row is created linking ' +
        'to the existing User; the existing `passwordHash` is unchanged; both sign-in methods ' +
        'work afterward.\n' +
        '- `.env.example` documents `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` with a comment ' +
        'pointing to Google Cloud Console + the redirect URI shape.\n' +
        '- Smoke test (manual; full E2E lands in 1.1.7): with valid Google creds in `.env`, ' +
        'hitting `/api/auth/sign-in/social?provider=google` directly (no UI) redirects to ' +
        "Google's consent screen, then after consent redirects back, creates a session cookie, " +
        'and the protected route renders.\n' +
        "- Tests: unit test for `findOrCreateOAuthUser`'s auto-link branch (called above in " +
        "1.1.3's AC list — verify here that the OAuth callback actually invokes it correctly " +
        'via a stubbed Google response).\n\n' +
        '## Context refs\n\n' +
        '- `/lib/auth/index.ts` — Better-Auth instance from 1.1.2 (to extend)\n' +
        '- `/lib/users/repo.ts` — user repository with `findOrCreateOAuthUser` from 1.1.3\n' +
        '- `/prisma/schema.prisma` — `OAuthAccount` model from 1.1.3\n' +
        '- `.env.example` — env-var pattern to extend\n' +
        '- Better-Auth social-providers docs (fetched at prompt-gen time): Google provider ' +
        'config, account-linking options, callback handler shape\n' +
        '- Google Cloud Console OAuth 2.0 setup docs (URL, fetched at prompt-gen): authorized ' +
        'redirect URIs, OAuth consent screen',
    },
    {
      id: '1.1.5',
      title: 'Implement sign-up / sign-in / reset-password pages from the mockup',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 32,
      dependsOn: ['1.1.1', '1.1.2', '1.1.3', '1.1.4'],
      descriptionMd:
        'Translate the approved mockup from 1.1.1 into real React pages, wired to the ' +
        'Better-Auth setup from 1.1.2, the user repository from 1.1.3, and the Google OAuth ' +
        'provider from 1.1.4. The mockup is the *source of truth for the visual outcome* — ' +
        'this subtask should not make new visual decisions; if something feels off in the ' +
        'mockup, raise it as a re-plan of 1.1.1 rather than diverging here.\n\n' +
        '**Why depend on 1.1.4 (Google OAuth):** the sign-up/sign-in pages ship with a ' +
        '*working* "Continue with Google" button, not a stub. Half-finished implementations ' +
        'that say "Google login coming soon" are explicitly disallowed by CLAUDE.md. The ' +
        'dependency forces ordering: Google OAuth lands before the pages, so when the pages are ' +
        'built the button is wired the first time.\n\n' +
        "**What you'll do:** Create `/app/(auth)/sign-up/page.tsx`, " +
        '`/app/(auth)/sign-in/page.tsx`, `/app/(auth)/reset-password/page.tsx`. Each page ' +
        'composes `Button`, `Input`, `Card` from `/components/ui/`. Email/password submit ' +
        "handlers use Server Actions calling Better-Auth's server API; form state uses " +
        '`useFormState` for error display. The "Continue with Google" button on sign-up + ' +
        'sign-in is a `Button variant="secondary"` whose `onClick` initiates Better-Auth\'s ' +
        'OAuth sign-in flow (`signIn.social({ provider: "google" })`); it shows a spinner ' +
        'during the redirect. Empty + loading + error states from the mockup must all render.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Three pages exist and render visually identical to `/design/auth-screens.png` ' +
        '(pixel-equivalence not required; visual-equivalence is).\n' +
        '- Sign-up: valid email + 8+ char password → user created, session cookie set, redirect ' +
        'to `/app`.\n' +
        '- Sign-up errors render inline: email already taken, password too short, network ' +
        'failure.\n' +
        '- Sign-in: valid creds → session, invalid → inline error "Email or password is wrong" ' +
        "(don't leak which).\n" +
        '- "Continue with Google" button is wired (not a stub) on both sign-up and sign-in ' +
        "pages: clicking initiates Better-Auth's Google OAuth flow; on success the user is " +
        'redirected to `/app` with a session cookie set. Button shows a spinner during the ' +
        'redirect.\n' +
        '- Google OAuth errors (consent denied, missing creds in dev) render an inline error ' +
        'on the page the user was on (not a server 500).\n' +
        '- Reset-password request: form accepts an email, calls backend, shows the confirmation ' +
        "screen (regardless of whether the email exists — don't leak account existence).\n" +
        '- Loading states: submit buttons show spinner during the action; double-submit ' +
        'prevented.\n' +
        '- Accessible: every form field has a label; errors are `aria-live="polite"`; keyboard ' +
        'tab order is sensible (Google button is reachable via Tab before the email field).\n' +
        '- Mobile breakpoint matches the mockup.\n\n' +
        '## Context refs\n\n' +
        '- `/design/auth-screens.pen` + `/design/auth-screens.png` — the mockup from 1.1.1\n' +
        '- `/docs/design-system.md` — token reference\n' +
        '- `/components/ui/Button.tsx, Input.tsx, Card.tsx` — primitives to compose\n' +
        '- `/lib/auth/index.ts` — Better-Auth instance + Google provider (from 1.1.2 + 1.1.4)\n' +
        '- `/lib/users/repo.ts` — user repository (from 1.1.3)\n' +
        '- Better-Auth client docs (fetched at prompt-gen time): client-side `signIn` helpers ' +
        'for credentials + social providers',
    },
    {
      id: '1.1.6',
      title: 'Password reset flow + email abstraction (dev console provider)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: ['1.1.2', '1.1.3'],
      descriptionMd:
        'Implement the backend half of password reset (the token table, the "request reset" ' +
        'handler that sends an email with a one-time link, and the "set new password" handler ' +
        'that consumes the token) *and* introduce a small email-provider abstraction ' +
        '(`lib/email.ts`) so the rest of the codebase never depends on a specific mailer. ' +
        'The UI half lives in 1.1.5; this subtask provides the endpoints those pages call ' +
        'plus the email abstraction those endpoints (and the email-verification flow) use.\n\n' +
        '**Why an abstraction, not a direct Resend/Postmark/SES call:** Per the ' +
        'planner-as-consumer principle (PRODECT.md "Current state"), production email-provider ' +
        "choice is planner work — each Prodect-planned project's planner decides which " +
        'provider to use in pre-plan and adds a mandatory Story to wire it. The starter (and ' +
        'prodect-core itself for v1) ships only the abstraction + a **dev console-logging ' +
        'provider** that prints reset links to stdout. Production wiring is deferred. This ' +
        'keeps the starter dependency-free of any specific email vendor while making the ' +
        "wiring point explicit (`lib/email.ts`'s `sendEmail()` export).\n\n" +
        '**Why split from 1.1.5:** Reset is a security-sensitive flow (timing attacks, token ' +
        'reuse, account enumeration) that benefits from focused review independent of the UI. ' +
        'Splitting also lets it run in parallel with 1.1.5 since they share no files.\n\n' +
        "**What you'll do:** Add a `PasswordResetToken` table (token-hash, user-id, expires-at, " +
        'used-at). Create `/lib/email.ts` exporting ' +
        '`sendEmail({ to, subject, html, text? })` as the canonical interface; provide a ' +
        '`DevConsoleEmailProvider` implementation that logs to stdout with a clear `[EMAIL]` ' +
        'marker; wire the production-provider hook as a single env-var switch ' +
        '(`EMAIL_PROVIDER=console` default; future values `resend`, `postmark`, etc.). Create ' +
        'Server Actions `requestReset(email)` and `confirmReset(token, newPassword)` in ' +
        '`/app/(auth)/reset-password/actions.ts`. Tokens expire in 1 hour and are ' +
        'single-use.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `PasswordResetToken` table with required fields + indexes on `userId` and ' +
        '`expiresAt`.\n' +
        "- Tokens stored as hashes (don't store the raw token; hash on insert, compare hashes " +
        'on lookup).\n' +
        '- `/lib/email.ts` exports a typed ' +
        '`sendEmail({ to, subject, html, text? }) → Promise<void>` interface and a ' +
        '`DevConsoleEmailProvider` implementation. Selected via `EMAIL_PROVIDER` env var ' +
        '(default: `console`); unknown values throw a clear startup error.\n' +
        '- Console provider prints `[EMAIL] To: ... Subject: ... Body: ...` with the full reset ' +
        'link visible, so dev/test flows can extract it from stdout.\n' +
        '- `requestReset(email)`: rate-limit to 3 requests/hour/email; do NOT reveal whether ' +
        'the email exists in the response; calls `sendEmail` with the reset link only if a ' +
        'user is found (silent no-op otherwise).\n' +
        '- `confirmReset(token, newPassword)`: validates token, checks expiry, checks unused, ' +
        'updates password via the repo from 1.1.3, marks token used, returns success or typed ' +
        'error.\n' +
        '- `.env.example` documents `EMAIL_PROVIDER` with the comment "`console` for dev; ' +
        "production provider wiring is planner work — see your project's pre-plan " +
        'email-provider Story."\n' +
        '- Tests: happy path; expired token; used token; unknown email (silently succeeds — no ' +
        'email sent); rate-limit triggers; `sendEmail` with the console provider writes the ' +
        'expected marker to stdout.\n\n' +
        '## Context refs\n\n' +
        '- `/lib/users/repo.ts` — user repository (from 1.1.3)\n' +
        '- `/lib/auth/passwords.ts` — hashing helper (from 1.1.3)\n' +
        '- `/prisma/schema.prisma` — current schema\n' +
        '- PRODECT.md — planner-as-consumer principle; email-provider choice is planner work\n' +
        '- OWASP password-reset cheat-sheet (URL, fetched at prompt-gen)',
    },
    {
      id: '1.1.7',
      title: 'E2E tests covering email/password + Google OAuth happy paths (Playwright)',
      status: 'done',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: ['1.1.5', '1.1.6'],
      descriptionMd:
        'Two Playwright tests that exercise the auth lifecycle end-to-end: one for the ' +
        'email/password golden path (sign-up → sign-out → sign-in → request-reset → ' +
        'confirm-reset → sign-in-with-new-password) and one for the Google OAuth path (sign-in ' +
        'via Google → session created → sign-out → sign-in via Google again returns to the ' +
        'same account → sign-in via email/password with the same email links into the same ' +
        'user). If both pass, the Story is functionally complete.\n\n' +
        '**Why two tests, not one:** Email/password and Google OAuth exercise substantially ' +
        'different code paths (Server Actions vs. OAuth callback round-trip, Better-Auth ' +
        'credentials method vs. social method, different cookie set timings). One test per ' +
        'path keeps each focused and the failure messages legible. The account-linking ' +
        "assertion in the Google test is the load-bearing check that 1.1.3's " +
        "`findOrCreateOAuthUser` + 1.1.4's auto-link wiring are correct end-to-end.\n\n" +
        '**Why only two E2E tests:** E2E tests are slow and brittle. The golden-path coverage ' +
        'catches "we broke auth"; unit tests at the repo/handler layer (added in 1.1.3, 1.1.4, ' +
        "1.1.6) catch finer-grained issues. Don't try to cover edge cases here.\n\n" +
        "**How to test Google OAuth without hitting real Google:** Use Playwright's " +
        "`page.route()` to intercept Better-Auth's OAuth redirect to Google's authorize " +
        'endpoint and respond with a synthetic OAuth callback (signed with a test secret). ' +
        'Better-Auth supports a test-mode "trusted-OAuth" hook for exactly this; if not, ' +
        'intercept at the network layer. **Do not** use real Google credentials in CI.\n\n' +
        "**What you'll do:** Create `/tests/e2e/auth-credentials.spec.ts` (the " +
        'email/password test) and `/tests/e2e/auth-google.spec.ts` (the OAuth test). Use the ' +
        'Playwright config from 1.0.4 (CI). Seed a clean database before each test; reset-link ' +
        'via the dev console provider from 1.1.6; Google OAuth via the test-mode interceptor. ' +
        'Tag both `@smoke` so CI runs them on every PR.\n\n' +
        '## Acceptance criteria\n\n' +
        '- Two tests exist: `/tests/e2e/auth-credentials.spec.ts` and ' +
        '`/tests/e2e/auth-google.spec.ts`; both tagged `@smoke`.\n' +
        '- Both tests pass locally with `pnpm test:e2e` and in CI on every PR.\n' +
        '- Email/password test covers: sign-up → sign-out → sign-in → request-reset → ' +
        'confirm-reset → sign-in-with-new-password.\n' +
        '- Google OAuth test covers: Google sign-in (intercepted, synthetic callback) → session ' +
        'created → sign-out → Google sign-in again returns to same user → email/password ' +
        "sign-in with the same email succeeds (auto-link assertion: it's the same user, not a " +
        'duplicate).\n' +
        '- Database is reset to a known clean state before each test runs.\n' +
        '- Reset link obtained from dev console provider output (not from a real email ' +
        'service).\n' +
        "- Google's OAuth endpoints are intercepted, NOT called for real; no real Google " +
        'credentials in CI.\n' +
        '- Each test fails clearly with a screenshot when any step breaks.\n\n' +
        '## Context refs\n\n' +
        '- `playwright.config.ts` — base configuration (from 1.0.4)\n' +
        '- `/app/(auth)/*` — pages produced by 1.1.5\n' +
        '- `/app/(auth)/reset-password/actions.ts` — reset endpoints (from 1.1.6)\n' +
        '- `/lib/auth/index.ts` — Better-Auth instance + Google provider (from 1.1.2 + 1.1.4) ' +
        '— for the test-mode OAuth hook\n' +
        '- `/lib/email.ts` — email abstraction with dev console provider (from 1.1.6)\n' +
        '- `/tests/setup/db-reset.ts` — test-database helper (if exists from 1.0.4; create it ' +
        'here if not)\n' +
        '- Better-Auth testing docs (fetched at prompt-gen time): test-mode hooks for social ' +
        'providers, if available',
    },
    {
      id: '1.1.10',
      title: 'Card-wrapped auth layout + Vercel preview-cleanup workflow',
      status: 'done',
      type: 'code',
      executor: 'human',
      estimateMinutes: 25,
      dependsOn: ['1.1.5', '1.1.6', '1.1.7'],
      descriptionMd:
        'Mid-stream Subtask added between 1.1.7 and 1.1.8 as a precondition for the starter ' +
        'snapshots. Two unrelated-but-paired concerns landed in one Subtask:\n\n' +
        '**Card-wrapped auth layout.** The Story-1.1.1 mockup was Clay-style (no card chrome, ' +
        'wordmark top-left). User asked mid-validation to flip to a more modern card-wrapped ' +
        'layout — a white card with soft shadow, centered on a tinted page background — and to ' +
        'remove the placeholder “Prodect” wordmark entirely. The wordmark removal is the deeper ' +
        'decision: in a real Prodect-planned project, the brand mark is a late-Epic-4 Subtask ' +
        '(agent or human task) scheduled when the product has enough surface for the brand ' +
        'decision to be informed. Shipping UI Subtasks without placeholder branding avoids a ' +
        'filler element becoming load-bearing across every screen. Captured as a current-state ' +
        'principle in PRODECT.md.\n\n' +
        '**Vercel preview-cleanup workflow.** notes.html mistake #25 ("Vercel-Neon Marketplace ' +
        "integration auto-provisions Neon branches per preview but doesn't auto-tear them " +
        'down") had been tracked as unresolved operational debt with a "wait until cadence ' +
        'justifies" deferral. The 1.1.8 + 1.1.9 starter snapshots multiply branch pressure ' +
        '(each new preview deploy gets its own Neon branch), so cleanup became precondition ' +
        'rather than nice-to-have. A `.github/workflows/cleanup-preview-deployments.yml` ' +
        'workflow now listens for `pull_request: closed` and deletes every Vercel preview ' +
        "deployment for the closing PR's head ref; the Vercel-Managed Neon integration " +
        'cascades the branch deletion automatically. Implementation detail worth flagging: ' +
        'initial instinct was to delete the Neon branch directly via the Neon API, but the ' +
        'docs check revealed that under the Vercel-Managed integration, Neon-branch cleanup ' +
        'is bound to Vercel deployment lifecycle (not Git ref lifecycle), so the right ' +
        'primitive is to delete the Vercel deployment. The workflow self-validated on its own ' +
        'first PR merge — when 1.1.10 merged, the just-active workflow caught its own closure ' +
        "event and deleted PR #20's preview.\n\n" +
        '**Why bundled into one Subtask:** both changes were small enough (single-file edit + ' +
        'new workflow file) that splitting them would have meant two PRs with ~30 min of ' +
        'round-trip overhead each. The card change was the trigger; the cleanup workflow was ' +
        'the user\'s gated precondition before dispatching 1.1.8 + 1.1.9 ("we need the neon ' +
        'branch clean on PR merge too in the pipeline before doing 1.1.8 and 1.1.9, add this ' +
        'in the current PR"). Both shipped in PR #20 with two focused commits.\n\n' +
        '**Execution mode:** first Subtask where the planner executed directly rather than ' +
        'dispatching a coding agent. Justification: the scope was small (one layout file + one ' +
        'workflow file + two doc updates), the decisions were settled, and the agent-dispatch ' +
        'overhead (worktree creation, prompt-writing, env setup) outweighed the implementation ' +
        'cost. Calibration point for future small UI / infra Subtasks.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `app/(auth)/layout.tsx` renders the auth pages inside a white card with soft shadow, ' +
        'centered on a tinted page background. No placeholder wordmark anywhere in the layout.\n' +
        '- Card uses existing design tokens (`--radius-card`, `--shadow-elevated`, ' +
        '`--color-surface`) — no new tokens added.\n' +
        '- All four auth pages (sign-in, sign-up, reset-password, reset-password/new) render ' +
        'correctly inside the new wrapper without any per-page changes (the AuthShell ' +
        "component's internal vertical rhythm composes cleanly inside the card).\n" +
        '- `.github/workflows/cleanup-preview-deployments.yml` fires on ' +
        '`pull_request: closed`, enumerates Vercel preview deployments by branch ref, and ' +
        'DELETEs each via the Vercel API. The Vercel-Managed Neon integration cascades the ' +
        'Neon-branch deletion.\n' +
        '- Workflow uses `secrets.VERCEL_TOKEN` (Vercel Access Token, team-scoped) and ' +
        'hardcoded project/org IDs for prodect-core. For the starters (1.1.8 + 1.1.9), the ' +
        'same workflow is parameterized with GitHub repo `vars` instead of hardcoded IDs so ' +
        'each user wires their own.\n' +
        '- PRODECT.md\'s "Current state" entry for the preview-branch debt flips from ' +
        'UNRESOLVED to RESOLVED with a forward reference to this Subtask + the workflow file.\n' +
        '- notes.html mistake #25 gets a Resolution prompt-hint appended with the workflow ' +
        'reference + the "verify the fix\'s mechanism before shipping it" recursive-corrective ' +
        'learning.\n' +
        '- pnpm typecheck, pnpm lint, pnpm test (39/39 Vitest), pnpm test:e2e (2/2 Playwright) ' +
        'all green.\n\n' +
        '## Context refs\n\n' +
        '- `app/(auth)/layout.tsx` — current Clay-style layout from 1.1.5\n' +
        '- `app/globals.css` — existing radius/shadow/surface tokens to compose\n' +
        "- notes.html mistake #25 — the lesson body's three documented cleanup options " +
        '(GitHub Action, Neon `expires_at`, manual)\n' +
        '- Neon docs on Vercel-Managed branch lifecycle: ' +
        'https://neon.com/docs/guides/vercel-branch-cleanup\n' +
        '- Vercel API: `v6/deployments` (list) and `v13/deployments/{id}` (delete)',
    },
    {
      id: '1.1.8',
      title: 'Snapshot Story-1.1 auth into `nextjs-prisma-vercel-starter` (bare starter)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 22,
      dependsOn: ['1.1.7'],
      descriptionMd:
        'Snapshot the auth code shipped in Story 1.1 from `prodect-core` into ' +
        '[moooon-B-V/nextjs-prisma-vercel-starter](https://github.com/moooon-B-V/nextjs-prisma-vercel-starter) ' +
        '(the bare starter), stripping anything Prodect-specific so the starter remains a ' +
        'generic baseline. Same pattern as Subtasks 1.0.6 and 1.0.5.6: this is a snapshot ' +
        'push to `main` of an existing repo, not a fork into a new repo. After this Subtask, ' +
        'every future `"Use this template"` click on the bare starter (whether by the Prodect ' +
        'planner or an external user) yields a project with email/password + Google OAuth ' +
        'wired in by default.\n\n' +
        '**Why this is a Subtask of Story 1.1, not a separate Story:** The backport is ' +
        'mechanical — copy the relevant files from `prodect-core`, run the strip, smoke-test, ' +
        "push. It depends on Story 1.1's auth code existing, so it belongs inside the Story; " +
        'making it a separate Story would just create coordination overhead. Same logic that ' +
        'put 1.0.5.6 inside Story 1.0.5.\n\n' +
        '**Why parallel with 1.1.9 and not sequential:** Both backport Subtasks depend only on ' +
        "1.1.7 (the E2E test passing); they touch separate repos and don't share files. " +
        'Running in parallel saves a day of wall-clock time. If a strip mistake surfaces in ' +
        'one starter, fix-forward in the other rather than serializing.\n\n' +
        "**What you'll do:** Locally rsync the relevant files from `prodect-core/` into a " +
        'sibling clone of the bare starter: `lib/auth/*`, `lib/users/repo.ts`, ' +
        '`lib/email.ts`, `app/api/auth/[...all]/route.ts`, `app/(auth)/*`, `middleware.ts`, ' +
        'the `User` + `OAuthAccount` + `PasswordResetToken` Prisma models (added to the bare ' +
        "starter's schema *alongside* the existing `MigrationMarker` placeholder — keep the " +
        "placeholder so the starter's initial migration story is preserved), and any new " +
        '`.env.example` keys (`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`, ' +
        '`GOOGLE_CLIENT_SECRET`, `EMAIL_PROVIDER=console`). Strip out any Prodect-as-consumer ' +
        'references (mirror the 1.0.6 / 1.0.5.6 strip pattern). Generate a fresh migration ' +
        'for the new auth tables. Verify all 4 quality gates pass (lint, format:check, ' +
        'typecheck, build). Run the end-to-end "Use this template" smoke test: create ' +
        'throwaway repo → clone → install → db-up → migrate dev → dev → sign up with ' +
        'email/password → sign in with Google (using throwaway Google Cloud OAuth creds) → ' +
        'delete throwaway. Then push the single commit to `main`; CI must stay green.\n\n' +
        '## Acceptance criteria\n\n' +
        "- `moooon-B-V/nextjs-prisma-vercel-starter`'s `main` branch advances with a single " +
        'commit that adds the auth code from Story 1.1. `isTemplate` stays true.\n' +
        '- Code shipped: Better-Auth setup, email/password method, Google OAuth provider, ' +
        '`User` + `OAuthAccount` + `PasswordResetToken` tables (User-only schema — no ' +
        'Workspace/multi-tenancy), password-hash helper, user repo, sign-up / sign-in / ' +
        'reset-password pages (unstyled — the bare starter has no design system), email ' +
        'abstraction with dev console provider only.\n' +
        '- All Prodect-as-consumer references stripped: no "Prodect" in app/page.tsx wordmark; ' +
        'no "prodect-core" in README; no Story/Subtask references in comments; ' +
        '`app.theme.*` not `prodect.theme.*` for any localStorage keys carried over.\n' +
        '- Fresh Prisma migration generated for the auth tables; applies cleanly to the bare ' +
        "starter's existing `MigrationMarker` table. `MigrationMarker` retained as the " +
        'placeholder convention.\n' +
        '- `.env.example` documents all new env vars with comments pointing the user (and the ' +
        'planner) to where each comes from — particularly the "Google Cloud OAuth credentials" ' +
        '+ "email provider choice" callouts directing to planner pre-plan Stories.\n' +
        '- README updated to document the auth baseline: list what ships, link to the ' +
        'design-system-and-auth starter as the styled alternative, name the planner-handled ' +
        'choices (multi-tenancy, email provider, Google Cloud OAuth credentials).\n' +
        '- All 4 quality gates green: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, ' +
        '`pnpm build`.\n' +
        '- End-to-end "Use this template" smoke test passes: throwaway repo → clone → install ' +
        '→ db-up → migrate dev → dev → email/password sign-up + sign-in works → Google OAuth ' +
        'sign-in works (with throwaway Google Cloud creds) → throwaway deleted.\n' +
        '- GitHub Actions CI green on the snapshot commit.\n\n' +
        '## Context refs\n\n' +
        '- `prodect-core/lib/auth/*`, `prodect-core/lib/users/repo.ts`, ' +
        '`prodect-core/lib/email.ts`, `prodect-core/app/api/auth/*`, ' +
        '`prodect-core/app/(auth)/*`, `prodect-core/middleware.ts`, ' +
        '`prodect-core/prisma/schema.prisma` — source files to snapshot\n' +
        '- Local clone of [moooon-B-V/nextjs-prisma-vercel-starter]' +
        '(https://github.com/moooon-B-V/nextjs-prisma-vercel-starter) — destination\n' +
        "- Subtask 1.0.6's PR + commit — the precedent for the bare starter's strip pattern\n" +
        "- Subtask 1.0.5.6's PR + commit — the precedent for the snapshot-from-prodect-core " +
        'pattern (this one is conceptually identical but for auth instead of design)\n' +
        '- PRODECT.md — planner-as-consumer principle (what to bake in vs. leave to the ' +
        'planner)',
    },
    {
      id: '1.1.9',
      title: 'Snapshot Story-1.1 auth into `nextjs-prisma-vercel-starter-with-design`',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 25,
      dependsOn: ['1.1.7'],
      descriptionMd:
        'Snapshot the auth code shipped in Story 1.1 from `prodect-core` into ' +
        '[moooon-B-V/nextjs-prisma-vercel-starter-with-design](https://github.com/moooon-B-V/nextjs-prisma-vercel-starter-with-design) ' +
        '(the designed starter), stripping anything Prodect-specific so the starter remains a ' +
        'generic baseline. Functionally identical to 1.1.8 but for the designed starter — the ' +
        'extra work is that the sign-up / sign-in / reset-password pages ship **styled with the ' +
        'design system already in this starter**, not unstyled. This is the higher-value of the ' +
        'two backports because most Prodect-planned projects will use the designed starter (per ' +
        'the design-wizard "skip-all" path).\n\n' +
        "**Why a separate Subtask from 1.1.8:** The designed starter's auth pages must compose " +
        '`Button`, `Input`, `Card` from `components/ui/` (already present in this starter) ' +
        'instead of plain HTML — so the snapshot is not a pure file copy. The pages from ' +
        "`prodect-core`'s `app/(auth)/*` are already styled this way (1.1.5 used the design " +
        'system primitives), so the work is mostly verifying the imports resolve in the ' +
        "designed starter's `tsconfig` paths and the Tailwind tokens render correctly. But " +
        "it's distinct enough that it deserves its own Subtask, parallel with 1.1.8.\n\n" +
        "**What you'll do:** Same rsync + strip + smoke-test + push as 1.1.8, into the " +
        "designed starter's sibling clone. Verify the auth pages render with the design system " +
        "styling intact (the `/tokens` route's primitives flow through to the auth pages " +
        'without any extra work). Run the end-to-end "Use this template" smoke test with extra ' +
        'attention to: (a) the auth pages render in light/dark + default/soft display styles ' +
        'correctly, (b) the "Continue with Google" button uses the secondary Button variant + ' +
        "Google logo per the design-system convention from 1.1.1's mockup, (c) `/tokens` still " +
        'renders the full design-system specimen.\n\n' +
        '## Acceptance criteria\n\n' +
        "- `moooon-B-V/nextjs-prisma-vercel-starter-with-design`'s `main` branch advances " +
        'with a single commit that adds the auth code from Story 1.1. `isTemplate` stays ' +
        'true.\n' +
        '- Code shipped: same as 1.1.8 (Better-Auth, email/password, Google OAuth, schema, ' +
        'repos, pages, email abstraction), PLUS the auth pages styled with the existing design ' +
        'system primitives (`Button`, `Input`, `Card`).\n' +
        '- All design-system code from prior Story 1.0.5 backports stays intact: ' +
        '`components/ui/*`, `app/globals.css` token taxonomy, ' +
        '`lib/contexts/theme-context.tsx`, `lib/theme/*`, `app/tokens/page.tsx`, ' +
        '`docs/DESIGN.md`, `docs/design-system.md`.\n' +
        '- Auth pages render correctly in all 4 theme × display-style combinations (light/dark ' +
        '× default/soft); the "Continue with Google" button styles match the design-system ' +
        'convention from 1.1.1.\n' +
        '- `/tokens` route still renders the full design system specimen page; theme + ' +
        'display-style toggles still work; auth pages still work after toggle.\n' +
        '- All Prodect-as-consumer references stripped: same coverage as 1.1.8.\n' +
        '- Fresh Prisma migration generated; applies cleanly.\n' +
        '- `.env.example` documents the same new env vars as 1.1.8.\n' +
        '- README updated to position this starter as "everything in the bare starter, plus ' +
        'design system, plus auth" — the canonical default for design-system-using projects.\n' +
        '- All 4 quality gates green; CI green on the snapshot commit.\n' +
        '- End-to-end "Use this template" smoke test passes: throwaway repo → clone → install ' +
        '→ db-up → migrate dev → dev → email/password sign-up + sign-in works → Google OAuth ' +
        'sign-in works → `/tokens` still works → theme/display-style toggles still work → ' +
        'throwaway deleted.\n\n' +
        '## Context refs\n\n' +
        '- Same source files from `prodect-core/` as 1.1.8\n' +
        '- Local clone of [moooon-B-V/nextjs-prisma-vercel-starter-with-design]' +
        '(https://github.com/moooon-B-V/nextjs-prisma-vercel-starter-with-design) — ' +
        'destination\n' +
        "- Subtask 1.0.5.6's PR + commit — the precedent for the designed starter's strip " +
        'pattern\n' +
        '- Subtask 1.1.8 (running in parallel) — same agent run, same shape, different ' +
        'destination\n' +
        '- PRODECT.md — planner-as-consumer principle',
    },
    {
      id: '1.1.11',
      title: 'Migrate `middleware.ts` → `proxy.ts` (Next 16 convention) across all three repos',
      status: 'done',
      type: 'code',
      executor: 'human',
      estimateMinutes: 30,
      dependsOn: ['1.1.8', '1.1.9'],
      descriptionMd:
        'Follow-up Subtask added post-1.1.9 to resolve ' +
        '[PRODECT_FINDINGS.md finding #2](PRODECT_FINDINGS.md): Next.js 16 deprecates the ' +
        '`middleware.ts` file convention in favour of `proxy.ts`. The deprecation warning fires ' +
        'on every `pnpm dev` boot across all three repos (prodect-core + both starters, all ' +
        'carrying the same `middleware.ts` verbatim) and will become a hard failure in a future ' +
        'Next major.\n\n' +
        '**Why one Subtask, three PRs:** the same mechanical change shipped into three repos in ' +
        'parallel. The official Next codemod ' +
        '(`npx @next/codemod@canary middleware-to-proxy .`) handles the file + function rename ' +
        'in seconds. No coordinated cross-repo dependency, so three independent PRs were the ' +
        "right shape — each repo's CI gates that repo's merge, no cross-repo " +
        'PR-orchestration overhead.\n\n' +
        '**Why planner_direct, not agent-dispatched:** the change is purely mechanical (one ' +
        "codemod invocation per repo + comment-rot cleanup the codemod doesn't touch). " +
        'Agent-dispatch overhead (worktree creation, prompt-writing, env setup) outweighs the ' +
        'implementation cost — same calibration point as 1.1.10.\n\n' +
        "**What was done:** Ran the codemod in each repo's worktree (file rename + " +
        '`export function middleware` → `export function proxy`). Updated stale doc-comments ' +
        'at the top of the new `proxy.ts` in each repo to reference the new convention name ' +
        "and Next 16's Node.js runtime default (vs. Middleware's Edge default). Updated " +
        "cross-references in each repo's README and the " +
        '`app/(authed)/dashboard/page.tsx` smoke route. Verified `pnpm typecheck`, ' +
        '`pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`, `pnpm test:e2e` all ' +
        'green in each repo; `pnpm dev` boots with no deprecation warning. Shipped 2026-05-27 ' +
        'across three PRs: ' +
        '[prodect-core PR #21](https://github.com/moooon-B-V/prodect-core/pull/21) ' +
        '(merge commit `c031893`); ' +
        '[bare starter PR #2](https://github.com/moooon-B-V/nextjs-prisma-vercel-starter/pull/2) ' +
        '(merge commit `a386d38`); ' +
        '[designed starter PR #2](https://github.com/moooon-B-V/nextjs-prisma-vercel-starter-with-design/pull/2) ' +
        '(merge commit `3d8bbbf`). Post-merge, finding #2 in `PRODECT_FINDINGS.md` received ' +
        'a "Resolved" block matching finding #1\'s pattern. In the same pass, ' +
        '`PRODECT_FINDINGS.md` was moved from `prodect-core/` (where it originated when ' +
        'prodect-core was the first concrete repo) to `prodect_plan/` (its natural home ' +
        'alongside other planner-workflow artifacts like `PRODECT.md` and `notes.html`), ' +
        'since findings now span multiple repos. Move shipped as ' +
        '[prodect-core PR #22](https://github.com/moooon-B-V/prodect-core/pull/22) ' +
        '(merge commit `7fc9831`), with the protocol wording in `PRODECT.md` and `notes.html` ' +
        'updated to point at the new path.\n\n' +
        '## Acceptance criteria\n\n' +
        '- All three repos no longer print the `middleware-to-proxy` deprecation warning on ' +
        '`pnpm dev` boot.\n' +
        '- `middleware.ts` renamed to `proxy.ts` in each repo; exported function renamed ' +
        'accordingly. `config.matcher`, `NextRequest` / `NextResponse` imports, and ' +
        "Better-Auth's `getSessionCookie` are unchanged.\n" +
        '- Doc comments at the top of each `proxy.ts` reference the new file convention and ' +
        'the Node.js runtime default that Proxy ships with.\n' +
        "- Stale `middleware.ts` references in each repo's README and " +
        '`app/(authed)/dashboard/page.tsx` smoke route updated.\n' +
        '- All quality gates green in each repo: `pnpm typecheck`, `pnpm lint`, ' +
        '`pnpm format:check`, `pnpm test` (39/39 vitest), `pnpm build`, `pnpm test:e2e` ' +
        '(2/2 playwright). Dev-server logs show `proxy.ts: …µs` firing on protected-route ' +
        'requests.\n' +
        '- PRODECT_FINDINGS.md finding #2 gets a "Resolved" annotation with the three merge ' +
        "SHAs, matching finding #1's audit-trail convention.\n\n" +
        '## Context refs\n\n' +
        '- Next.js 16 docs: ' +
        '[middleware-to-proxy migration guide](https://nextjs.org/docs/messages/middleware-to-proxy)\n' +
        '- Next.js 16 docs: ' +
        '[proxy.ts file convention reference](https://nextjs.org/docs/app/api-reference/file-conventions/proxy)\n' +
        '- Official codemod: `npx @next/codemod@canary middleware-to-proxy .`\n' +
        '- Better-Auth `getSessionCookie` from `better-auth/cookies` — unchanged across the ' +
        'migration\n' +
        '- `prodect_plan/PRODECT_FINDINGS.md` finding #2 — the trigger',
    },
  ],
};
