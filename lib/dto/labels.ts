/**
 * Label DTOs (Story 5.4 · Subtask 5.4.2) — the wire shape of the
 * project-scoped label folksonomy. A label is a name with an identity: `name`
 * carries the FIRST-TYPED display casing (the case-insensitive uniqueness key
 * lives server-side as `nameLower` and never crosses the API boundary); `id`
 * is what the chip's remove action targets. Deliberately minimal — labels
 * have no colour column (the chip tint is derived client-side from the name,
 * PR #578's deterministic-hash decision) and no metadata beyond the name.
 */
export interface LabelDto {
  id: string;
  name: string;
}
