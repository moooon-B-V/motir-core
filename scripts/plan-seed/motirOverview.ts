// Motir's own canonical public Overview/README + hero fields (Story 6.12 ·
// Subtask 6.12.4; Story 6.16 · Subtask 6.16.7 split the hero out of the body).
//
// Seeded onto the `motir` project's public hero — `publicTagline` (the hero
// subtitle), `publicTags` (the hero meta pills), and `publicOverviewMd` (the
// README body) — so the live public tenant renders real copy (not the
// empty-fallback auto-intro). The copy is the design/public-projects/ Panel 1
// text 1:1 (see design-notes.md "Copy index" + story-6.12.ts §6.12.4): the
// tagline + tags now live in their own fields; the body is PART 1 (the
// self-improving loop), PART 2 ("Vibe project" — the three layers, end to end),
// then Contribute. Framed as THREE LAYERS end-to-end — NEVER "AI project
// management".
//
// Plain GitHub-flavoured Markdown (headings + a numbered list + a bullet list +
// links), so the shipped MarkdownView renders it on the public Overview tab.

// The hero subtitle (Story 6.16) — seeded onto `publicTagline`, no longer the
// opening line of the README body.
export const MOTIR_PUBLIC_TAGLINE = `Vibe your whole project. Bring an idea — Motir's three AI layers plan it, track it, and ship it, end to end. You're looking at Motir, built in Motir.`;

// The hero meta pills (Story 6.16) — seeded onto `publicTags`.
export const MOTIR_PUBLIC_TAGS = ['Vibe project', 'Open source', 'GPL-3.0', 'MCP-native'];

export const MOTIR_PUBLIC_OVERVIEW_MD = `## You're looking at Motir, inside Motir

This is Motir's own project — the live board, roadmap, and backlog we use to build Motir. We build Motir with Motir: every feature here started as a work item on this board, moved through these columns, and was shipped by the same agents that turn work items into code.

## A self-improving loop — and you're in it

This is also our public feedback portal, and it's not a suggestion box that goes nowhere. The bugs you report and the ideas you upvote land in Motir's triage, get planned as work items right here, and are picked up by Motir to build the next version of Motir. You're not just watching the roadmap — you're shaping it.

1. You submit a bug or an idea — it enters our triage.
2. We plan it as a work item on this board.
3. Motir's coding agent turns it into a pull request.
4. It ships — and lands as Done on this very roadmap.

## Vibe project

You've heard of vibe coding — describe what you want, and the AI writes the code. A vibe project takes that to the *whole* project: not just the code, but the design, the marketing, the legal, the research — everything it takes to ship. You bring the intent; Motir's three layers carry it from idea to shipped, end to end:

- **An AI planner** turns a conversation into a structured plan — epics, stories, and work items of every kind (design, marketing, legal, engineering…), with dependencies.
- **An AI-native project manager** holds the work — boards, sprints, the system of record. It's **MCP-native**, so your own agents and tools read and write Motir directly.
- **A hosted coding agent** picks up the engineering work items and ships the code — Motir runs it for you, no setup.

You stay at the level of intent; Motir plans, tracks, and ships the whole thing — code and everything around it. That's a **vibe project**.

## Contribute

Found a bug or have an idea? Submit a request — a minute of your time feeds straight into the loop. Want to go deeper? The PM core is open source (GPL-3.0) on [GitHub](https://github.com/).
`;
