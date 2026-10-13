'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { TranslationOfferDTO } from '@/lib/dto/workItemTranslation';

// THE ITEM PAGE'S TRANSLATION OFFER (Story MOTIR-7735 · Subtask MOTIR-8121).
//
// The server computes, per request and for the reader's interface language,
// which fields differ from that language and which already have a kept
// translation (`workItemTranslationReadService.getTranslationOffer`). This hands
// that DTO to the client islands of the item view. It draws NOTHING: the
// Translate control and the per-field marks are the item page card's
// (MOTIR-8122), and they read the offer through `useItemTranslationOffer`.
//
// `null` means NO OFFER — the public project host (a Visitor reads customers'
// text as written) and a reader whose offer read failed both get it, and both
// render exactly as before.

const ItemTranslationOfferContext = createContext<TranslationOfferDTO | null>(null);

export function ItemTranslationOfferProvider({
  offer,
  children,
}: {
  offer: TranslationOfferDTO | null;
  children: ReactNode;
}) {
  return (
    <ItemTranslationOfferContext.Provider value={offer}>
      {children}
    </ItemTranslationOfferContext.Provider>
  );
}

/** The reader's translation offer, or `null` where none was computed. */
export function useItemTranslationOffer(): TranslationOfferDTO | null {
  return useContext(ItemTranslationOfferContext);
}
