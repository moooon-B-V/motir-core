// Typed errors the pre-plan SERVICE raises (distinct from the motir-ai client
// BOUNDARY errors in `errors.ts`): these are motir-core domain-validation
// failures the route maps to a 4xx, never an upstream/transport condition.

// The user picked a design axis whose id is not in the motir-core registry
// (`isStyleId` / `isPaletteId` / `isTypeId`). motir-core owns the registries and
// rejects an unknown id BEFORE writing to motir-ai (which stores the choice
// opaquely) — so a bad id is the caller's bug, mapped to 422 by the route.
export class InvalidDesignChoiceError extends Error {
  readonly code = 'INVALID_DESIGN_CHOICE' as const;
  constructor(
    readonly axis: 'styleId' | 'paletteId' | 'typeId',
    readonly value: unknown,
  ) {
    super(`invalid design ${axis}: ${JSON.stringify(value)}`);
    this.name = 'InvalidDesignChoiceError';
  }
}
