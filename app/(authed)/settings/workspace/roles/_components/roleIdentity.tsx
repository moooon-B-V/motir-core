import { Eye, KeyRound, Shield, Users } from 'lucide-react';
import type { WorkspaceRole } from '@/generated/prisma/client';
import type { RoleDTO } from '@/lib/dto/permissions';

// The ONE place the widened `RoleDTO`'s built-in-vs-custom split is resolved
// (Story MOTIR-2257 · Subtask MOTIR-2478). Both screens render a role's glyph,
// its name and its description; without this they would each carry the same
// three ternaries, and the day a third surface renders a role there would be a
// third copy to keep in step.
//
// ⚠️ `ROLE_ICON` IS INDEXED WITH `builtInRole`, NEVER WITH `key`. `key` is the
// URL segment — an enum value for a built-in and a cuid for a custom role — so
// indexing a `Record<WorkspaceRole, …>` with it is exactly the totality hole the
// DTO widening was shaped to close. A custom role has NO enum value, so it takes
// the `key-round` glyph the design gives its tile (panel 2 of
// `design/workspaces/workspace-roles.mock.html`).

/**
 * The tile glyph per built-in WORKSPACE role — shield / users / eye, the glyphs
 * the project built-ins had, moved up a tier with their meaning (design
 * `workspace-roles.mock.html` panel 2).
 */
const ROLE_ICON: Record<WorkspaceRole, typeof Shield> = {
  manager: Shield,
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
    : /* a custom role's tile, from panel 2 of the workspace mock */ KeyRound;
  return <Icon className={className} aria-hidden="true" />;
}

/**
 * The tile's tint: each built-in on its member-role hue (Manager lavender, Member
 * sky, Viewer mint) and a custom role on `--el-role-custom` (peach) — the hues
 * the Members page's pills use, so a role reads the same on both screens
 * (workspace mock panel 2). The kind is stated in words beside it (`Built-in` /
 * `Custom`), so nothing rests on the hue alone.
 */
const ROLE_TINT: Record<WorkspaceRole, string> = {
  manager: 'bg-(--el-role-admin)',
  member: 'bg-(--el-role-member)',
  viewer: 'bg-(--el-role-viewer)',
};

export function roleTileTint(role: RoleDTO): string {
  return `${role.builtInRole ? ROLE_TINT[role.builtInRole] : 'bg-(--el-role-custom)'} text-(--el-text-strong)`;
}

/**
 * A role's DISPLAY NAME. A built-in's copy stays translatable; a custom role's
 * name is text its author typed and must never be run through a translation
 * lookup — `t()` on it would either miss and echo the key or, worse, hit an
 * unrelated message.
 */
export function roleName(role: RoleDTO, t: (key: string) => string): string {
  // ⚠️ THE `?? ''` IS A TYPE OBLIGATION, NOT A CASE. Exactly one of `labelKey` /
  // `name` is non-null on a `RoleDTO`, so reaching the fallback would mean a role
  // with neither — which the mapper cannot produce. Marked rather than tested: a
  // test asserting `''` for an input the DTO forbids would document a case that
  // does not exist.
  /* istanbul ignore next -- unreachable: a role without a labelKey has a name */
  return role.labelKey ? t(role.labelKey) : (role.name ?? '');
}

/** A role's description, under the same rule. Empty when a custom role has none. */
export function roleDescription(role: RoleDTO, t: (key: string) => string): string {
  return role.descriptionKey ? t(role.descriptionKey) : (role.description ?? '');
}
