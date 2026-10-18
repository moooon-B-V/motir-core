'use client';

import { createContext, useContext, type ReactNode } from 'react';

// WHICH BODIES' ITEM-LINK CHIPS FOLLOW THE SURFACE (Story MOTIR-7738 · MOTIR-8834).
// A `motir:` chip draws the referenced item's CURRENT title. Inside a body the
// item-scope host shows translated (a description, an explanation, a to-do's
// notes) that title follows the host's language; inside a body that is shown as
// stored (a comment, a page) it stays as stored. The distinction is made HERE, by
// the body's own wrapper, rather than by where the chip happens to sit on the
// page, because a comment and a translated description share the same page and the
// same provider.

const ChipTitleScopeContext = createContext(false);

/** Wraps a body whose chips draw their referenced titles in the reader's language. */
export function ChipTitleScope({ children }: { children: ReactNode }) {
  return <ChipTitleScopeContext.Provider value>{children}</ChipTitleScopeContext.Provider>;
}

export function useChipTitleScope(): boolean {
  return useContext(ChipTitleScopeContext);
}
