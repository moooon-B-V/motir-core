---
kind: task
type: choice
---

Pick the colour theme the product ships with first.

## Question

Which theme should be the default for new workspaces?

## Why this is a choice

**Situation:** two workflows
**Evidence:** designers prefer the light palette while support asks for dark.

## Options

### Light

**Best if you want:** the familiar look
Matches the marketing site.

### Dark

**Best if you want:** less glare at night

## What this choice gates

The default theme migration and the first-run screenshots.

## Scope BOUNDARY

The default only. Per-user overrides already exist.

## Acceptance criteria

- One option is picked and recorded.
- The gated cards are named.

## Context refs

- `lib/theme/default.ts` — where the default is set
- `docs/theming.md` — the theme rules
