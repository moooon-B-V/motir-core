import type { SeedStory } from '../types';

/**
 * Story 1.0.5 — Design system & brand.
 * Faithful transcription of prodect_plan/story-1.0.5-design-system.html (frozen archive).
 */
export const story_1_0_5: SeedStory = {
  id: '1.0.5',
  title: 'Design system & brand',
  status: 'done',
  descriptionMd:
    "Define Motir's visual language before any design Subtask runs. Without this, every design " +
    'prompt would produce a different look — buttons that disagree, spacing that fights, typography ' +
    'that varies per page. The output of this Story is the reference every later "design" Subtask ' +
    'prompt is expected to honor.\n\n' +
    '**Prerequisites:** Prerequisite for every design Subtask in v1. Story 1.1 (auth pages), ' +
    'Story 1.2 (workspace switcher), Story 1.3 (project creation modal), Story 1.5 (app shell), ' +
    "and all of Epic 2/3 UI work depend on this. Epic 4's prompt-generation agent must inject the " +
    'design-system reference into every design-type prompt.',
  verificationRecipeMd:
    '- Open a terminal and run:\n' +
    '\n' +
    '       git checkout story/PROD-1.0.5-design-system\n' +
    '       pnpm dev\n' +
    '\n' +
    '- Open `http://localhost:3000/_tokens` in your browser. You should see:\n' +
    '  - The color palette as labeled swatches (12 colors).\n' +
    '  - The type scale (xs/sm/base/lg/xl).\n' +
    '  - Every primitive component (Button, Input, Textarea, Card, Modal,\n' +
    '    Pill, Tooltip, Toast, Spinner) rendered with every variant.\n' +
    '  - The Empty-state and Error-state sample components.\n' +
    '- Open `/docs/design-system.md` and skim the table of contents. The doc\n' +
    "  should cover: Tokens, Primitives, Patterns, Voice & tone, Don'ts.\n" +
    "  You don't need to read every word — just confirm the structure is\n" +
    '  complete and the screenshots are present.\n' +
    '- Confirm CI is green on the Story PR.\n' +
    '- Confirm the designed starter exists (1.0.5.6 output):\n' +
    '  - Visit `https://github.com/moooon-B-V/nextjs-prisma-vercel-starter-with-design`\n' +
    '  - Confirm the "Use this template" button is visible (marks it as\n' +
    '    a GitHub Template).\n' +
    '  - Click "Use this template" to create a throwaway test repo;\n' +
    '    clone it; run `pnpm install && ./scripts/db-up.sh && pnpm dev`;\n' +
    '    confirm `http://localhost:3000/tokens` renders the full design\n' +
    '    system specimen page; delete the throwaway repo.\n' +
    '- If all five checks pass, approve and merge the PR. If anything is\n' +
    '  missing or off, add a comment and Motir will produce a follow-up\n' +
    '  Subtask to fix it.',
  items: [
    {
      id: '1.0.5.1',
      title:
        'Design system architecture — two-axis theme (Color + Shape), one initial palette, DESIGN.md',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['1.0.1'],
      descriptionMd:
        "Set up Motir's **two-axis theme architecture** (Color × Shape, mirroring " +
        "[dooooWeb](https://github.com/yuezhu/doooo)'s implementation) and ship ONE " +
        "initial palette + display style. Write Motir's **DESIGN.md** in " +
        '[Google Stitch format](https://stitch.withgoogle.com/docs/design-md/format/) ' +
        '(9 sections) as the planner-agent reference document — Epic 4 will inject this into every ' +
        'design-type Subtask prompt.\n\n' +
        '**Why this architecture:** users want to customize their workspace look. ' +
        'Hard-coding one palette into `globals.css` would force a rebuild for every ' +
        'theme change. The two-axis pattern lets users flip `data-palette="warm"` or ' +
        '`data-display-style="soft"` on `<html>` and the entire UI ' +
        'updates via CSS only — no React re-render. dooooWeb proved this works at scale.\n\n' +
        "**Source for the initial palette:** Motir's first palette is a " +
        "**blend of Notion's colors** (warm earthy minimalism — terracotta, ochre, " +
        "sage, soft surfaces) and **Figma's shape language** (vibrant, playful, " +
        'energetic component shapes). The coding agent fetches both via ' +
        '`npx getdesign@latest add notion` and `add figma`, then synthesizes. ' +
        "The DESIGN.md documents Motir's blended choices, not Notion's or Figma's verbatim.\n\n" +
        '**Typography stack (locked):** ' +
        '**Inter** (variable) for sans body + UI, ' +
        '**Source Serif 4** (variable) for serif headings — ' +
        "Adobe's humanist serif made for the Notion-style pairing, " +
        '**JetBrains Mono** (variable) for code blocks + IDs. ' +
        'All loaded via `next/font/google` as variable fonts (~150 KB total for all ' +
        'weights, vs ~500 KB if loaded as separate weight files). Each is open-source. ' +
        'See [notes.html mistake #1](../notes.html) framing: this is a deliberate ' +
        'choice with reasoning, not a default-by-accident.\n\n' +
        '**Why "warm not cold":** per Yue\'s direction, AI-native ≠ technical-cold. ' +
        'Notion\'s warm minimalism is the explicit antidote to the "AI tools look like terminals" ' +
        "aesthetic. Figma's shape personality adds energy without sacrificing approachability.\n\n" +
        '**Token-growth principle (anti-overplanning):** dooooWeb has ~700 lines ' +
        'of element tokens (`--el-*`) because it has a full UI. Motir has ZERO real ' +
        'UI components yet. Start with the bare minimum (~10-15 element tokens covering page bg / ' +
        "text / accent / surface / border). As Story 1.0.5's component primitives (1.0.5.2: " +
        'Button/Input/Card/etc.) land, each one ADDS its own element tokens. Do NOT front-load ' +
        "tokens for components that don't exist. See [notes.html mistake #20](../notes.html) " +
        'on not re-deriving generic boilerplate.\n\n' +
        "**What you'll do:**\n\n" +
        '1. Fetch both source design systems: `npx getdesign@latest add notion` and\n' +
        '   `npx getdesign@latest add figma`. These drop DESIGN.md-format files into\n' +
        '   the project; identify where they land (likely `./DESIGN-notion.md` /\n' +
        '   `./DESIGN-figma.md` or `./design/` subfolder).\n' +
        "2. Synthesize ONE palette from Notion's colors + Figma's shape tokens. Pull concrete\n" +
        "   hex values from Notion's file (light + dark mode if both are documented) and\n" +
        "   shape/radius/shadow/spacing values from Figma's.\n" +
        '3. Build the layered CSS architecture in `app/globals.css`:\n' +
        '   - **Tier 0 — Base @theme block**: `--color-*` (primary,\n' +
        '     secondary, accent, background, foreground, surface, muted, border, etc.) +\n' +
        '     `--radius-*` + `--shadow-*` + `--spacing-*` +\n' +
        '     typography (`--font-sans`, `--font-serif`,\n' +
        '     `--font-size-*`). These get auto-exposed as Tailwind utility classes\n' +
        "     (bg-primary, rounded-card, shadow-elevated, etc.) by Tailwind v4's @theme inline.\n" +
        '   - **Tier 1 — Light/dark base**: `[data-theme="dark"]` selector overrides the base vars for dark mode.\n' +
        '   - **Tier 2 — Display style overrides**: `[data-display-style="soft"]`,\n' +
        '     `[data-display-style="flat"]`, `[data-display-style="pill"]`\n' +
        '     overrides radius/shadow/spacing tokens (initially: just `default` and one\n' +
        '     alternate to prove the mechanism works; more can be added later).\n' +
        '   - **Tier 3 — Element-token layer**: `--el-*` tokens for\n' +
        "     page/surface/text/border, referencing Tier 0's `--color-*`. Keep\n" +
        '     minimal — 10-15 tokens for what currently exists. This is the abstraction layer\n' +
        '     that future palettes will override.\n' +
        '4. Build a `ThemeProvider` React context at\n' +
        "   `lib/contexts/theme-context.tsx` (mirroring dooooWeb's pattern). Three\n" +
        '   state values: `themePattern` (system | light | dark),\n' +
        '   `themeColor` (the accent color, initially just one option),\n' +
        '   `displayStyle` (default | one alternate). Persists to localStorage.\n' +
        '   Injects `data-theme`, `data-color`, `data-display-style`\n' +
        '   attrs on `<html>`. Wrapped around the app in `app/layout.tsx`.\n' +
        '5. Update `app/page.tsx` to use Tailwind token classes (e.g.,\n' +
        '   `bg-background text-foreground`) — no `text-[var(--text)]`\n' +
        '   bracket syntax, no hardcoded hex codes.\n' +
        '6. Build `app/tokens/page.tsx` — the design-system reference route at\n' +
        '   `/tokens`. Renders: all color swatches with names + hex, type scale\n' +
        '   samples (xs/sm/base/lg/xl with line heights visible), radius samples (each\n' +
        '   `--radius-*` rendered as a box), shadow samples, a button stub in each\n' +
        '   display-style to visually compare. This is the live spec; 1.0.5.5 will screenshot it.\n' +
        '7. Write `docs/DESIGN.md` in Stitch format. The 9 canonical sections:\n' +
        '   1. Visual Theme & Atmosphere\n' +
        '   2. Color Palette & Roles (semantic names, hex values, when to use each)\n' +
        '   3. Typography Rules (font families, hierarchy, sizes, weights, line heights)\n' +
        '   4. Component Stylings (buttons, cards, inputs — interactive states; mostly empty\n' +
        '      initially, fills as 1.0.5.2 lands)\n' +
        '   5. Layout Principles (spacing scale, grid, whitespace strategy)\n' +
        '   6. Depth & Elevation (shadow tokens, surface tiers)\n' +
        "   7. Do's and Don'ts (design guardrails)\n" +
        '   8. Responsive Behavior (breakpoints, touch targets)\n' +
        '   9. Agent Prompt Guide (color references for AI use — what to inject into\n' +
        '      Subtask prompts)\n' +
        '   Reference DESIGN-notion.md and DESIGN-figma.md as inspiration sources at the top.\n' +
        '8. Optional cleanup: delete the fetched DESIGN-notion.md / DESIGN-figma.md files if\n' +
        "   they're not useful long-term; OR keep them in a `docs/inspiration/`\n" +
        '   folder as references. Flag the choice in the PR.\n' +
        '9. Verify all 4 quality gates: lint, format:check, typecheck, build.\n\n' +
        '## Acceptance criteria\n\n' +
        '**Layered CSS architecture:**\n\n' +
        '- `app/globals.css` has all four tiers (@theme base; light/dark; display-style overrides; `--el-*` element tokens) with comments explaining each tier.\n' +
        '- At minimum 2 display styles wired up (`default` + one alternate like\n' +
        '  `soft` or `flat`) to prove the mechanism. More can land in\n' +
        '  follow-up Subtasks.\n' +
        '- Element tokens (`--el-*`) are MINIMAL (~10-15 covering only what\n' +
        '  `app/page.tsx` + `/tokens` route actually use). Token growth\n' +
        '  is documented as deferred to future Subtasks.\n' +
        '- Tailwind classes like `bg-background`, `text-foreground`,\n' +
        '  `bg-primary`, `text-muted`, `rounded-card`,\n' +
        '  `shadow-card` all work in JSX.\n' +
        '- No hardcoded hex colors in `/app` or `/components`\n' +
        '  (grep-check before committing).\n\n' +
        '**ThemeProvider:**\n\n' +
        '- `lib/contexts/theme-context.tsx` exports `ThemeProvider` +\n' +
        '  `useTheme()` hook. State: `themePattern`,\n' +
        '  `displayStyle`. Persists to localStorage; rehydrates on mount.\n' +
        '- Injects `data-theme` and `data-display-style` attrs on\n' +
        '  `<html>` via `document.documentElement.setAttribute` in\n' +
        '  useEffect (server-rendered HTML stays clean; client hydrates and applies).\n' +
        '- Wrapped around the app in `app/layout.tsx`.\n\n' +
        '**Typography:**\n\n' +
        '- Three fonts loaded via `next/font/google` in `app/layout.tsx`:\n' +
        '  Inter (variable, sans), Source Serif 4 (variable, serif), JetBrains Mono (variable,\n' +
        '  mono).\n' +
        '- Each font assigned a CSS variable (`--font-sans`,\n' +
        '  `--font-serif`, `--font-mono`) via the next/font className\n' +
        '  pattern on `<html>`.\n' +
        '- `@theme` exposes those as Tailwind utility classes — `font-sans`,\n' +
        '  `font-serif`, `font-mono` all work.\n' +
        '- Body text uses Inter by default. Headings (h1, h2, h3) use Source Serif 4 by\n' +
        '  default — set via a base CSS rule or Tailwind plugin.\n\n' +
        '**Pages:**\n\n' +
        '- `app/page.tsx` uses Tailwind token classes; the wordmark renders in\n' +
        "  Source Serif 4 (the headline font); visual matches Notion's warm minimalism with\n" +
        "  Figma's shape personality.\n" +
        '- `app/tokens/page.tsx` renders all color swatches, type scale (each\n' +
        '  size labeled with its name + font family), radius/shadow samples, and a button stub\n' +
        '  per display-style.\n\n' +
        '**DESIGN.md:**\n\n' +
        "- `docs/DESIGN.md` exists in Google Stitch's 9-section format.\n" +
        "- Content reflects Motir's blended choices, not Notion's or Figma's verbatim. The\n" +
        '  top of the file credits both as inspiration sources.\n' +
        '- The "Agent Prompt Guide" section is concrete enough that Epic 4\'s planner can\n' +
        '  inject it directly into design-type Subtask prompts.\n\n' +
        '**Quality gates:**\n\n' +
        '- `pnpm lint`, `pnpm format:check`, `pnpm typecheck`,\n' +
        '  `pnpm build` all pass with zero warnings.\n' +
        '- CI green on the PR.\n' +
        '- The `/tokens` route renders correctly on the Vercel preview deploy.\n\n' +
        '## Context refs\n\n' +
        '- [getdesign.md](https://getdesign.md) — the spec collection;\n' +
        '  `npx getdesign@latest add notion` and `add figma` fetch source files\n' +
        '- [Google Stitch DESIGN.md format](https://stitch.withgoogle.com/docs/design-md/format/) — the 9-section spec\n' +
        '- [voltagent/awesome-design-md](https://github.com/voltagent/awesome-design-md) — collection of real DESIGN.md examples\n' +
        '- `/Users/yuezhu/projects/doooo/dooooWeb/src/styles/` — reference implementation of the two-axis architecture (read `index.css` + `element-tokens.css` + a palette file)\n' +
        '- `/Users/yuezhu/projects/doooo/dooooWeb/src/lib/contexts/theme-context.tsx` — reference for the React provider pattern\n' +
        '- **Tailwind v4 (NOT v3)** — theme tokens live in CSS via `@theme inline`, no `tailwind.config.ts` in the repo\n' +
        '- `app/globals.css` (current state from 1.0.1 — base 8 tokens already there)\n' +
        '- [Next.js next/font docs](https://nextjs.org/docs/app/api-reference/components/font) — loading + CSS variables pattern\n' +
        '- [Inter](https://fonts.google.com/specimen/Inter), [Source Serif 4](https://fonts.google.com/specimen/Source+Serif+4), [JetBrains Mono](https://fonts.google.com/specimen/JetBrains+Mono) — the three variable fonts to load',
    },
    {
      id: '1.0.5.2',
      title:
        'Primitive components — Button, Input, Textarea, Card, Modal, Pill, Tooltip, Toast, Spinner',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 35,
      dependsOn: ['1.0.5.1'],
      descriptionMd:
        'Build the React primitive components that every screen will compose from. Nine primitives ' +
        "cover almost everything Motir's UI needs: Button (4 variants), Input, Textarea, Card, " +
        'Modal, Pill / Tag, Tooltip, Toast, Spinner. Each must use only the tokens from 1.0.5.1 — ' +
        'never hardcoded values — so a future theme tweak propagates through one source.\n\n' +
        '**Why this is the biggest Subtask in Story 1.0.5:** primitives are the foundation ' +
        'of every later UI Subtask in the entire project. Getting them right (accessible, consistent, ' +
        'composable) saves work in every Subtask that touches the UI; getting them wrong propagates ' +
        'problems for months. This Subtask deserves the most attention in the story.\n\n' +
        "**What you'll do:** For each primitive, create a file under " +
        '`/components/ui/<Name>.tsx` with a typed props interface, all variants ' +
        'implemented, and full keyboard / aria support. Use `class-variance-authority` ' +
        'for variant management and `tailwind-merge` for class composition (the ' +
        'modern React + Tailwind primitive pattern). Render every variant + state of every ' +
        'primitive on the `/app/_tokens/page.tsx` route from 1.0.5.1 as a living ' +
        'style guide.\n\n' +
        '## Acceptance criteria\n\n' +
        '- **Button**: variants `primary | secondary | ghost | danger` × sizes `sm | md | lg` × states `default | hover | active | focus | disabled | loading`. Loading state shows the Spinner inline.\n' +
        '- **Input**, **Textarea**: with label, error message, helper text, disabled state, prefix/suffix slots.\n' +
        '- **Card**: with optional header / footer slots, hover state, optional clickable mode (wraps in `<a>` or button).\n' +
        '- **Modal**: accessible (focus trap, ESC closes, click-outside closes, returns focus on close), supports a header / body / footer slot pattern.\n' +
        '- **Pill** / **Tag**: variants for status (planned / in-progress / done) and severity (info / warn / danger / success).\n' +
        '- **Tooltip**: appears on hover + focus, sensible positioning, accessible name on the trigger.\n' +
        '- **Toast**: stackable, auto-dismiss with hover-to-pause, variants (info / success / warn / error).\n' +
        '- **Spinner**: 3 sizes; works inside Button and as standalone.\n' +
        '- Every primitive uses ONLY tokens from `globals.css` — zero hardcoded hex / px values.\n' +
        '- `/app/_tokens/page.tsx` renders all primitives × all variants × key states as a single specimen page.\n' +
        '- Each primitive has a brief JSDoc `@example` comment with a minimal usage sample.\n\n' +
        '## Context refs\n\n' +
        '- `/app/globals.css` (from 1.0.5.1) — the token source\n' +
        '- `tailwind.config.ts` (from 1.0.5.1) — the Tailwind theme\n' +
        '- [awesome-design-md](https://github.com/VoltAgent/awesome-design-md) — open-source component-pattern corpus, fetched at prompt-gen time\n' +
        '- Radix UI primitives docs (URL) — for the unstyled accessibility primitives we can wrap (Modal, Tooltip, Toast)\n' +
        '- `cva` + `tailwind-merge` docs',
    },
    {
      id: '1.0.5.3',
      title: 'Empty-state & error-state patterns (reusable components)',
      status: 'done',
      type: 'design',
      executor: 'coding_agent',
      estimateMinutes: 12,
      dependsOn: ['1.0.5.2'],
      descriptionMd:
        'Every screen in Motir will eventually have an empty state ("you don\'t have any ' +
        'projects yet — create your first one") and at least one error state ("we couldn\'t load ' +
        'this — try again"). If each screen invents its own version, the product feels ' +
        'inconsistent. This Subtask produces two reusable React components — `EmptyState` ' +
        'and `ErrorState` — that every screen composes when it needs them.\n\n' +
        '**Why these are separate from the primitives:** primitives (1.0.5.2) are ' +
        'atoms — Button, Input, Card. Empty / error states are compositions — they use a primitive ' +
        '(Card) plus an icon, headline, body text, and a CTA. They\'re closer to "patterns" than ' +
        '"atoms." Keeping them in their own Subtask gives them the focused design attention they ' +
        "deserve (they're the screens users see when something's wrong; the polish bar is high).\n\n" +
        "**What you'll do:** Create `/components/ui/EmptyState.tsx` and " +
        '`/components/ui/ErrorState.tsx`. Each takes `title`, ' +
        '`description`, optional `icon`, optional `action` ' +
        '(a Button or button-shaped link), and renders inside a Card. Add minimum-viable ' +
        'illustrations — even a single nice SVG icon per state is enough for v1. Add them to the ' +
        'specimen page from 1.0.5.2 with at least 2 sample uses each.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `<EmptyState title description? icon? action? />` renders a centered, padded card with an icon (default: a friendly placeholder SVG), a title (h2-equivalent), an optional description (muted text), and an optional CTA (typically a Button).\n' +
        '- `<ErrorState title description? error? retry? />` renders similarly but with a warning/error visual treatment. `error` can be an `Error` object whose message is shown when in dev mode; `retry` is an optional callback that shows a "Try again" button.\n' +
        '- Both use only primitives from 1.0.5.2 — no new component patterns introduced.\n' +
        '- Specimen page renders 2 sample uses of each (e.g., "no projects yet" empty + "couldn\'t load workspace" error + "no comments" empty + "PR webhook failed" error).\n' +
        '- Accessible: error state has `role="alert"`; both have semantic heading.\n\n' +
        '## Context refs\n\n' +
        '- `/components/ui/Card.tsx`, `Button.tsx` (from 1.0.5.2) — the building blocks\n' +
        '- `/app/_tokens/page.tsx` (from 1.0.5.1, extended in 1.0.5.2) — to add specimens to\n' +
        '- Empty-state UX patterns reference (Vercel / Linear / Stripe examples — fetched at prompt-gen)',
    },
    {
      id: '1.0.5.5',
      title: 'Write `/docs/design-system.md` — tokens, primitives, voice/tone, examples',
      status: 'done',
      type: 'copy',
      executor: 'coding_agent',
      estimateMinutes: 20,
      dependsOn: ['1.0.5.1', '1.0.5.2', '1.0.5.3'],
      descriptionMd:
        'Write the canonical design-system reference document at `/docs/design-system.md`. ' +
        "This file is the **single most-referenced artifact in Epic 4's prompt-generation** " +
        '— every design-type Subtask prompt will inject it as context. The quality of this document ' +
        'directly determines the visual consistency of every later UI Subtask.\n\n' +
        '**Why coding-agent-executed (corrected from earlier "human" assignment — see ' +
        '[notes.html mistake #21](../notes.html)):** this is a synthesis ' +
        'document. It pulls together what 1.0.5.1–3 produced (tokens in ' +
        '`app/globals.css`, primitives in `components/ui/*` with rich ' +
        'JSDoc, patterns in `EmptyState.tsx` + `ErrorState.tsx`, and the ' +
        'architectural spec in `docs/DESIGN.md`) and recombines them into a single ' +
        'user-manual-style reference. That synthesis is a coding-agent strength: deterministic ' +
        'recombination of existing source files into prose. The earlier "human writes this ' +
        'faster and better" rationale was wrong on every axis (see mistake #21 for the full ' +
        'breakdown).\n\n' +
        "**What you'll do:** Write a single Markdown file with these sections in " +
        'order: (1) *Tokens* — the color palette as a swatch table, type scale, spacing ' +
        'scale, with code snippets for each; (2) *Primitives* — each component from 1.0.5.2 ' +
        'with its variant matrix, a code sample, and a one-line "when to use this"; (3) *Patterns* ' +
        '— empty + error states from 1.0.5.3 with screenshots; (4) *Voice & tone* — 4-6 ' +
        "principles with do/don't examples (confident not corporate, warm not cute, specific not " +
        "vague, honest about AI limitations); (5) *Don'ts* — common anti-patterns to avoid. " +
        'Total length: ~1500-2000 words. Include screenshots from the specimen page.\n\n' +
        '## Acceptance criteria\n\n' +
        '- File exists at `/docs/design-system.md`.\n' +
        "- Has all 5 sections: Tokens, Primitives, Patterns, Voice & tone, Don'ts.\n" +
        '- Tokens section: color swatches as a Markdown table, type scale, spacing scale, with the relevant CSS variable name + Tailwind class for each.\n' +
        '- Primitives section: each of the 9 primitives has its variant matrix + a minimal code sample + a 1-line "when to use this" guideline.\n' +
        '- Patterns section: empty state + error state, with screenshots embedded from the specimen page.\n' +
        "- Voice & tone section: 4-6 numbered principles, each with a do / don't example pair.\n" +
        '- Don\'ts section: 5-8 common anti-patterns ("don\'t introduce new colors outside the palette," "don\'t put primary buttons in destructive places," etc.).\n' +
        '- Length: 1500-2000 words.\n' +
        "- Tone of the doc itself models the project's voice (confident, specific, honest).\n" +
        '- Linked from `README.md` in the docs section.\n\n' +
        '## Context refs\n\n' +
        '- `/app/globals.css` (from 1.0.5.1) — the actual tokens to document\n' +
        '- `/components/ui/*` (from 1.0.5.2 and 1.0.5.3) — the primitives + patterns to document\n' +
        '- `/app/_tokens/page.tsx` — the live specimen page for screenshots\n' +
        '- vision.html principle 13 (design-first) — to inform the "Voice" section',
    },
    {
      id: '1.0.5.6',
      title: 'Create `moooon-B-V/nextjs-prisma-vercel-starter-with-design` (MIT, GitHub Template)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 20,
      dependsOn: ['1.0.5.5'],
      descriptionMd:
        'Snapshot `motir-core` at the end of Story 1.0.5 (i.e., with the full ' +
        'design system landed: tokens, primitives, patterns, `docs/design-system.md`, ' +
        '`/tokens` specimen page) into a brand-new public GitHub Template repo at ' +
        '`moooon-B-V/nextjs-prisma-vercel-starter-with-design`. This is the ' +
        '**designed starter** referenced in ' +
        '[design_wizard.html](../design_wizard.html) — the fork Motir hands future ' +
        "users who skip the design wizard (and use Motir's defaults).\n\n" +
        "**Why this Subtask is needed (Layer-2 context):** the design wizard's " +
        '"skip-all" outcome says "no design Story will be planned; use the designed starter." ' +
        'For that to be a real path, the designed starter has to exist as a forkable repo. This ' +
        "Subtask creates it. Future Motir users who skip the wizard get this repo's snapshot; " +
        'users who pick any axis get the bare starter (`nextjs-prisma-vercel-starter`, ' +
        'shipped in 1.0.6) plus a planned design Story that builds the system from scratch with ' +
        'their choices baked in.\n\n' +
        '**Why now (last Subtask of Story 1.0.5):** at this commit, ' +
        '`motir-core` contains the generic Next.js + Prisma + Tailwind + ' +
        'ESLint/Prettier + Vercel + Neon scaffolding *plus* the full design system ' +
        '(1.0.5.1 architecture, 1.0.5.2 primitives, 1.0.5.3 patterns, 1.0.5.5 ' +
        'design-system.md) — and *nothing* Motir-the-product-specific (no User model ' +
        'yet, no workspace tables, no auth wiring, no work-item schema). Forking now means ' +
        "minimal stripping. If we waited until Stories 1.1 / 1.2 / 1.4 land, we'd have to " +
        'surgically remove Motir-the-product code, which is harder and easier to get wrong. ' +
        'This is a semantic-ordering constraint: **1.0.5.6 must close before any ' +
        'Motir-the-product code (Story 1.1+ auth, workspaces, etc.) merges to ' +
        "`motir-core`'s main.**\n\n" +
        '**Mechanism: manual copy + new repo + mark as Template** (NOT a GitHub ' +
        'fork) — same pattern as 1.0.6. GitHub Templates create a new repo with a clean ' +
        'single-commit history when downstream users click "Use this template" — no inherited ' +
        'Motir git history, no "forked from" badge. A raw fork would carry Motir\'s planning ' +
        'commits forever and make the template look like "a fork of Motir" to anyone browsing ' +
        'the repo.\n\n' +
        '**License: MIT**, not GPL-3.0. Same rationale as 1.0.6 — templates ' +
        "ship under MIT because GPL's copyleft requirement repels would-be forkers. " +
        '`motir-core` stays GPL-3.0; the designed starter is independent and ' +
        'MIT-licensed.\n\n' +
        "**Value proposition (for the README pitch):** the designed starter's " +
        'differentiator vs. the bare starter is the *full design system already wired in*. ' +
        'A user who forks this gets: 2-axis theme system (Color × Shape) with light/dark + soft ' +
        'display style, Source Serif 4 + Inter + JetBrains Mono via next/font, 9 primitive ' +
        'components (Button, Input, Card, Modal, Pill, Tooltip, Toast, Spinner, + ' +
        'FormField helper), 2 patterns (EmptyState, ErrorState), a `/tokens` live ' +
        'spec route, and `docs/design-system.md` as the canonical reference. Plus ' +
        'inherited gotchas from the bare starter (postinstall, DATABASE_URL_UNPOOLED, etc.). ' +
        'The README should sell these as "everything in nextjs-prisma-vercel-starter, plus a ' +
        'polished design system you can extend or replace."\n\n' +
        "**What you'll do:**\n\n" +
        '1. Create the empty public repo: `gh repo create moooon-B-V/nextjs-prisma-vercel-starter-with-design --public`\n' +
        '2. Locally: copy the current `motir-core` tree (sans `.git`,\n' +
        '   `node_modules`, `.next`) into a new sibling directory.\n' +
        '3. `git init`, set the remote to the new repo, single initial commit.\n' +
        '4. Apply the strip/genericize edits (see Acceptance criteria for the full list).\n' +
        "   The strip is *narrower* than 1.0.6's because the design system stays — only\n" +
        '   Motir-the-product mentions (wordmark in `app/page.tsx`, README pitch\n' +
        '   copy, planning-doc references) need to be genericized.\n' +
        '5. Push to main as the initial commit. Verify all four quality gates pass.\n' +
        '6. Mark as template: `gh repo edit moooon-B-V/nextjs-prisma-vercel-starter-with-design --template`\n' +
        '7. Smoke-test: click "Use this template" on the GitHub repo page, create a throwaway\n' +
        '   test repo, clone it, run `pnpm install && ./scripts/db-up.sh && pnpm dev`,\n' +
        '   confirm `localhost:3000` renders the generic placeholder AND\n' +
        '   `localhost:3000/tokens` renders the design system specimen page, then\n' +
        '   delete the throwaway repo.\n\n' +
        '## Acceptance criteria\n\n' +
        '**Repo + GitHub setup:**\n\n' +
        '- GitHub repo `moooon-B-V/nextjs-prisma-vercel-starter-with-design` exists, **public**, **MIT**-licensed.\n' +
        '- Repo is marked as a GitHub Template (`is_template: true`) — the "Use this template" button is visible on the repo page.\n' +
        '- Single initial commit; no inherited Motir git history.\n\n' +
        '**License + branding strip:**\n\n' +
        '- `LICENSE` is the canonical MIT text, copyright "© 2026 moooon B.V." or similar.\n' +
        '- `package.json`\'s `"license": "MIT"`, `"name": "nextjs-prisma-vercel-starter-with-design"`, generic `"description"` (no Motir mention).\n' +
        '- `app/page.tsx` is a generic placeholder (e.g., "Next.js + Prisma starter, with design system"); NO "Motir" wordmark. May reference `/tokens` to show off the design system.\n' +
        '- `app/layout.tsx` metadata uses generic title and description (no Motir mention).\n' +
        '- README does NOT reference Motir, `motir-ai`, `motir-core`, `vision.html`, `feasibility.html`, `design_wizard.html`, or any planning docs.\n' +
        '- README\'s value proposition: leads with "everything in `nextjs-prisma-vercel-starter`, plus a polished design system" and links to `docs/design-system.md` + `docs/DESIGN.md` as the references.\n\n' +
        '**Design system preservation (the load-bearing part):**\n\n' +
        '- `components/ui/*` ships intact — all 9 primitives + 2 patterns + FormField helper, with their JSDoc preserved.\n' +
        '- `app/globals.css` ships intact — full 4-tier token taxonomy, light/dark + soft display style.\n' +
        '- `app/tokens/page.tsx` ships intact — the live specimen page renders all tokens, primitives, and patterns.\n' +
        '- `docs/DESIGN.md` ships intact (architectural spec).\n' +
        '- `docs/design-system.md` ships intact (canonical reference). Any sentences that mention "Motir" by name as the consumer should be genericized to "this starter" or "the project that forks this template."\n' +
        '- `lib/utils/cn.ts`, `lib/contexts/theme-context.tsx`, `lib/theme/*` all ship intact.\n' +
        '- Composition stack deps stay in `package.json`: `class-variance-authority`, `tailwind-merge`, `clsx`, `@radix-ui/react-{dialog,tooltip,toast}`, `lucide-react`, fonts (next/font handles them — no package additions).\n\n' +
        '**DB naming convention:**\n\n' +
        '- DB user/password/name in `docker-compose.yml`, `.env.example`, `scripts/db-up.sh`, and `.github/workflows/ci.yml` all use `nextjs_prisma_vercel_starter_with_design` (snake_case).\n' +
        '- Docker container name: `nextjs-prisma-vercel-starter-with-design-postgres`.\n' +
        '- Volume name: `nextjs-prisma-vercel-starter-with-design-pg-data`.\n\n' +
        '**Schema:**\n\n' +
        '- `prisma/schema.prisma`: drop any "Motir" comment; keep the placeholder model and the migration file as-is.\n\n' +
        '**Quality gates:**\n\n' +
        '- All four quality gates pass: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm build`.\n' +
        '- GitHub Actions CI runs on the initial commit and goes green.\n\n' +
        '**End-to-end smoke test (the load-bearing AC):**\n\n' +
        '- Click "Use this template" in the GitHub UI; create a throwaway test repo; clone it; run `pnpm install && ./scripts/db-up.sh && pnpm dev`; confirm `localhost:3000` renders the generic placeholder; confirm `localhost:3000/tokens` renders the full design system specimen page with all primitives + patterns + theme/display-style toggles working; confirm `pnpm prisma migrate dev --name init` works; delete the throwaway repo.\n\n' +
        '**Layer-2 link:**\n\n' +
        "- The repo's existence is what makes the design wizard's \"skip-all\" path real. After this Subtask closes, [design_wizard.html](../design_wizard.html)'s reference to `moooon-B-V/nextjs-prisma-vercel-starter-with-design` resolves to a real GitHub repo.\n\n" +
        '## Context refs\n\n' +
        '- [design_wizard.html](../design_wizard.html) — the Layer-2 doc this Subtask makes real\n' +
        '- [Subtask 1.0.6](story-1.0-project-bootstrap.html#1.0.6) — the sibling pattern (forking `motir-core` into the bare starter); mirror its strip/template/MIT steps\n' +
        '- [notes.html mistake #20](../notes.html) — the lesson driving both starter Subtasks\n' +
        "- `motir-core`'s current tree at the end of Story 1.0.5 — the source to fork from\n" +
        '- GitHub\'s ["Creating a template repository"](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-template-repository) docs',
    },
  ],
};
