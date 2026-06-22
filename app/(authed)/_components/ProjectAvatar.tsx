import type { CSSProperties } from 'react';
import {
  Beaker,
  Bookmark,
  Box,
  Briefcase,
  Bug,
  Code,
  Compass,
  Flag,
  Folder,
  Globe,
  Hexagon,
  Layers,
  type LucideIcon,
  Palette,
  Rocket,
  Sparkles,
  Star,
  Target,
  Zap,
} from 'lucide-react';
import {
  type AvatarColor,
  type AvatarIcon,
  isValidAvatarColor,
  isValidAvatarIcon,
} from '@/lib/projects/avatar';
import { cn } from '@/lib/utils/cn';

// The project avatar chip (Story 6.8 · Subtask 6.8.4). A preset icon over its
// colour tint, OR — when the project has no avatar — the shipped MONO rendering
// (the project's key letters on the `--el-avatar-fallback` tile). Rendered everywhere
// a project identity appears: the Details page, the project switcher (closed
// trigger + open list), and the settings-area rail header — per
// `design/projects/details.mock.html` (the `.pav` chip).
//
// THIS module owns the icon-KEY → lucide-component map (the design-notes
// contract: "6.8.4 owns the key → lucide-component map; the service must not
// import lucide-react"). `lib/projects/avatar.ts` keeps the keys as opaque,
// validated STRINGS so the server-side `projectsService` never drags the icon
// library into its module graph — the same UI-free split `issueTypes.ts` →
// `parentRules.ts` uses.

const ICON_COMPONENTS: Record<AvatarIcon, LucideIcon> = {
  folder: Folder,
  rocket: Rocket,
  layers: Layers,
  box: Box,
  compass: Compass,
  flag: Flag,
  star: Star,
  target: Target,
  zap: Zap,
  bug: Bug,
  code: Code,
  sparkles: Sparkles,
  hexagon: Hexagon,
  briefcase: Briefcase,
  beaker: Beaker,
  palette: Palette,
  globe: Globe,
  bookmark: Bookmark,
};

// Literal class strings (not interpolated) so Tailwind's source scanner emits
// each background. Routed through the DEDICATED `--el-avatar-*` ramp (MOTIR-1274
// · 1266.3) — the KEY NAMES stay (peach…yellow): lib/projects/avatar.ts persists
// `project.avatarColor` ∈ these strings, so renaming the keys would break stored
// rows (spec §7.1). Each `--el-avatar-*` defaults to its prior `--el-tint-*`
// value → zero visual change. Colour stays on the swap layer — never a raw
// `--color-*` (the design-token rule).
const COLOR_BG: Record<AvatarColor, string> = {
  peach: 'bg-(--el-avatar-peach)',
  rose: 'bg-(--el-avatar-rose)',
  mint: 'bg-(--el-avatar-mint)',
  lavender: 'bg-(--el-avatar-lavender)',
  sky: 'bg-(--el-avatar-sky)',
  yellow: 'bg-(--el-avatar-yellow)',
};

export interface ProjectAvatarProps {
  /** Preset icon key (`lib/projects/avatar.ts`) or null = the mono fallback. */
  icon: string | null;
  /** Colour-swatch key or null = the mono fallback. */
  color: string | null;
  /** The project identifier — the mono fallback shows its first two letters. */
  identifier: string;
  /** Box edge in px. Default 30 (the switcher-trigger / rail size). */
  size?: number;
  className?: string;
}

/** The mono fallback shows the key's first two letters (the design's "key letters"). */
function keyLetters(identifier: string): string {
  return identifier.trim().slice(0, 2).toUpperCase() || '?';
}

export function ProjectAvatar({
  icon,
  color,
  identifier,
  size = 30,
  className,
}: ProjectAvatarProps) {
  // Both an icon AND a colour are required to render the preset chip; either
  // missing falls back to mono (null = the zero-config default).
  const hasPreset =
    icon !== null && color !== null && isValidAvatarIcon(icon) && isValidAvatarColor(color);
  // ≥44px is the large details-card chip → card radius; smaller chips use the
  // small-affordance control radius (both flip with `data-style`).
  const radius = size >= 44 ? 'rounded-(--radius-card)' : 'rounded-(--radius-control)';
  const boxStyle: CSSProperties = { width: size, height: size };

  if (!hasPreset) {
    return (
      <span
        aria-hidden
        style={{ ...boxStyle, fontSize: Math.round(size * 0.4) }}
        // White key-letters on the mono-fallback fill (the mock's `#fff`). The
        // fill is the DEDICATED `--el-avatar-fallback` (MOTIR-1274 · 1266.3),
        // which defaults to `--color-info` (the same blue the tile used to borrow
        // from `--el-type-task`) — decouples avatar identity from work-item-KIND
        // hue (misuse #2), zero visual change. NOT `--el-text-inverted`: that
        // flips to the dark page bg in dark mode, which fails AA on the blue tile
        // (4.19:1). `--el-accent-text` is #ffffff in BOTH themes → 4.57:1, AA-safe.
        className={cn(
          'inline-flex flex-none items-center justify-center bg-(--el-avatar-fallback) font-sans font-bold text-(--el-accent-text)',
          radius,
          className,
        )}
      >
        {keyLetters(identifier)}
      </span>
    );
  }

  const Icon = ICON_COMPONENTS[icon as AvatarIcon];
  return (
    <span
      aria-hidden
      style={boxStyle}
      className={cn(
        'inline-flex flex-none items-center justify-center text-(--el-text-strong)',
        radius,
        COLOR_BG[color as AvatarColor],
        className,
      )}
    >
      <Icon
        style={{ width: Math.round(size * 0.57), height: Math.round(size * 0.57) }}
        aria-hidden
      />
    </span>
  );
}
