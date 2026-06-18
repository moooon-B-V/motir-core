// Typed errors for the appearance-preference domain (Story 7.3 · Subtask
// 7.3.60). Prisma-free (the `lib/notifications/preferenceErrors` /
// `lib/savedFilters/errors` pattern) so routes and client code can import them.
// The route translates the stable `code` to an HTTP status via
// `lib/appearance/errorResponse.ts`:
//
//   InvalidAppearanceValueError → 422 (an incoming axis value that is not a
//     registered id / a valid pattern — a rejection of stale client state, not
//     a server fault; the resolver/registry is the source of truth)

/** The four axes of the three-axis design system, plus the light/dark pattern. */
export type AppearanceAxis = 'pattern' | 'styleId' | 'paletteId' | 'typeId';

export class InvalidAppearanceValueError extends Error {
  readonly code = 'INVALID_APPEARANCE_VALUE' as const;
  constructor(
    readonly axis: AppearanceAxis,
    readonly value: unknown,
  ) {
    super(`Invalid value ${JSON.stringify(value)} for appearance axis "${axis}".`);
    this.name = 'InvalidAppearanceValueError';
  }
}
