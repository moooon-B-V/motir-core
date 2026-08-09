import { Eye, Shield, UserRound, Users } from 'lucide-react';
import type { RoleDTO } from '@/lib/dto/permissions';
import type { ProjectRole } from '@/lib/projects/roles';

// The ONE place the widened `RoleDTO`'s built-in-vs-custom split is resolved
// (Story MOTIR-2257 · Subtask MOTIR-2478). Both screens render a role's glyph,
// its name and its description; without this they would each carry the same
// three ternaries, and the day a third surface renders a role there would be a
// third copy to keep in step.
//
// ⚠️ `ROLE_ICON` IS INDEXED WITH `builtInRole`, NEVER WITH `key`. `key` is the
// URL segment — an enum value for a built-in and a cuid for a custom role — so
// indexing a `Record<ProjectRole, …>` with it is exactly the totality hole the
// DTO widening was shaped to close. A custom role has NO enum value, so it takes
// the `user-round` glyph the design gives its tile (panel 0 of
// `design/projects/roles-permissions.mock.html`) rather than a fresh choice.

/** The tile glyph per built-in role — the mock's shield / users / eye. */
const ROLE_ICON: Record<ProjectRole, typeof Shield> = {
  admin: Shield,
  member: Users,
  viewer: Eye,
};

/**
 * The glyph a role's tile draws, as a COMPONENT rather than a function that
 * returns one. A `const Glyph = roleGlyph(role)` in a render body reads to
 * `react-hooks/static-components` as a component created during render (it
 * cannot see that the return is a stable module-level reference), and that rule
 * is right to be strict — so the lookup lives inside a component instead.
 */
export function RoleGlyph({ role, className }: { role: RoleDTO; className?: string }) {
  const Icon = role.builtInRole
    ? ROLE_ICON[role.builtInRole]
    : /* a custom role's tile, from panel 0 of the mock */ UserRound;
  return <Icon className={className} aria-hidden="true" />;
}

/**
 * The tile's tint. A BUILT-IN takes `--el-tint-lavender` and a CUSTOM role
 * `--el-tint-sky` — the pairing `design/projects/roles-permissions.mock.html`
 * fixes, and the one place on this surface where the tint carries KIND (the
 * `Built-in` / `Custom` chip states it in words beside it, so nothing rests on
 * the hue alone).
 */
export function roleTileTint(role: RoleDTO): string {
  return role.builtIn
    ? 'bg-(--el-tint-lavender) text-(--el-text-strong)'
    : 'bg-(--el-tint-sky) text-(--el-text-strong)';
}

/**
 * A role's DISPLAY NAME. A built-in's copy stays translatable; a custom role's
 * name is text its author typed and must never be run through a translation
 * lookup — `t()` on it would either miss and echo the key or, worse, hit an
 * unrelated message.
 */
export function roleName(role: RoleDTO, t: (key: string) => string): string {
  return role.labelKey ? t(role.labelKey) : (role.name ?? '');
}

/** A role's description, under the same rule. Empty when a custom role has none. */
export function roleDescription(role: RoleDTO, t: (key: string) => string): string {
  return role.descriptionKey ? t(role.descriptionKey) : (role.description ?? '');
}
