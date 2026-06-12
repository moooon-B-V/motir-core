// Project avatar registry (Story 6.8 · Subtask 6.8.1) — the validation
// contract for `project.avatarIcon` + `project.avatarColor`.
//
// A project avatar is a PRESET icon key + a colour-swatch key (NOT an image
// upload — the recorded deviation: Jira's own default avatars are a preset
// library, and the 2.3.7 upload primitive is issue-attachment-scoped). This
// module is the single source of truth for the legal keys; the `changeKey` /
// `updateDetails` service validates caller input against it, and the 6.8.3
// design + 6.8.4 picker render from the SAME two key sets.
//
// DELIBERATELY UI-FREE (the same split issueTypes.ts → parentRules.ts uses to
// keep lucide-react out of the service module graph). The icon keys are plain
// STRINGS, not lucide component references: this module is imported by the
// server-side `projectsService`, so it must not drag the icon component library
// into the service graph. The 6.8.4 picker owns the key→lucide-component map;
// here a key is just an opaque, validated token. The colour keys map 1:1 to the
// `--el-tint-*` element tokens (the swap layer), so the picker renders a swatch
// as `bg-(--el-tint-<key>)` with no extra indirection.

/**
 * The preset project-icon keys. Curated lucide icon names (kebab-case) covering
 * the common project-archetype vocabulary; the 6.8.4 picker maps each to its
 * lucide component. Append-only is safe (existing rows keep resolving); removing
 * a key would orphan any project already using it, so treat this as additive.
 */
export const AVATAR_ICONS = [
  'folder',
  'rocket',
  'layers',
  'box',
  'compass',
  'flag',
  'star',
  'target',
  'zap',
  'bug',
  'code',
  'sparkles',
  'hexagon',
  'briefcase',
  'beaker',
  'palette',
  'globe',
  'bookmark',
] as const;

export type AvatarIcon = (typeof AVATAR_ICONS)[number];

/**
 * The colour-swatch keys, aligned 1:1 to the `--el-tint-*` element tokens (the
 * pastel-tint palette in globals.css). The picker renders each as a
 * `bg-(--el-tint-<key>)` swatch — colour stays routed through the swap layer,
 * never a raw `--color-*`.
 */
export const AVATAR_COLORS = ['peach', 'rose', 'mint', 'lavender', 'sky', 'yellow'] as const;

export type AvatarColor = (typeof AVATAR_COLORS)[number];

const ICON_SET: ReadonlySet<string> = new Set(AVATAR_ICONS);
const COLOR_SET: ReadonlySet<string> = new Set(AVATAR_COLORS);

/** Type guard: is `value` a legal preset icon key? */
export function isValidAvatarIcon(value: string): value is AvatarIcon {
  return ICON_SET.has(value);
}

/** Type guard: is `value` a legal colour-swatch key? */
export function isValidAvatarColor(value: string): value is AvatarColor {
  return COLOR_SET.has(value);
}
